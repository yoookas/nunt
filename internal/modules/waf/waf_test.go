package waf

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func testDeps(t *testing.T, waf model.WAFConfig) *module.Deps {
	t.Helper()
	dir := t.TempDir()
	store, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("config load: %v", err)
	}
	if err := store.Update(func(c *model.Config) error {
		c.WAF = waf
		return nil
	}); err != nil {
		t.Fatalf("config update: %v", err)
	}
	return &module.Deps{
		Cfg:     store,
		Log:     logging.New("error", ""),
		DataDir: dir,
	}
}

func newTestModule(t *testing.T, cfg model.WAFConfig) *WAF {
	t.Helper()
	m := New(testDeps(t, cfg))
	if err := m.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = m.Stop(context.Background()) })
	return m
}

func baseConfig() model.WAFConfig {
	return model.WAFConfig{
		Enable:            true,
		Mode:              model.WAFModeBlock,
		UseCRS:            true,
		ParanoiaLevel:     1,
		ExecutingLevel:    1,
		InboundThreshold:  5,
		OutboundThreshold: 4,
		BodyLimitKB:       128,
	}
}

func okHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Downstream", "yes")
		_, _ = io.WriteString(w, body)
	})
}

// echoBodyHandler copies the request body back so tests can prove the WAF did
// not swallow it.
func echoBodyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		_, _ = w.Write(data)
	})
}

func do(m *WAF, rule string, next http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	m.Middleware(rule, next).ServeHTTP(rec, r)
	return rec
}

func newRequest(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, target, reader)
	r.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) nunt-test")
	r.Header.Set("Accept", "text/html,application/xhtml+xml")
	if body != "" {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	return r
}

func newMux(t *testing.T, m *WAF) *rest.Mux {
	t.Helper()
	mux := rest.NewMux(slog.New(slog.NewTextHandler(io.Discard, nil)))
	m.RegisterAPI(mux)
	return mux
}

func apiDo(t *testing.T, mux *rest.Mux, method, target string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		body = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, target, body)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------------------
// configuration validation
// ---------------------------------------------------------------------------

func TestValidDisabledRule(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "plain id", in: "942100", want: true},
		{name: "id range", in: "930000-939999", want: true},
		{name: "padded id", in: "0", want: true},
		{name: "empty", in: "", want: false},
		{name: "directive injection", in: "1; SecRuleEngine Off", want: false},
		{name: "newline injection", in: "1\x0aSecRuleEngine Off", want: false},
		{name: "quoted include", in: "900000, phase:1", want: false},
		{name: "letters", in: "abc", want: false},
		{name: "negative", in: "-1", want: false},
		{name: "open range", in: "1-", want: false},
		{name: "double range", in: "1-2-3", want: false},
		{name: "too long", in: strings.Repeat("9", 25), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validDisabledRule(tc.in); got != tc.want {
				t.Fatalf("validDisabledRule(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestBuildEngineRejectsDirectiveInjection(t *testing.T) {
	cfg := baseConfig()
	cfg.DisabledRules = []string{"1; SecRuleEngine Off"}
	if _, err := buildEngine(cfg, nil); err == nil {
		t.Fatal("expected the engine build to reject the injected directive")
	}
}

func TestBuildEngineRejectsBadRuleFile(t *testing.T) {
	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.RuleFiles = []string{"rules.txt"}
	if _, err := buildEngine(cfg, nil); err == nil {
		t.Fatal("expected a non .conf rule file to be rejected")
	}
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

func TestBuildEngineCustomRulesOnly(t *testing.T) {
	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.ExtraRules = `SecRule REQUEST_URI "@rx ^/blocked" "id:9001001,phase:1,deny,status:403,log,msg:'custom block'"`
	eng, err := buildEngine(cfg, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	defer func() { _ = eng.close() }()
	if eng.rules < 1 {
		t.Fatalf("expected at least one rule, got %d", eng.rules)
	}

	hits, err := eng.process(context.Background(), &requestMeta{
		ClientIP: "10.0.0.1", Method: "GET", URI: "/blocked", Proto: "HTTP/1.1", Host: "example.test",
		Headers: http.Header{},
	})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if !hits.Blocked || hits.RuleID != 9001001 {
		t.Fatalf("expected rule 9001001 to block, got %+v", hits)
	}

	pass, err := eng.process(context.Background(), &requestMeta{
		ClientIP: "10.0.0.1", Method: "GET", URI: "/open", Proto: "HTTP/1.1", Host: "example.test",
		Headers: http.Header{},
	})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if pass.Blocked {
		t.Fatalf("a clean request must not be blocked, got %+v", pass)
	}
}

func TestDisabledRuleRangeIsHonoured(t *testing.T) {
	catalog, _, err := builtinRuleFiles()
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	var xss ruleFile
	for _, f := range catalog {
		if strings.Contains(f.Name, "941") {
			xss = f
		}
	}
	if xss.File == "" {
		t.Fatal("the XSS rule file is missing from the catalog")
	}
	cfg := baseConfig()
	cfg.DisabledRules = []string{"941000-941999"}
	if !disabledByRange(cfg.DisabledRules, xss) {
		t.Fatalf("expected %s to be disabled by the range", xss.File)
	}
	eng, err := buildEngine(cfg, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	defer func() { _ = eng.close() }()
	if eng.files == 0 {
		t.Fatal("expected the bundled rule files to be counted")
	}
}

func TestRulesFSNormalisesPaths(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "windows separator", in: "@owasp_crs\\REQUEST-901-INITIALIZATION.conf", want: "@owasp_crs/REQUEST-901-INITIALIZATION.conf"},
		{name: "leading dot", in: "./@owasp_crs/x.conf", want: "@owasp_crs/x.conf"},
		{name: "plain", in: "@owasp_crs/x.conf", want: "@owasp_crs/x.conf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := crsPath(tc.in); got != tc.want {
				t.Fatalf("crsPath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
	if _, err := (rulesFS{}).ReadFile("@owasp_crs\\REQUEST-901-INITIALIZATION.conf"); err != nil {
		t.Fatalf("reading a CRS file through a windows path failed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

func TestMiddlewareBlocksCommonAttacks(t *testing.T) {
	m := newTestModule(t, baseConfig())
	if !m.Enabled() {
		t.Fatal("the engine must be enabled")
	}
	cases := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{name: "traversal", method: http.MethodGet, target: "/?test=../../../../etc/passwd"},
		{name: "xss", method: http.MethodGet, target: "/?q=%3Cscript%3Ealert(1)%3C/script%3E"},
		{name: "sqli body", method: http.MethodPost, target: "/login", body: "user=admin&pass=1%27%20OR%20%271%27%3D%271"},
		{name: "rce", method: http.MethodGet, target: "/?cmd=%3Bcat%20/etc/passwd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(m, "site-a", okHandler("upstream"), newRequest(t, tc.method, tc.target, tc.body))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("expected 403 for %s, got %d (%s)", tc.target, rec.Code, rec.Body.String())
			}
			if rec.Header().Get("X-Downstream") != "" {
				t.Fatal("the upstream handler must not run for a blocked request")
			}
			if strings.Contains(rec.Body.String(), tc.target) {
				t.Fatal("the block page must not echo the request")
			}
		})
	}
}

func TestMiddlewarePassesCleanTraffic(t *testing.T) {
	m := newTestModule(t, baseConfig())
	cases := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{name: "root", method: http.MethodGet, target: "/"},
		{name: "page", method: http.MethodGet, target: "/index.html?lang=zh-CN&page=2"},
		{name: "api", method: http.MethodGet, target: "/api/v1/items?limit=20&sort=name"},
		{name: "form", method: http.MethodPost, target: "/login", body: "user=nunt&pass=correct-horse-battery-staple"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(m, "site-a", okHandler("upstream"), newRequest(t, tc.method, tc.target, tc.body))
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200 for %s, got %d (%s)", tc.target, rec.Code, rec.Body.String())
			}
			if rec.Body.String() != "upstream" {
				t.Fatalf("the upstream response was not forwarded: %q", rec.Body.String())
			}
		})
	}
	stats := m.Stats()
	if stats["blocked"].(int64) != 0 {
		t.Fatalf("no request should have been blocked: %v", stats["blocked"])
	}
	if stats["passed"].(int64) != 4 {
		t.Fatalf("expected 4 passed requests, got %v", stats["passed"])
	}
}

func TestMiddlewareRestoresRequestBody(t *testing.T) {
	m := newTestModule(t, baseConfig())
	body := "field=value&other=1234"
	rec := do(m, "site-a", echoBodyHandler(), newRequest(t, http.MethodPost, "/submit", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != body {
		t.Fatalf("the request body was not restored: got %q want %q", rec.Body.String(), body)
	}
}

func TestMiddlewareDetectModeDoesNotBlock(t *testing.T) {
	cfg := baseConfig()
	cfg.Mode = model.WAFModeDetect
	m := newTestModule(t, cfg)

	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("detect mode must not block, got %d", rec.Code)
	}
	stats := m.Stats()
	if stats["blocked"].(int64) != 0 {
		t.Fatalf("detect mode must not count blocked requests: %v", stats["blocked"])
	}
	if stats["detected"].(int64) == 0 {
		t.Fatal("detect mode must record the detection")
	}
	events := m.rec.list(10)
	if len(events) == 0 {
		t.Fatal("expected at least one event")
	}
	if events[0].Action != "detect" {
		t.Fatalf("expected a detect event, got %q", events[0].Action)
	}
	if events[0].Rule == "" || events[0].Method != http.MethodGet {
		t.Fatalf("the event lacks request context: %+v", events[0])
	}
}

func TestMiddlewareLogOnlyKeepsTraffic(t *testing.T) {
	cfg := baseConfig()
	cfg.LogOnly = true
	m := newTestModule(t, cfg)

	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK || rec.Body.String() != "upstream" {
		t.Fatalf("log only mode must forward the request, got %d %q", rec.Code, rec.Body.String())
	}
	stats := m.Stats()
	if stats["blocked"].(int64) != 0 || stats["detected"].(int64) == 0 {
		t.Fatalf("log only mode must count detections, got %v/%v", stats["blocked"], stats["detected"])
	}
}

func TestMiddlewareDisabledEnginePassesThrough(t *testing.T) {
	cfg := baseConfig()
	cfg.Enable = false
	m := newTestModule(t, cfg)
	if m.Enabled() {
		t.Fatal("a disabled engine must report Enabled() == false")
	}
	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("traffic must pass when the engine is disabled, got %d", rec.Code)
	}
}

func TestStartStopAreIdempotent(t *testing.T) {
	m := New(testDeps(t, baseConfig()))
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("first start: %v", err)
	}
	if err := m.Start(ctx); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if !m.Enabled() {
		t.Fatal("the engine must be enabled after start")
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("first stop: %v", err)
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("second stop: %v", err)
	}
	if m.Enabled() {
		t.Fatal("the engine must be disabled after stop")
	}
	if err := m.Start(ctx); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !m.Enabled() {
		t.Fatal("the engine must be enabled after a restart")
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("final stop: %v", err)
	}
}

func TestReloadSwapsTheEngine(t *testing.T) {
	deps := testDeps(t, baseConfig())
	m := New(deps)
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = m.Stop(ctx) }()

	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.WAF.Mode = model.WAFModeDetect
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	m.Reload(deps.Cfg.Snapshot())

	deadline := time.Now().Add(15 * time.Second)
	for {
		mode, _ := m.Stats()["mode"].(string)
		if mode == model.WAFModeDetect {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the reload did not reach the engine")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !m.Enabled() {
		t.Fatal("the engine must stay enabled after a reload")
	}
	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("the reloaded detect mode must not block, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

func TestAPIGetAndPutConfig(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/config", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /config = %d (%s)", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["config"] == nil || got["engine"] == nil || got["stats"] == nil {
		t.Fatalf("unexpected payload: %v", got)
	}

	cfg := baseConfig()
	cfg.ParanoiaLevel = 2
	cfg.ExecutingLevel = 2
	rec = apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /config = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := m.Config().ParanoiaLevel; got != 2 {
		t.Fatalf("the configuration was not stored: PL=%d", got)
	}
	if !strings.Contains(m.Status().Detail, "PL2") {
		t.Fatalf("the engine was not rebuilt: %q", m.Status().Detail)
	}
}

func TestAPIPutConfigRejectsInjection(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	cfg := baseConfig()
	cfg.DisabledRules = []string{"1; SecRuleEngine Off"}
	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for the injected directive, got %d (%s)", rec.Code, rec.Body.String())
	}
	if m.Config().Mode != model.WAFModeBlock {
		t.Fatal("the stored configuration must not change")
	}
	// The engine must still protect traffic.
	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the engine must keep blocking, got %d", blocked.Code)
	}
}

func TestAPIRulesListsBundledFiles(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/rules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /rules = %d (%s)", rec.Code, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			File         string `json:"file"`
			Name         string `json:"name"`
			Title        string `json:"title"`
			Group        string `json:"group"`
			Enabled      bool   `json:"enabled"`
			Rules        int    `json:"rules"`
			DisableRange string `json:"disableRange"`
		} `json:"items"`
		CRSVersion string `json:"crsVersion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Items) < 20 {
		t.Fatalf("expected the bundled rule files, got %d entries", len(payload.Items))
	}
	if payload.CRSVersion == "" {
		t.Fatal("the CRS version must be reported")
	}
	var found bool
	for _, item := range payload.Items {
		if strings.Contains(item.File, "REQUEST-941") {
			found = true
			if item.Title == "" || item.Rules == 0 || item.DisableRange == "" {
				t.Fatalf("incomplete entry: %+v", item)
			}
			if !item.Enabled {
				t.Fatalf("the XSS file must be enabled: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("REQUEST-941 is missing from the rule list")
	}
}

func TestAPITestEndpoint(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET",
		"url":    "/?test=../../../../etc/passwd",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /test = %d (%s)", rec.Code, rec.Body.String())
	}
	var verdict struct {
		Blocked  bool `json:"blocked"`
		Enforced bool `json:"enforced"`
		Status   int  `json:"status"`
		RuleID   int  `json:"ruleId"`
		Matched  []struct {
			ID      int    `json:"id"`
			Message string `json:"message"`
		} `json:"matched"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &verdict); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if !verdict.Blocked || !verdict.Enforced {
		t.Fatalf("the attack must be reported as blocked: %s", rec.Body.String())
	}
	if verdict.Status != http.StatusForbidden || verdict.RuleID == 0 || len(verdict.Matched) == 0 {
		t.Fatalf("incomplete verdict: %s", rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET",
		"url":    "/index.html?page=2",
	})
	var clean map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &clean); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if clean["blocked"].(bool) {
		t.Fatalf("a clean request must not be blocked: %s", rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET\x0d\x0aX-Evil: 1",
		"url":    "/",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a malformed method, got %d (%s)", rec.Code, rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method":   "POST",
		"url":      "/login",
		"headers":  map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
		"body":     "user=admin&pass=1%27%20OR%20%271%27%3D%271",
		"clientIp": "203.0.113.9",
	})
	if !strings.Contains(rec.Body.String(), `"blocked":true`) {
		t.Fatalf("the sql injection in the body must be blocked: %s", rec.Body.String())
	}
}

func TestAPILogs(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?limit=10", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /logs = %d (%s)", rec.Code, rec.Body.String())
	}
	var payload struct {
		Items []Event `json:"items"`
		Count int     `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Count == 0 || len(payload.Items) == 0 {
		t.Fatalf("expected an event: %s", rec.Body.String())
	}
	ev := payload.Items[0]
	if ev.Action != "deny" || ev.RuleID == 0 || ev.Rule != "site-a" || ev.Status != http.StatusForbidden {
		t.Fatalf("unexpected event: %+v", ev)
	}
	if ev.ClientIP == "" || ev.Method != http.MethodGet || ev.URI == "" {
		t.Fatalf("the event lacks request context: %+v", ev)
	}

	if rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?limit=abc", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a bad limit, got %d", rec.Code)
	}
	if rec := apiDo(t, mux, http.MethodDelete, "/api/v1/waf/logs", nil); rec.Code != http.StatusOK {
		t.Fatalf("DELETE /logs = %d", rec.Code)
	}
	if got := m.rec.size(); got != 0 {
		t.Fatalf("the buffer was not cleared: %d", got)
	}
}

func TestAPIRequiresRulesPayloadShape(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", map[string]any{"unknownField": true})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unknown field, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := apiDo(t, mux, http.MethodPost, "/api/v1/waf/reload", nil); rec.Code != http.StatusOK {
		t.Fatalf("POST /reload = %d (%s)", rec.Code, rec.Body.String())
	}
}
func TestMiddlewareForwardsBodyLargerThanTheLimit(t *testing.T) {
	cfg := baseConfig()
	cfg.BodyLimitKB = 1
	m := newTestModule(t, cfg)

	body := strings.Repeat("field=value&", 700)
	rec := do(m, "site-a", echoBodyHandler(), newRequest(t, http.MethodPost, "/upload", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("a large but clean body must pass, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != body {
		t.Fatalf("the truncated body was not completed: got %d bytes want %d", rec.Body.Len(), len(body))
	}
}

func TestBrokenRuleSetDoesNotTakeTheServiceDown(t *testing.T) {
	cfg := baseConfig()
	cfg.ExtraRules = "SecRule THIS IS NOT SECLANG"
	deps := testDeps(t, cfg)
	m := New(deps)
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("start must not fail on a broken rule set: %v", err)
	}
	defer func() { _ = m.Stop(ctx) }()

	if m.Enabled() {
		t.Fatal("a broken rule set must leave the engine disabled")
	}
	if m.Status().Error == "" {
		t.Fatal("the build error must be reported in the status")
	}
	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("traffic must pass while the engine is disabled, got %d", rec.Code)
	}
}

func TestAPIPutConfigRollsBackOnBrokenRules(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	cfg := baseConfig()
	cfg.ExtraRules = "SecRule THIS IS NOT SECLANG"
	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an uncompilable rule set, got %d (%s)", rec.Code, rec.Body.String())
	}
	if m.Config().ExtraRules != "" {
		t.Fatalf("the previous configuration must be restored, got %q", m.Config().ExtraRules)
	}
	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the previous engine must keep protecting traffic, got %d", blocked.Code)
	}
}

func TestNormalizePathSlash(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		changed bool
	}{
		{name: "posix path untouched", in: "/etc/passwd", want: "/etc/passwd"},
		{name: "argument untouched", in: ";cat /etc/passwd", want: ";cat /etc/passwd"},
		{name: "dot segment", in: "/a/./b", want: "/a/b", changed: true},
		{name: "dot dot segment", in: "/a/../b", want: "/b", changed: true},
		{name: "double slash", in: "/a//b", want: "/a/b", changed: true},
		{name: "trailing slash kept", in: "/a/b/", want: "/a/b/"},
		{name: "empty", in: "", want: ""},
		{name: "dot only", in: ".", want: "", changed: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed, err := normalizePathSlash(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizePathSlash(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if changed != tc.changed {
				t.Fatalf("normalizePathSlash(%q) changed = %v, want %v", tc.in, changed, tc.changed)
			}
		})
	}
}

func TestStripWindowsSuffixes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "/etc/passwd", want: "/etc/passwd"},
		{name: "alternate data stream", in: "/uploads/shell.php::$DATA", want: "/uploads/shell.php"},
		{name: "trailing dot", in: "/uploads/shell.php.", want: "/uploads/shell.php"},
		{name: "trailing space", in: "/uploads/shell.php ", want: "/uploads/shell.php"},
		{name: "drive letter kept", in: "C:/windows", want: "C:/windows"},
		{name: "empty", in: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripWindowsSuffixes(tc.in); got != tc.want {
				t.Fatalf("stripWindowsSuffixes(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
func TestConcurrentTrafficDuringReload(t *testing.T) {
	deps := testDeps(t, baseConfig())
	m := New(deps)
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = m.Stop(ctx) }()

	handler := m.Middleware("site-a", okHandler("upstream"))
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodGet, "/index.html?page=2", nil)
				req.Header.Set("User-Agent", "Mozilla/5.0 nunt-test")
				req.Header.Set("Accept", "text/html")
				handler.ServeHTTP(rec, req)
				if rec.Code != http.StatusOK {
					t.Errorf("unexpected status %d", rec.Code)
					return
				}
			}
		}()
	}
	for i := 0; i < 3; i++ {
		logOnly := i%2 == 0
		if err := deps.Cfg.Update(func(c *model.Config) error {
			c.WAF.LogOnly = logOnly
			return nil
		}); err != nil {
			t.Fatalf("update: %v", err)
		}
		m.Reload(deps.Cfg.Snapshot())
		time.Sleep(250 * time.Millisecond)
	}
	close(stop)
	wg.Wait()
	if !m.Enabled() {
		t.Fatal("the engine must stay enabled")
	}
}
func TestRuleFilesOnDiskAreLoaded(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "custom.conf")
	content := "# \u81EA\u5B9A\u4E49\u62E6\u622A\u89C4\u5219\n" +
		"SecRule REQUEST_URI \"@rx ^/blocked\" \"id:9100001,phase:1,deny,status:403,log,msg:'custom file rule'\"\n"
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatalf("write rule file: %v", err)
	}

	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.RuleFiles = []string{file}
	m := newTestModule(t, cfg)

	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/blocked", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the disk rule must block, got %d (%s)", blocked.Code, blocked.Body.String())
	}
	if blocked.Body.String() == "" || strings.Contains(blocked.Body.String(), "/blocked") {
		t.Fatalf("unexpected block page: %q", blocked.Body.String())
	}
	passed := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/open", ""))
	if passed.Code != http.StatusOK {
		t.Fatalf("the disk rule must not block unrelated paths, got %d", passed.Code)
	}

	mux := newMux(t, m)
	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/rules", nil)
	var payload struct {
		Items []struct {
			File    string `json:"file"`
			Title   string `json:"title"`
			Builtin bool   `json:"builtin"`
			Enabled bool   `json:"enabled"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var item struct {
		File    string `json:"file"`
		Title   string `json:"title"`
		Builtin bool   `json:"builtin"`
		Enabled bool   `json:"enabled"`
	}
	found := false
	for _, entry := range payload.Items {
		if entry.File == file {
			item, found = entry, true
		}
	}
	if !found {
		t.Fatalf("the configured rule file is missing from the list")
	}
	if item.Builtin || !item.Enabled {
		t.Fatalf("unexpected entry: %+v", item)
	}
	if item.Title != "自定义拦截规则" {
		t.Fatalf("the title must come from the first comment, got %q", item.Title)
	}
}
func TestDirectiveStreamOrdering(t *testing.T) {
	cfg := baseConfig()
	cfg.DisabledRules = []string{"942100"}
	catalog, _, err := builtinRuleFiles()
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	b := renderDirectives(cfg, catalog)
	stream := b.String()

	prelude := strings.Index(stream, "SecAction \"id:1000001")
	include := strings.Index(stream, "Include "+crsRecommendedCfg)
	crsRules := strings.Index(stream, "Include "+crsRootDir+"/REQUEST-901")
	engine := strings.Index(stream, "SecRuleEngine On")
	limit := strings.Index(stream, "SecRequestBodyLimit 131072")
	if prelude < 0 || include < 0 || crsRules < 0 || engine < 0 || limit < 0 {
		t.Fatalf("the directive stream is incomplete: \n%s", stream)
	}
	if !(prelude < include && include < crsRules && crsRules < engine && engine < limit) {
		t.Fatalf("unexpected directive order: \n%s", stream)
	}
	if len(b.remove) != 1 || b.remove[0] != "SecRuleRemoveById 942100" {
		t.Fatalf("unexpected remove list: %v", b.remove)
	}
	if strings.Contains(stream, "SecRuleEngine DetectionOnly") {
		t.Fatalf("block mode must not emit DetectionOnly: \n%s", stream)
	}

	cfg.Mode = model.WAFModeDetect
	if b := renderDirectives(cfg, nil); !strings.Contains(b.String(), "SecRuleEngine DetectionOnly") {
		t.Fatalf("detect mode must emit DetectionOnly: \n%s", b.String())
	}
}

// brokenBody fails halfway through, which makes the engine fail to inspect the
// request. In enforce mode such a request must not reach the upstream as if it
// had been checked.
type brokenBody struct{ sent bool }

func (b *brokenBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		p[0] = 'a'
		return 1, nil
	}
	return 0, errors.New("client aborted the body")
}

func (b *brokenBody) Close() error { return nil }

func TestInspectionFailureIsClosedInEnforceMode(t *testing.T) {
	cfg := baseConfig()
	cfg.Mode = model.WAFModeBlock
	m := newTestModule(t, cfg)
	up := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("upstream"))
	})

	req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", &brokenBody{})
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.ContentLength = 64
	rec := httptest.NewRecorder()
	m.Middleware("rule", up).ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 when the body cannot be inspected", rec.Code)
	}
	if got := rec.Body.String(); strings.Contains(got, "upstream") {
		t.Fatalf("the request reached the upstream: %q", got)
	}
}

// A large inspection limit must not turn into an equally large per-request
// memory buffer: Coraza spills the excess to a temporary file.
func TestLargeBodyLimitUsesDiskSpool(t *testing.T) {
	cfg := baseConfig()
	cfg.BodyLimitKB = 20 * 1024 // 20 MiB
	stream := renderDirectives(cfg, nil).String()
	if !strings.Contains(stream, "SecRequestBodyLimit 20971520") {
		t.Fatalf("the inspection limit was not raised:\n%s", stream)
	}
	if !strings.Contains(stream, "SecRequestBodyInMemoryLimit 1048576") {
		t.Fatalf("the in-memory cap was not applied:\n%s", stream)
	}

	cfg.BodyLimitKB = 1024 * 1024 // 1 GiB, above the cap
	if got := normalizeWAFConfig(cfg).BodyLimitKB; got != 256*1024 {
		t.Fatalf("the limit was clamped to %d KB, want %d", got, 256*1024)
	}
}
