package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// trustProxies turns on the forwarded header policy of the test configuration.
func trustProxies(t *testing.T, env *testEnv, proxies ...string) {
	t.Helper()
	if err := env.store.Update(func(c *model.Config) error {
		c.System.TrustProxy = true
		c.System.TrustedProxies = proxies
		return nil
	}); err != nil {
		t.Fatalf("update the trust proxy configuration: %v", err)
	}
}

// loginFrom posts the administrator password from a given peer and, when it is
// not empty, announces the protocol of the hop in front of the service.
func loginFrom(t *testing.T, env *testEnv, remoteAddr, forwardedProto string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": testPassword})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "test-browser")
	req.RemoteAddr = remoteAddr
	if forwardedProto != "" {
		req.Header.Set("X-Forwarded-Proto", forwardedProto)
	}
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	return rec
}

// sessionCookieOf returns the session cookie of a response.
func sessionCookieOf(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookie {
			return c
		}
	}
	t.Fatalf("the response carries no %s cookie: %v", SessionCookie, rec.Result().Header)
	return nil
}

// csrfOf returns the CSRF token of a login response.
func csrfOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		CSRF string `json:"csrf"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode the login response: %v", err)
	}
	if out.CSRF == "" {
		t.Fatal("the login response carries no CSRF token")
	}
	return out.CSRF
}

// The default deployment reaches the console over plain HTTP (the admin
// listener has no TLS), so the cookie must stay non-Secure: a browser never
// sends a Secure cookie back over http, which would turn every login into a
// successful response followed by an immediate return to the sign in screen.
func TestSessionCookieIsNotSecureOverPlainHTTP(t *testing.T) {
	env := newTestEnv(t)
	rec := loginFrom(t, env, "192.0.2.10:1000", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookieOf(t, rec); c.Secure {
		t.Fatal("a plain HTTP login must not mark the session cookie Secure")
	}
}

// A console published through a TLS terminating proxy must get the strict
// cookie: the connection to the API is plain, the browser's is not.
func TestSessionCookieIsSecureBehindATrustedTLSProxy(t *testing.T) {
	env := newTestEnv(t)
	trustProxies(t, env, "127.0.0.1/32")
	rec := loginFrom(t, env, "127.0.0.1:5000", "https")
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookieOf(t, rec); !c.Secure {
		t.Fatal("the session cookie must be Secure when a trusted proxy reports https")
	}
}

// The forwarded header is worth nothing from a peer that is not a proxy: an
// arbitrary caller must not be able to choose the flags of the cookie it gets.
func TestSessionCookieIgnoresAForgedProtocolHeader(t *testing.T) {
	env := newTestEnv(t)
	trustProxies(t, env, "127.0.0.1/32")
	rec := loginFrom(t, env, "198.51.100.7:5000", "https")
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookieOf(t, rec); c.Secure {
		t.Fatal("an untrusted peer must not be able to set X-Forwarded-Proto")
	}
}

// A trusted proxy that keeps serving plain HTTP (for example an internal
// health checker) still gets a usable cookie.
func TestSessionCookieStaysUsableWhenTheProxySaysHTTP(t *testing.T) {
	env := newTestEnv(t)
	trustProxies(t, env, "127.0.0.1/32")
	rec := loginFrom(t, env, "127.0.0.1:5000", "http")
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	if c := sessionCookieOf(t, rec); c.Secure {
		t.Fatal("an http request must not get a Secure cookie")
	}
}

// Logging out has to clear the same cookie it set: the deletion has to carry
// the Secure flag as well, otherwise a browser protects the Secure cookie from
// a plaintext overwrite and the session survives the logout.
func TestLogoutClearsTheSecureCookieBehindATrustedTLSProxy(t *testing.T) {
	env := newTestEnv(t)
	trustProxies(t, env, "127.0.0.1/32")

	login := loginFrom(t, env, "127.0.0.1:5000", "https")
	if login.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", login.Code, login.Body.String())
	}
	cookie := sessionCookieOf(t, login)
	csrf := csrfOf(t, login)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("User-Agent", "test-browser")
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.RemoteAddr = "127.0.0.1:5000"
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	env.server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout = %d: %s", rec.Code, rec.Body.String())
	}

	cleared := sessionCookieOf(t, rec)
	if cleared.Value != "" {
		t.Fatalf("the logout cookie still carries a value: %q", cleared.Value)
	}
	if cleared.MaxAge != -1 {
		t.Fatalf("MaxAge = %d, want -1", cleared.MaxAge)
	}
	if !cleared.Secure {
		t.Fatal("the deletion cookie must repeat the Secure flag of the cookie it clears")
	}
	if env.sessions.Count() != 0 {
		t.Fatal("the session survived the logout")
	}
}
