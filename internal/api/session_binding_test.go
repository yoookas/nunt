package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// loginAs performs a login from a caller with the given user agent and address
// and returns the session cookie.
func loginAs(t *testing.T, env *testEnv, ua, remoteAddr string) []*http.Cookie {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": "admin", "password": testPassword})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	return rec.Result().Cookies()
}

func sessionRequest(t *testing.T, env *testEnv, cookies []*http.Cookie, ua, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	req.Header.Set("User-Agent", ua)
	req.RemoteAddr = remoteAddr
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	return rec
}

// A session cookie must not work from a different client.
func TestSessionIsBoundToItsUserAgent(t *testing.T) {
	env := newTestEnv(t)
	cookies := loginAs(t, env, "browser-a", "192.0.2.10:1000")

	if rec := sessionRequest(t, env, cookies, "browser-a", "192.0.2.10:1000"); rec.Code != http.StatusOK {
		t.Fatalf("the original client was rejected: %d %s", rec.Code, rec.Body.String())
	}
	rec := sessionRequest(t, env, cookies, "browser-b", "192.0.2.10:1000")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a copied cookie was accepted: %d %s", rec.Code, rec.Body.String())
	}
	if env.sessions.Count() != 0 {
		t.Fatal("the mismatched session was not dropped")
	}
}

// The address check is opt-in: clients on mobile networks change address.
func TestSessionIPBindingIsOptIn(t *testing.T) {
	env := newTestEnv(t)
	cookies := loginAs(t, env, "browser-a", "192.0.2.10:1000")

	if rec := sessionRequest(t, env, cookies, "browser-a", "198.51.100.7:2000"); rec.Code != http.StatusOK {
		t.Fatalf("a changed address was rejected while binding is off: %d", rec.Code)
	}

	if err := env.store.Update(func(c *model.Config) error {
		c.System.SessionBindIP = true
		return nil
	}); err != nil {
		t.Fatalf("enable binding: %v", err)
	}
	if rec := sessionRequest(t, env, cookies, "browser-a", "198.51.100.7:2000"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a changed address was accepted while binding is on: %d", rec.Code)
	}
}

// The rate limiter must key on the real client behind a trusted proxy instead
// of putting every client in the proxy's bucket.
func TestRateLimitKeyHonoursTrustProxy(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/info", nil)
	req.RemoteAddr = "10.0.0.1:5555"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")

	if got := env.server.rateLimitKey(req); got != "10.0.0.1" {
		t.Fatalf("key without trust proxy = %q", got)
	}
	if err := env.store.Update(func(c *model.Config) error {
		c.System.TrustProxy = true
		return nil
	}); err != nil {
		t.Fatalf("trust proxy: %v", err)
	}
	if got := env.server.rateLimitKey(req); got != "203.0.113.9" {
		t.Fatalf("key with trust proxy = %q, want the forwarded client", got)
	}
}
