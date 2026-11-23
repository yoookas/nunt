package web

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

func startCORSTest(t *testing.T, cors *model.CORS) (string, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("upstream"))
	}))
	t.Cleanup(upstream.Close)

	raw := mkRule(t, "cors", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, Balance: "roundrobin", CORS: cors}

	addr := freeAddr(t)
	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), raw)
	w := New(&module.Deps{Cfg: store, DataDir: t.TempDir(), Registry: module.NewRegistry()})
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })
	return addr, &hits
}

func doCORS(t *testing.T, addr, method, origin string, extra map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, "http://127.0.0.1"+addr+"/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp
}

func TestCORSPreflightIsAnsweredLocally(t *testing.T) {
	addr, hits := startCORSTest(t, &model.CORS{
		Origins: []string{"https://app.example.com"},
		Methods: []string{"GET", "POST"},
		Headers: []string{"Content-Type", "X-Token"},
		MaxAge:  600,
	})

	resp := doCORS(t, addr, http.MethodOptions, "https://app.example.com", map[string]string{
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "x-token",
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Fatalf("allow origin = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Methods"); got != "GET, POST" {
		t.Fatalf("allow methods = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); got != "Content-Type, X-Token" {
		t.Fatalf("allow headers = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Max-Age"); got != "600" {
		t.Fatalf("max age = %q", got)
	}
	if hits.Load() != 0 {
		t.Fatalf("the preflight reached the upstream %d times", hits.Load())
	}
}

func TestCORSHeadersOnRealRequests(t *testing.T) {
	addr, hits := startCORSTest(t, &model.CORS{Origins: []string{"https://app.example.com"}})

	resp := doCORS(t, addr, http.MethodGet, "https://app.example.com", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Fatalf("allow origin = %q", got)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hits = %d", hits.Load())
	}

	// A different origin gets no CORS headers and still reaches the upstream.
	other, otherHits := startCORSTest(t, &model.CORS{Origins: []string{"https://app.example.com"}})
	resp = doCORS(t, other, http.MethodGet, "https://evil.example.com", nil)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("a foreign origin must not receive CORS headers")
	}
	if otherHits.Load() != 1 {
		t.Fatalf("upstream hits = %d", otherHits.Load())
	}
}

func TestCORSWildcardEchoesOriginWithCredentials(t *testing.T) {
	addr, _ := startCORSTest(t, &model.CORS{Origins: []string{"*"}, Credentials: true})

	resp := doCORS(t, addr, http.MethodGet, "https://any.example.com", nil)
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://any.example.com" {
		t.Fatalf("allow origin = %q, want the concrete origin when credentials are allowed", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow credentials = %q", got)
	}
}

func TestCORSDisabledByDefault(t *testing.T) {
	addr, _ := startCORSTest(t, nil)
	resp := doCORS(t, addr, http.MethodGet, "https://app.example.com", nil)
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("without a policy the upstream owns the CORS headers")
	}
}
