package web

import (
	"context"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/testutil"
	"github.com/nunt/nunt/internal/vfs"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// path rewriting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// range requests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// static hosting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// access control & basic auth
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// reverse proxy
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// conditional requests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// module lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// access log
// ---------------------------------------------------------------------------

func mkRule(t *testing.T, name, host, path string, priority int, typ string) model.WebRule {
	t.Helper()
	r := model.WebRule{
		ID:         name,
		Name:       name,
		Enable:     true,
		Type:       typ,
		ListenerID: "l1",
		Path:       path,
		Priority:   priority,
	}
	if host != "" {
		r.Domains = []string{host}
	}
	if typ == model.WebTypeProxy {
		r.Proxy = &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}, Balance: "roundrobin"}
	}
	if typ == model.WebTypeRedirect {
		r.Redirect = &model.RedirectTgt{To: "https://elsewhere", Status: 302}
	}
	return r
}

func TestMatcherPrefersLongestPathAndPriority(t *testing.T) {
	root := mkRule(t, "root", "example.com", "/", 0, model.WebTypeRedirect)
	api := mkRule(t, "api", "example.com", "/api", 0, model.WebTypeRedirect)
	apiHigh := mkRule(t, "api-high", "example.com", "/api", 5, model.WebTypeRedirect)
	deep := mkRule(t, "deep", "example.com", "/api/v1", 0, model.WebTypeRedirect)
	other := mkRule(t, "other", "other.com", "/", 9, model.WebTypeRedirect)

	rules := make([]*rule, 0, 5)
	for i, raw := range []model.WebRule{root, api, apiHigh, deep, other} {
		compiled, err := compileRule(raw, i)
		if err != nil {
			t.Fatalf("compile %s: %v", raw.Name, err)
		}
		rules = append(rules, compiled)
	}
	m := newMatcher(":8080", rules, listenerTLS{})

	cases := []struct {
		host string
		path string
		want string
	}{
		{"example.com", "/", "root"},
		{"example.com", "/index.html", "root"},
		{"example.com", "/api", "api-high"},
		{"example.com", "/api/", "api-high"},
		{"example.com", "/api/users", "api-high"},
		{"example.com", "/api/v1/items", "deep"},
		{"example.com:8443", "/api", "api-high"},
		{"other.com", "/api", "other"},
		{"unknown.com", "/api", ""},
		{"example.com", "/apiary", "root"},
	}
	for _, c := range cases {
		got := m.Match(c.host, c.path)
		name := ""
		if got != nil {
			name = got.name
		}
		if name != c.want {
			t.Errorf("Match(%q, %q) = %q, want %q", c.host, c.path, name, c.want)
		}
	}
}

func TestMatchDomainWildcardAndPort(t *testing.T) {
	raw := mkRule(t, "wild", "*.example.com", "/", 0, model.WebTypeRedirect)
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	m := newMatcher(":8080", []*rule{compiled}, listenerTLS{})
	if m.Match("a.example.com", "/") == nil {
		t.Fatal("wildcard domain should match a sub domain")
	}
	if m.Match("example.com", "/") != nil {
		t.Fatal("wildcard domain must not match the bare domain")
	}
	if m.Match("a.example.com:1234", "/") == nil {
		t.Fatal("wildcard domain should match a host with a port")
	}
}

func TestCompileWebLinksRoutesToTheirListener(t *testing.T) {
	raw := mkRule(t, "root", "example.com", "/", 0, model.WebTypeRedirect)
	cfg := &model.Config{Web: model.WebConfig{
		Listeners: []model.WebListener{
			{ID: "l1", Name: "http", Listen: []string{"0.0.0.0:8080", ":8080"}},
			{ID: "l2", Name: "other", Listen: []string{"127.0.0.1:9090"}},
		},
		Rules: []model.WebRule{raw},
	}}
	w := &Web{deps: &module.Deps{}}
	compiled, plans, errs := w.compileWeb(cfg)
	if len(errs) != 0 {
		t.Fatalf("compileWeb: %v", errs)
	}
	if len(compiled) != 1 || len(plans["127.0.0.1:9090"].rules) != 0 {
		t.Fatalf("compiled=%d plans=%v", len(compiled), plans)
	}
	for addr, plan := range plans {
		if addr == "127.0.0.1:9090" {
			continue
		}
		if len(plan.rules) != 1 || plan.rules[0].listenerID != "l1" {
			t.Fatalf("plan %s has %d rules", addr, len(plan.rules))
		}
	}
}

func TestCompileRejectsInvalidRule(t *testing.T) {
	bad := mkRule(t, "bad", "example.com", "/", 0, model.WebTypeProxy)
	bad.Proxy.Targets = []string{"ftp://example.com"}
	if _, err := compileRule(bad, 0); err == nil {
		t.Fatal("an unsupported proxy scheme must be rejected")
	}
	bad = mkRule(t, "bad", "example.com", "/", 0, model.WebTypeProxy)
	bad.BasicAuth = &model.BasicAuth{Enable: true}
	if _, err := compileRule(bad, 0); err == nil {
		t.Fatal("basic auth without users must be rejected")
	}
}

func TestRewritePath(t *testing.T) {
	cases := []struct {
		path, prefix, replace, want string
	}{
		{"/app/users", "/app", "/backend", "/backend/users"},
		{"/app", "/app", "/backend", "/backend"},
		{"/app/", "/app", "/backend", "/backend/"},
		{"/other", "/app", "/backend", "/other"},
		{"/app/users", "/app", "", "/users"},
		{"/users", "", "/app", "/app/users"},
		{"/", "", "", "/"},
		{"/users", "", "", "/users"},
		{"/app", "/app", "/", "/"},
	}
	for _, c := range cases {
		if got := rewritePath(c.path, c.prefix, c.replace); got != c.want {
			t.Errorf("rewritePath(%q, %q, %q) = %q, want %q", c.path, c.prefix, c.replace, got, c.want)
		}
	}
}

func TestJoinURLPath(t *testing.T) {
	cases := []struct{ a, b, want string }{
		{"/backend", "users", "/backend/users"},
		{"/backend/", "/users", "/backend/users"},
		{"/", "/users", "/users"},
		{"", "/users", "/users"},
		{"/a", "", "/a"},
		{"", "", "/"},
	}
	for _, c := range cases {
		if got := joinURLPath(c.a, c.b); got != c.want {
			t.Errorf("joinURLPath(%q, %q) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestParseTarget(t *testing.T) {
	u, err := parseTarget("127.0.0.1:8080")
	if err != nil {
		t.Fatalf("parseTarget: %v", err)
	}
	if u.Scheme != "http" || u.Host != "127.0.0.1:8080" {
		t.Fatalf("unexpected target %s", u)
	}
	u, err = parseTarget("https://backend.local:8443/")
	if err != nil {
		t.Fatalf("parseTarget: %v", err)
	}
	if u.Scheme != "https" || u.Path != "" {
		t.Fatalf("unexpected target %s", u)
	}
	if _, err := parseTarget(""); err == nil {
		t.Fatal("an empty target must be rejected")
	}
	if _, err := parseTarget("ftp://host:21"); err == nil {
		t.Fatal("a non http target must be rejected")
	}
}

func TestBalancerStrategies(t *testing.T) {
	bal, err := newBalancer("roundrobin", []string{"127.0.0.1:9001", "127.0.0.1:9002"})
	if err != nil {
		t.Fatalf("newBalancer: %v", err)
	}
	first := bal.pick("10.0.0.1").target
	second := bal.pick("10.0.0.1").target
	if first == second {
		t.Fatalf("round robin returned %q twice", first)
	}
	if bal.pick("10.0.0.1").target != first {
		t.Fatal("round robin did not wrap around")
	}
	hash, err := newBalancer("iphash", []string{"127.0.0.1:9001", "127.0.0.1:9002"})
	if err != nil {
		t.Fatalf("newBalancer: %v", err)
	}
	a := hash.pick("10.0.0.7").target
	for i := 0; i < 5; i++ {
		if got := hash.pick("10.0.0.7").target; got != a {
			t.Fatalf("ip hash is not stable: %q != %q", got, a)
		}
	}
	if _, err := newBalancer("weighted", []string{"127.0.0.1:9001"}); err == nil {
		t.Fatal("an unknown balance strategy must be rejected")
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		header  string
		size    int64
		start   int64
		length  int64
		partial bool
		wantErr error
	}{
		{"", 100, 0, 100, false, nil},
		{"bytes=0-9", 100, 0, 10, true, nil},
		{"bytes=10-", 100, 10, 90, true, nil},
		{"bytes=-10", 100, 90, 10, true, nil},
		{"bytes=-500", 100, 0, 100, true, nil},
		{"bytes=90-200", 100, 90, 10, true, nil},
		{"bytes=100-", 100, 0, 0, false, errRangeNotSatisfiable},
		{"bytes=-0", 100, 0, 0, false, errRangeNotSatisfiable},
		{"bytes=5-1", 100, 0, 0, false, errInvalidRange},
		{"bytes=abc", 100, 0, 0, false, errInvalidRange},
		{"bytes=1-2,4-5", 100, 0, 100, false, nil},
		{"items=1-2", 100, 0, 100, false, nil},
	}
	for _, c := range cases {
		start, length, partial, err := parseRange(c.header, c.size)
		if err != c.wantErr {
			t.Errorf("parseRange(%q) error = %v, want %v", c.header, err, c.wantErr)
			continue
		}
		if err != nil {
			continue
		}
		if start != c.start || length != c.length || partial != c.partial {
			t.Errorf("parseRange(%q) = (%d, %d, %t), want (%d, %d, %t)",
				c.header, start, length, partial, c.start, c.length, c.partial)
		}
	}
}

// bareWeb returns a module with only the logger and the basic auth throttle
// wired; the handlers under test never touch the listeners or the storage
// manager because the file system is injected directly.
func bareWeb() *Web { return &Web{authThrottle: newAuthThrottle(), authCache: newBasicAuthCache()} }

// newStaticStore prepares the lazily opened storage of a static rule for a
// test directory.
func newStaticStore(t *testing.T, root string) *staticFS {
	t.Helper()
	store := &staticFS{label: root}
	store.open = func() (vfs.FS, func(), error) {
		fsys, err := vfs.OpenLocal(root, "test", true)
		if err != nil {
			return nil, nil, err
		}
		return fsys, func() { _ = fsys.Close() }, nil
	}
	fsys, err := store.get()
	if err != nil {
		t.Fatalf("open %s: %v", root, err)
	}
	t.Cleanup(func() {
		if c, ok := fsys.(interface{ Close() error }); ok {
			_ = c.Close()
		}
	})
	return store
}

// A client can send any X-Forwarded-* chain it likes. Unless the request came
// through a declared trusted proxy, the headers are rebuilt from the
// connection so the upstream never sees a made up address.
// The least connection strategy sends the next request to the upstream with
// the fewest requests in flight, ignoring the ones that are down.
func TestBalancerLeastConnPrefersIdleUpstream(t *testing.T) {
	b, err := newBalancer("least_conn", []string{"http://127.0.0.1:9001", "http://127.0.0.1:9002"})
	if err != nil {
		t.Fatalf("newBalancer: %v", err)
	}
	busy := "http://127.0.0.1:9001"
	b.begin(busy)
	defer b.end(busy)
	for i := 0; i < 5; i++ {
		if got := b.pick("192.0.2.1"); got.target != "http://127.0.0.1:9002" {
			t.Fatalf("pick = %q, want the idle upstream", got.target)
		}
	}
	if got, ok := b.pickExcept("192.0.2.1", "http://127.0.0.1:9002"); !ok || got.target != busy {
		t.Fatalf("pickExcept = %q/%v, want the only remaining upstream", got.target, ok)
	}

	// A down upstream is not chosen even when it has no requests in flight.
	b.report("http://127.0.0.1:9002", false)
	b.report("http://127.0.0.1:9002", false)
	b.report("http://127.0.0.1:9002", false)
	if got := b.pick("192.0.2.1"); got.target != busy {
		t.Fatalf("pick = %q after the idle upstream failed, want the busy one", got.target)
	}
}

// testConfigStore builds a configuration store in a temporary directory.
// testListener builds a listener for the module tests.
func testListener(id string, listen []string, tlsMode string) model.WebListener {
	return model.WebListener{ID: id, Name: id, Listen: listen, TLS: model.WebTLS{Mode: tlsMode}}
}

func testConfigStore(t *testing.T, rules ...model.WebRule) *config.Store {
	t.Helper()
	return testConfigStoreWithListener(t, testListener("l1", []string{":8080"}, model.TLSModeOff), rules...)
}

func testConfigStoreWithListener(t *testing.T, listener model.WebListener, rules ...model.WebRule) *config.Store {
	t.Helper()
	dir := t.TempDir()
	store := testutil.Config(t, filepath.Join(dir, "config.json"), testutil.Password)
	for i := range rules {
		if rules[i].ListenerID == "" {
			rules[i].ListenerID = listener.ID
		}
	}
	if err := store.Update(func(c *model.Config) error {
		c.Web.Listeners = []model.WebListener{listener}
		c.Web.Rules = rules
		return nil
	}); err != nil {
		t.Fatalf("update config: %v", err)
	}
	return store
}

// freeAddr returns a listen address on the loopback interface.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %s: %v", addr, err)
	}
	return ":" + port
}

func TestModuleStartServesAndStopCloses(t *testing.T) {
	addr := freeAddr(t)
	// The document root is created explicitly: t.TempDir would be removed
	// before Stop releases the file system handle.
	root, err := os.MkdirTemp("", "nunt-web-root")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	raw := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	raw.Static = &model.StaticTgt{Root: root, Listing: true}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), raw)
	deps := &module.Deps{
		Cfg:      store,
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	// Start and Reload must be safe to repeat.
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if err := w.apply(context.Background(), store.Snapshot()); err != nil {
		t.Fatalf("reload: %v", err)
	}

	url := "http://127.0.0.1" + addr + "/"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "hello" {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}

	// An unknown host must not reach the rule.
	req, _ = http.NewRequest(http.MethodGet, url, nil)
	req.Host = "unknown.example"
	resp, err = (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown host status = %d", resp.StatusCode)
	}

	stats := w.Status().Stats
	if stats["listeners"].(int) != 1 {
		t.Fatalf("listeners = %v", stats["listeners"])
	}
	if stats["rules"].(int) != 1 {
		t.Fatalf("rules = %v", stats["rules"])
	}
	// Only the request that matched the rule is counted; the one for the
	// unknown host is answered by the router before the rule chain runs.
	if stats["requests"].(int64) < 1 {
		t.Fatalf("requests = %v", stats["requests"])
	}
	perRule, ok := stats["ruleRequests"].(map[string]int64)
	if !ok || perRule[raw.ID] < 1 {
		t.Fatalf("ruleRequests = %v", stats["ruleRequests"])
	}
	entries := w.Logs(raw.ID, 10)
	if len(entries) == 0 {
		t.Fatal("the access log is empty")
	}
	entry := entries[0]
	if entry.RuleID != raw.ID || entry.Method != http.MethodGet || entry.Status != http.StatusOK {
		t.Fatalf("unexpected access log entry: %+v", entry)
	}
	if entry.ClientIP == "" || entry.Listen == "" || entry.Duration == "" {
		t.Fatalf("access log entry is incomplete: %+v", entry)
	}

	if err := w.Stop(context.Background()); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// Stop must be idempotent and the port must be free again.
	if err := w.Stop(context.Background()); err != nil {
		t.Fatalf("second stop: %v", err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("the port was not released: %v", err)
	}
	_ = ln.Close()
	if len(w.Listeners()) != 0 {
		t.Fatalf("listeners after stop = %v", w.Listeners())
	}
}

func TestModuleReloadReplacesListeners(t *testing.T) {
	first := freeAddr(t)
	second := freeAddr(t)
	rule := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	rule.Static = &model.StaticTgt{Root: t.TempDir()}

	store := testConfigStoreWithListener(t, testListener("l1", []string{first}, model.TLSModeOff), rule)
	deps := &module.Deps{
		Cfg:      store,
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = w.Stop(context.Background()) }()

	if got := w.Listeners(); len(got) != 1 || got[0] != first {
		t.Fatalf("listeners = %v, want [%s]", got, first)
	}

	if err := store.Update(func(c *model.Config) error {
		c.Web.Listeners = []model.WebListener{testListener("l1", []string{second}, model.TLSModeOff)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w.Reload(store.Snapshot())

	if got := w.Listeners(); len(got) != 1 || got[0] != second {
		t.Fatalf("listeners after reload = %v, want [%s]", got, second)
	}
	// The old socket has to be free again.
	ln, err := net.Listen("tcp", first)
	if err != nil {
		t.Fatalf("the previous port was not released: %v", err)
	}
	_ = ln.Close()

	// Disabling the rule removes every listener.
	disabled := rule
	disabled.Enable = false
	if err := store.Update(func(c *model.Config) error {
		c.Web.Rules = []model.WebRule{disabled}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w.Reload(store.Snapshot())
	if got := w.Listeners(); len(got) != 0 {
		t.Fatalf("listeners with a disabled rule = %v", got)
	}
}

func TestModuleRuleValidation(t *testing.T) {
	store := testConfigStore(t)
	deps := &module.Deps{
		Cfg:      store,
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = w.Stop(context.Background()) }()

	// A rule with an unusable proxy target is skipped, not fatal.
	bad := mkRule(t, "bad", "example.com", "/", 0, model.WebTypeProxy)
	bad.Proxy = &model.ProxyTarget{Targets: []string{"ftp://nope"}}
	if err := store.Update(func(c *model.Config) error {
		c.Web.Rules = []model.WebRule{bad}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	w.Reload(store.Snapshot())
	if got := w.Listeners(); len(got) != 0 {
		t.Fatalf("an invalid rule must not open a listener: %v", got)
	}
	if w.Status().Error == "" {
		t.Fatal("the invalid rule should be reported through the module error")
	}
}

func TestPrepareRuleHashesPassword(t *testing.T) {
	rule := mkRule(t, "guard", "example.com", "/", 0, model.WebTypeProxy)
	rule.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: "plain"}}}
	if err := prepareRule(&rule, nil); err != nil {
		t.Fatalf("prepareRule: %v", err)
	}
	if !strings.HasPrefix(rule.BasicAuth.Users[0].Password, "$argon2id$") {
		t.Fatalf("the password was not hashed: %q", rule.BasicAuth.Users[0].Password)
	}
	if !security.VerifyPassword(rule.BasicAuth.Users[0].Password, "plain") {
		t.Fatal("the stored hash does not verify")
	}

	// An update without a password keeps the stored hash.
	next := mkRule(t, "guard", "example.com", "/", 0, model.WebTypeProxy)
	next.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice"}}}
	if err := prepareRule(&next, &rule); err != nil {
		t.Fatalf("prepareRule: %v", err)
	}
	if next.BasicAuth.Users[0].Password != rule.BasicAuth.Users[0].Password {
		t.Fatal("the stored hash was not preserved")
	}
}

func TestLogBufferRingAndFilter(t *testing.T) {
	buf := newLogBuffer(3)
	for i := 0; i < 5; i++ {
		buf.add(AccessEntry{RuleID: "a", Path: string(rune('a' + i))})
	}
	rows := buf.list("", 10)
	if len(rows) != 3 {
		t.Fatalf("ring kept %d entries, want 3", len(rows))
	}
	if rows[0].Path != "e" || rows[2].Path != "c" {
		t.Fatalf("unexpected order: %+v", rows)
	}
	buf.add(AccessEntry{RuleID: "b", Path: "b-only"})
	filtered := buf.list("b", 10)
	if len(filtered) != 1 || filtered[0].Path != "b-only" {
		t.Fatalf("filter returned %+v", filtered)
	}
	buf.resize(2)
	if rows := buf.list("", 10); len(rows) != 2 {
		t.Fatalf("after resize %d entries", len(rows))
	}
}

// A reorder must name every item exactly once; anything else would drop or
// duplicate configuration entries.
func TestIdsInOrder(t *testing.T) {
	have := []string{"a", "b", "c"}
	if err := idsInOrder([]string{"c", "a", "b"}, have); err != nil {
		t.Fatalf("a permutation must pass: %v", err)
	}
	cases := map[string][]string{
		"missing":   {"a", "b"},
		"extra":     {"a", "b", "c", "d"},
		"duplicate": {"a", "a", "b"},
		"unknown":   {"a", "b", "z"},
	}
	for name, ids := range cases {
		if err := idsInOrder(ids, have); err == nil {
			t.Fatalf("%s: expected an error for %v", name, ids)
		}
	}
}

// The router canonicalises the path before matching so a raw path that an
// upstream would normalise cannot skip the rule protecting /admin.
func TestCanonicalPath(t *testing.T) {
	cases := map[string]string{
		"/":                "/",
		"":                 "/",
		"//admin":          "/admin",
		"/./admin":         "/admin",
		"/x/../admin":      "/admin",
		"/admin\\secret":   "/admin/secret",
		"/admin/":          "/admin/",
		"/a//b/":           "/a/b/",
		"/admin//./secret": "/admin/secret",
	}
	for in, want := range cases {
		got, ok := canonicalPath(in)
		if !ok || got != want {
			t.Fatalf("canonicalPath(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if _, ok := canonicalPath("/index\x00.html"); ok {
		t.Fatal("a NUL byte must be rejected")
	}
	if !matchPath("/admin", mustCanonical(t, "//admin")) {
		t.Fatal("//admin must match the /admin rule after canonicalisation")
	}
}

func mustCanonical(t *testing.T, p string) string {
	t.Helper()
	got, ok := canonicalPath(p)
	if !ok {
		t.Fatalf("canonicalPath(%q) rejected", p)
	}
	return got
}
