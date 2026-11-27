package waf

import (
	"context"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/reqmeta"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

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

func TestMiddlewareMergesVerdictIntoRequestMeta(t *testing.T) {
	m := newTestModule(t, baseConfig())
	info := reqmeta.New("req-1")
	r := newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", "")
	r = r.WithContext(reqmeta.With(r.Context(), info))
	rec := do(m, "site-a", okHandler("upstream"), r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("blocked = %d", rec.Code)
	}
	verdict, ok := info.WAF()
	if !ok || verdict.Action == "" || verdict.RuleID == 0 || verdict.Message == "" {
		t.Fatalf("verdict = %+v ok=%v", verdict, ok)
	}
}
