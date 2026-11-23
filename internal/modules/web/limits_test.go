package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

// newTestModule starts the web module on the loopback interface with the given
// rules and stops it when the test ends.
func newTestModule(t *testing.T, listener model.WebListener, rules ...model.WebRule) *Web {
	t.Helper()
	store := testConfigStoreWithListener(t, listener, rules...)
	deps := &module.Deps{
		Cfg:      store,
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })
	return w
}

// doRequest performs a request against a loopback module and returns the
// response with its body already read.
func doRequest(t *testing.T, client *http.Client, method, url, host string, body io.Reader) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = host
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, string(data)
}

func statusCount(t *testing.T, w *Web, ruleID string, status int) int {
	t.Helper()
	n := 0
	for _, entry := range w.Logs(ruleID, 200) {
		if entry.Status == status {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// rate limiter
// ---------------------------------------------------------------------------

func TestRateLimiterBucketRefillAndSweep(t *testing.T) {
	l := newRateLimiter(2)
	if l.burst != 2 || l.rate != 2 {
		t.Fatalf("unexpected limiter shape: burst=%v rate=%v", l.burst, l.rate)
	}
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("the first request must pass")
	}
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("the burst of two must pass")
	}
	ok, retry := l.allow("a")
	if ok {
		t.Fatal("the third request inside the same second must be refused")
	}
	if retry <= 0 || retry > time.Second {
		t.Fatalf("retry delay = %v, want a positive value below one second", retry)
	}
	// A different key has its own bucket.
	if ok, _ := l.allow("b"); !ok {
		t.Fatal("another client address must not be throttled")
	}

	// Refill: age the bucket by one second, which buys two tokens again.
	l.mu.Lock()
	l.buckets["a"].last = time.Now().Add(-time.Second)
	l.mu.Unlock()
	if ok, _ := l.allow("a"); !ok {
		t.Fatal("the bucket was not refilled")
	}

	// Housekeeping: a bucket that has been idle past the TTL is dropped during
	// the next sweep, and the table stays bounded.
	l.mu.Lock()
	l.buckets["stale"] = &rateBucket{tokens: 0, last: time.Now().Add(-2 * rateBucketTTL)}
	l.lastSweep = time.Now().Add(-time.Minute)
	l.mu.Unlock()
	if ok, _ := l.allow("fresh"); !ok {
		t.Fatal("the sweep must not refuse a fresh client")
	}
	l.mu.Lock()
	_, stale := l.buckets["stale"]
	size := len(l.buckets)
	l.mu.Unlock()
	if stale {
		t.Fatal("the sweep did not drop the idle bucket")
	}
	if size > 3 {
		t.Fatalf("the bucket table kept %d entries, want the live ones only", size)
	}
}

func TestRateLimiterDisabled(t *testing.T) {
	var l *rateLimiter
	if ok, retry := l.allow("any"); !ok || retry != 0 {
		t.Fatal("a nil limiter must let every request through")
	}
}

// ---------------------------------------------------------------------------
// module level: 429
// ---------------------------------------------------------------------------

func TestModuleProxyRateLimit(t *testing.T) {
	var hits atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		rw.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(rw, "backend")
	}))
	defer backend.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "limited", "example.com", "/", 0, model.WebTypeProxy)
	rule.Proxy = &model.ProxyTarget{Targets: []string{backend.URL}, RateLimitPerSec: 2}
	w := newTestModule(t, testListener("l1", []string{addr}, model.TLSModeOff), rule)

	client := &http.Client{Timeout: 5 * time.Second}
	url := "http://127.0.0.1" + addr + "/"

	first, _ := doRequest(t, client, http.MethodGet, url, "example.com", nil)
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first request status = %d", first.StatusCode)
	}
	second, _ := doRequest(t, client, http.MethodGet, url, "example.com", nil)
	if second.StatusCode != http.StatusOK {
		t.Fatalf("second request status = %d", second.StatusCode)
	}
	third, body := doRequest(t, client, http.MethodGet, url, "example.com", nil)
	if third.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("throttled request status = %d, want 429", third.StatusCode)
	}
	raw := strings.TrimSpace(third.Header.Get("Retry-After"))
	if raw == "" {
		t.Fatal("the 429 answer has no Retry-After header")
	}
	if wait, err := strconv.Atoi(raw); err != nil || wait < 1 {
		t.Fatalf("Retry-After = %q, want a positive number of seconds", raw)
	}
	if !strings.Contains(body, "请求过于频繁") {
		t.Fatalf("unexpected 429 body: %q", body)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("the upstream saw %d requests, want 2", got)
	}
	if got := w.Status().Stats["rateLimited"].(int64); got < 1 {
		t.Fatalf("rateLimited = %d, want >= 1", got)
	}
	if got := statusCount(t, w, rule.ID, http.StatusTooManyRequests); got < 1 {
		t.Fatal("the refused request is missing from the access log")
	}

	// The budget is per client address: a request coming from another address
	// through the trusted proxy is served again.
	if err := w.deps.Cfg.Update(func(c *model.Config) error {
		c.System.TrustProxy = true
		return nil
	}); err != nil {
		t.Fatalf("enable the trusted proxy: %v", err)
	}
	w.Reload(w.deps.Cfg.Snapshot())
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	req.Header.Set("X-Forwarded-For", "198.51.100.7")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a different client address must have its own budget, got %d", resp.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// module level: 413
// ---------------------------------------------------------------------------

func TestModuleProxyBodyLimit(t *testing.T) {
	var hits, received atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		n, _ := io.Copy(io.Discard, req.Body)
		hits.Add(1)
		received.Add(n)
		rw.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(rw, "backend")
	}))
	defer backend.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "body", "example.com", "/", 0, model.WebTypeProxy)
	rule.Proxy = &model.ProxyTarget{Targets: []string{backend.URL}, MaxBodyBytes: 64}
	w := newTestModule(t, testListener("l1", []string{addr}, model.TLSModeOff), rule)

	client := &http.Client{Timeout: 5 * time.Second}
	url := "http://127.0.0.1" + addr + "/"
	big := bytes.Repeat([]byte("x"), 4096)

	// A declared size above the limit is refused before the upstream is used.
	resp, body := doRequest(t, client, http.MethodPost, url, "example.com", bytes.NewReader(big))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized request status = %d, want 413", resp.StatusCode)
	}
	if !strings.Contains(body, "请求体过大") {
		t.Fatalf("unexpected 413 body: %q", body)
	}
	if got := hits.Load(); got != 0 {
		t.Fatalf("the upstream saw %d oversized requests, want 0", got)
	}

	// A body inside the limit is forwarded unchanged.
	small := bytes.Repeat([]byte("y"), 16)
	resp, _ = doRequest(t, client, http.MethodPost, url, "example.com", bytes.NewReader(small))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("allowed request status = %d", resp.StatusCode)
	}
	if got := received.Load(); got != int64(len(small)) {
		t.Fatalf("the upstream received %d bytes, want %d", got, len(small))
	}

	// A chunked body has no declared size: the cap has to stop it while it is
	// being read. The upstream may already have been dialled, but it must never
	// receive the whole oversized payload.
	chunked := struct{ io.Reader }{bytes.NewReader(big)}
	resp, _ = doRequest(t, client, http.MethodPost, url, "example.com", chunked)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked oversized request status = %d, want 413", resp.StatusCode)
	}
	if got, allowed := received.Load(), int64(len(small)+64); got > allowed {
		t.Fatalf("the upstream received %d bytes of an oversized body, want at most %d", got, allowed)
	}

	stats := w.Status().Stats
	if got := stats["bodyRejected"].(int64); got != 2 {
		t.Fatalf("bodyRejected = %d, want 2", got)
	}
	if got := statusCount(t, w, rule.ID, http.StatusRequestEntityTooLarge); got != 2 {
		t.Fatalf("access log 413 entries = %d, want 2", got)
	}
}

// ---------------------------------------------------------------------------
// rule toggle
// ---------------------------------------------------------------------------

func TestToggleReportsValidationFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	// The document is written by hand on purpose: config.Load normalises but
	// does not validate, which is how a rule that the current policy refuses
	// can exist on disk (written by an older version or edited by hand).
	seed := model.Config{
		Version: config.CurrentVersion,
		Users:   []model.User{{ID: "u1", Username: "admin", Role: "admin", Enabled: true}},
		Web: model.WebConfig{
			Listeners: []model.WebListener{{ID: "l1", Name: "http", Listen: []string{":8080"}}},
			Rules: []model.WebRule{{
				ID: "rule-broken", Name: "broken", Enable: false, Type: model.WebTypeStatic,
				ListenerID: "l1", Path: "/broken",
			}},
		},
	}
	data, err := json.Marshal(seed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	store, _, err := config.Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := len(store.Snapshot().Web.Rules); got != 1 {
		t.Fatalf("the hand written configuration holds %d rules, want 1", got)
	}

	w := New(&module.Deps{Cfg: store, Registry: module.NewRegistry()})
	toggle := func(id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/web/rules/"+id+"/toggle", nil)
		req.SetPathValue("id", id)
		req = req.WithContext(api.WithIdentity(req.Context(), &api.Identity{Kind: api.IdentitySession, Username: "admin"}))
		rec := httptest.NewRecorder()
		w.handleToggleRule(rec, req)
		return rec
	}

	rec := toggle("rule-broken")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("toggling a rule that fails validation status = %d (%s), want 400", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "无法应用该规则") {
		t.Fatalf("the refusal must explain the validation failure: %s", rec.Body.String())
	}
	if store.Snapshot().Web.Rules[0].Enable {
		t.Fatal("a refused toggle must not enable the rule")
	}

	rec = toggle("does-not-exist")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("toggling an unknown rule status = %d, want 404", rec.Code)
	}
}
