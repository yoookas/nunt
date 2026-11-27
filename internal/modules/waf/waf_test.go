package waf

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/testutil"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func testDeps(t *testing.T, waf model.WAFConfig) *module.Deps {
	t.Helper()
	dir := t.TempDir()
	store := testutil.Config(t, filepath.Join(dir, "config.json"), testutil.Password)
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

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// middleware
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

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
