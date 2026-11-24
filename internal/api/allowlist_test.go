package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// Addresses used by the allow list tests: listedAddr sits inside 10.0.0.0/8,
// unlistedAddr uses the documentation range TEST-NET-1.
const (
	listedAddr   = "10.1.2.3:41234"
	unlistedAddr = "192.0.2.9:41234"
)

func loginBody() string {
	return fmt.Sprintf("{\"password\":%q}", testPassword)
}

// setAdminAccess writes the admin IP allow list through the configuration
// store, which is what refreshes the cached, parsed list.
func setAdminAccess(t *testing.T, env *testEnv, ips []string, trustProxy bool) {
	t.Helper()
	if err := env.store.Update(func(c *model.Config) error {
		c.System.AdminAllowIPs = ips
		c.System.TrustProxy = trustProxy
		return nil
	}); err != nil {
		t.Fatalf("update admin access settings: %v", err)
	}
}

// doFrom sends one request through the admin handler from a chosen peer
// address.
func doFrom(t *testing.T, env *testEnv, method, path, remoteAddr, body string,
	headers map[string]string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	req.RemoteAddr = remoteAddr
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	return rec
}

// mustDeny asserts that the allow list guard answered 403 with the Chinese
// explanation instead of reaching the route.
func mustDeny(t *testing.T, rec *httptest.ResponseRecorder, what string) {
	t.Helper()
	if rec.Code != http.StatusForbidden {
		t.Fatalf("%s must be rejected with 403 by the allow list, got %d %s", what, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "白名单") {
		t.Fatalf("%s must explain the allow list, got %s", what, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "\"code\":\"ip_not_allowed\"") {
		t.Fatalf("%s must carry the ip_not_allowed code, got %s", what, rec.Body.String())
	}
}

// mustPassGuard asserts that a request was not stopped by the allow list; the
// route itself may still answer 401 or 404.
func mustPassGuard(t *testing.T, rec *httptest.ResponseRecorder, what string) {
	t.Helper()
	if rec.Code == http.StatusForbidden && strings.Contains(rec.Body.String(), "白名单") {
		t.Fatalf("%s must not be blocked by the allow list, got %d %s", what, rec.Code, rec.Body.String())
	}
}

func hasLog(env *testEnv, level, substr string) bool {
	for _, e := range env.server.opts.Log.Recent(200) {
		if e.Level == level && strings.Contains(e.Msg, substr) {
			return true
		}
	}
	return false
}

func TestAdminAllowListEmptyAllowsEveryAddress(t *testing.T) {
	env := newTestEnv(t)

	// The default configuration has no allow list, so an arbitrary address
	// still reaches the health check, the UI, the API and the sign in route.
	if rec := doFrom(t, env, http.MethodGet, "/healthz", unlistedAddr, "", nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("healthz: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doFrom(t, env, http.MethodGet, "/", unlistedAddr, "", nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("the admin UI must be served, got %d", rec.Code)
	}
	if rec := doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("an anonymous API call must reach the auth middleware (401), got %d %s", rec.Code, rec.Body.String())
	}
	if rec := doFrom(t, env, http.MethodPost, "/api/v1/auth/login", unlistedAddr, loginBody(), nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("sign in without an allow list: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminAllowListAllowsListedAddress(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)

	rec := doFrom(t, env, http.MethodPost, "/api/v1/auth/login", listedAddr, loginBody(), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in from a listed address: %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()

	rec = doFrom(t, env, http.MethodGet, "/api/v1/system/info", listedAddr, "", nil, cookies)
	if rec.Code != http.StatusOK {
		t.Fatalf("API call from a listed address: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminAllowListRejectsUnlistedAddress(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)

	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/system/info", ""},
		{http.MethodGet, "/", ""},
		{http.MethodPost, "/api/v1/auth/login", loginBody()},
	}
	for _, tc := range cases {
		rec := doFrom(t, env, tc.method, tc.path, unlistedAddr, tc.body, nil, nil)
		mustDeny(t, rec, tc.method+" "+tc.path)
	}
}

func TestAdminAllowListHonoursCIDRAndBareIPs(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"192.168.1.0/24", "203.0.113.7"}, false)

	for _, addr := range []string{"192.168.1.1:5000", "192.168.1.50:5000", "203.0.113.7:5000"} {
		rec := doFrom(t, env, http.MethodGet, "/api/v1/system/info", addr, "", nil, nil)
		mustPassGuard(t, rec, addr+" (listed)")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s is listed and must reach the auth middleware, got %d %s", addr, rec.Code, rec.Body.String())
		}
	}
	for _, addr := range []string{"192.168.2.50:5000", "203.0.113.8:5000", "10.0.0.1:5000"} {
		mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", addr, "", nil, nil), addr)
	}
}

func TestAdminAllowListIgnoresInvalidEntries(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"", "10.0.0.0/8", "not-an-ip", "10.0.0.0/99"}, false)

	if rec := doFrom(t, env, http.MethodGet, "/api/v1/system/info", listedAddr, "", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("the valid entry must still match, got %d %s", rec.Code, rec.Body.String())
	}
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, nil), unlistedAddr)

	info := env.server.adminAllowListInfo()
	if info["entries"] != 3 || info["valid"] != 1 || info["failClosed"] != false {
		t.Fatalf("invalid entries must be skipped: %v", info)
	}
}

func TestAdminAllowListBlankEntriesMeanNoRestriction(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"", "   "}, false)

	rec := doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, nil)
	mustPassGuard(t, rec, "a blank list")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("blank entries must not restrict access, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminAllowListFailsClosedWhenNoEntryIsValid(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"oops", "10.0.0.0/99"}, false)

	// Even an address that matches the (mistyped) intent is refused.
	for _, addr := range []string{listedAddr, unlistedAddr} {
		mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", addr, "", nil, nil), addr)
	}

	info := env.server.adminAllowListInfo()
	if info["restricted"] != true || info["failClosed"] != true {
		t.Fatalf("an all-invalid list must fail closed: %v", info)
	}
	if !hasLog(env, "error", "白名单") {
		t.Fatal("failing closed must be reported as an error log entry")
	}
}

func TestAdminAllowListTrustProxySwitchesForwardedAndPeerAddress(t *testing.T) {
	env := newTestEnv(t)
	const peer = "198.51.100.7:5000"
	forwarded := map[string]string{"X-Forwarded-For": "203.0.113.9"}

	setAdminAccess(t, env, []string{"203.0.113.9"}, false)
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", peer, "", forwarded, nil),
		"X-Forwarded-For with an untrusted proxy")

	setAdminAccess(t, env, []string{"203.0.113.9"}, true)
	rec := doFrom(t, env, http.MethodGet, "/api/v1/system/info", peer, "", forwarded, nil)
	mustPassGuard(t, rec, "the forwarded address with a trusted proxy")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the forwarded address must be matched, got %d %s", rec.Code, rec.Body.String())
	}
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", peer, "",
		map[string]string{"X-Forwarded-For": "203.0.113.10"}, nil), "a forwarded address outside the list")

	// With a trusted proxy the peer address alone no longer matches.
	setAdminAccess(t, env, []string{"198.51.100.7"}, true)
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", peer, "", forwarded, nil),
		"the peer address with a trusted proxy")
}

func TestLoginIsCoveredByAdminAllowList(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)

	rec := doFrom(t, env, http.MethodPost, "/api/v1/auth/login", unlistedAddr, loginBody(), nil, nil)
	mustDeny(t, rec, "sign in from an unlisted address")
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("a rejected sign in must not issue a session cookie")
	}
	if strings.Contains(rec.Body.String(), "csrf") {
		t.Fatal("a rejected sign in must not return a csrf token")
	}

	rec = doFrom(t, env, http.MethodPost, "/api/v1/auth/login", listedAddr, loginBody(), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in from a listed address: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminAllowListRefreshesAfterConfigChange(t *testing.T) {
	env := newTestEnv(t)

	rec := doFrom(t, env, http.MethodPost, "/api/v1/auth/login", unlistedAddr, loginBody(), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in before the list exists: %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()

	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, cookies),
		"the cached list must follow the new configuration")

	setAdminAccess(t, env, nil, false)
	rec = doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, cookies)
	if rec.Code != http.StatusOK {
		t.Fatalf("clearing the list must restore access, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestHealthzIsExemptFromAdminAllowList(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)

	rec := doFrom(t, env, http.MethodGet, "/healthz", unlistedAddr, "", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("the container health check must stay reachable, got %d %s", rec.Code, rec.Body.String())
	}
	mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, nil), "the API")
}

func TestAdminAllowListCounterIsExposedInSystemInfo(t *testing.T) {
	env := newTestEnv(t)
	setAdminAccess(t, env, []string{"10.0.0.0/8"}, false)

	rec := doFrom(t, env, http.MethodPost, "/api/v1/auth/login", listedAddr, loginBody(), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in from a listed address: %d %s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()

	for i := 0; i < 3; i++ {
		mustDeny(t, doFrom(t, env, http.MethodGet, "/api/v1/system/info", unlistedAddr, "", nil, nil), "an unlisted address")
	}

	rec = doFrom(t, env, http.MethodGet, "/api/v1/system/info", listedAddr, "", nil, cookies)
	if rec.Code != http.StatusOK {
		t.Fatalf("system info: %d %s", rec.Code, rec.Body.String())
	}
	var info map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode system info: %v", err)
	}
	list, ok := info["adminAllowList"].(map[string]any)
	if !ok {
		t.Fatalf("system info must expose the allow list state: %s", rec.Body.String())
	}
	number := func(key string) float64 {
		v, _ := list[key].(float64)
		return v
	}
	if list["restricted"] != true || number("entries") != 1 || number("valid") != 1 {
		t.Fatalf("unexpected allow list state: %v", list)
	}
	if number("blocked") != 3 {
		t.Fatalf("three rejected requests must be counted, got %v", list["blocked"])
	}
}

func TestIPAllowListParsingAndMatching(t *testing.T) {
	cases := []struct {
		name       string
		entries    []string
		ip         string
		want       bool
		failClosed bool
		valid      int
		configured int
	}{
		{"empty list allows everything", nil, "192.0.2.9", true, false, 0, 0},
		{"blank entries allow everything", []string{"", "   "}, "192.0.2.9", true, false, 0, 0},
		{"listed address", []string{"10.0.0.0/8"}, "10.1.2.3", true, false, 1, 1},
		{"unlisted address", []string{"10.0.0.0/8"}, "192.0.2.9", false, false, 1, 1},
		{"bare ip", []string{"203.0.113.7"}, "203.0.113.7", true, false, 1, 1},
		{"single invalid entry fails closed", []string{"nope"}, "192.0.2.9", false, true, 0, 1},
		{"invalid entries are skipped", []string{"nope", "10.0.0.0/8"}, "10.1.2.3", true, false, 1, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			list := newIPAllowList(nil, model.SystemConfig{AdminAllowIPs: tc.entries})
			if list.failClosed != tc.failClosed || len(list.nets) != tc.valid ||
				list.entries != tc.configured || list.restricted() != (tc.configured > 0) {
				t.Fatalf("parse = failClosed:%v valid:%d entries:%d restricted:%v, want failClosed:%v valid:%d entries:%d",
					list.failClosed, len(list.nets), list.entries, list.restricted(), tc.failClosed, tc.valid, tc.configured)
			}
			if got := list.allow(net.ParseIP(tc.ip)); got != tc.want {
				t.Fatalf("allow(%s) = %v, want %v", tc.ip, got, tc.want)
			}
		})
	}

	list := newIPAllowList(nil, model.SystemConfig{AdminAllowIPs: []string{"10.0.0.0/8"}})
	if list.allow(nil) {
		t.Fatal("an unparsable client address must be refused while a list is configured")
	}
	// A missing cache must never lock the admin interface out.
	var missing *ipAllowList
	if missing.restricted() || !missing.allow(net.ParseIP("192.0.2.9")) {
		t.Fatal("a nil allow list must not restrict access")
	}
}
