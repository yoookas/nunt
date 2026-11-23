package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/security"
)

const testPassword = "test-password-1234"

type testEnv struct {
	server   *Server
	store    *config.Store
	sessions *security.SessionStore
	logs     *logstore.Store
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	store, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	hash, err := security.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := store.Update(func(c *model.Config) error {
		c.Users[0].PasswordHash = hash
		c.Users[0].MustChangePassword = false
		return nil
	}); err != nil {
		t.Fatalf("update config: %v", err)
	}

	hub := logging.New("error", "")
	t.Cleanup(hub.Close)
	box, err := secret.Open(filepath.Join(dir, "secret.key"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	certStore, err := certs.Open(filepath.Join(dir, "certs"))
	if err != nil {
		t.Fatalf("cert store: %v", err)
	}
	sessions := security.NewSessionStore()
	t.Cleanup(sessions.Close)
	registry := module.NewRegistry()

	logStore, err := logstore.Open(filepath.Join(dir, "logs", "access"), logstore.Options{
		Persist:   true,
		KeepDays:  7,
		MaxFileMB: 16,
	})
	if err != nil {
		t.Fatalf("log store: %v", err)
	}
	t.Cleanup(func() {
		if err := logStore.Close(); err != nil {
			t.Errorf("close log store: %v", err)
		}
	})

	server := New(Options{
		Cfg:      store,
		Log:      hub,
		Registry: registry,
		Certs:    certStore,
		Box:      box,
		Sessions: sessions,
		DataDir:  dir,
		Logs:     logStore,
	})
	// Deferred writes (token usage) must not outlive the test: t.TempDir
	// removal races with them on Windows ("the directory is not empty").
	t.Cleanup(server.WaitBackground)
	return &testEnv{server: server, store: store, sessions: sessions, logs: logStore}
}

func (e *testEnv) do(t *testing.T, method, path string, body any, cookies []*http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.server.Handler().ServeHTTP(rec, req)
	return rec
}

func TestUnauthenticatedRequestsAreRejected(t *testing.T) {
	env := newTestEnv(t)
	for _, path := range []string{"/api/v1/system/info", "/api/v1/auth/session"} {
		rec := env.do(t, http.MethodGet, path, nil, nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s must be 401 without credentials, got %d", path, rec.Code)
		}
	}
}

func TestLoginSessionAndCsrf(t *testing.T) {
	env := newTestEnv(t)

	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin",
		"password": "wrong-password",
	}, nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong password must be 401, got %d", rec.Code)
	}

	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin",
		"password": testPassword,
	}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	var login struct {
		CSRF string `json:"csrf"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &login); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	if login.CSRF == "" {
		t.Fatal("login must return a csrf token")
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("login must set a session cookie")
	}
	if !cookies[0].HttpOnly {
		t.Fatal("the session cookie must be HttpOnly")
	}

	// Session lookup works with the cookie.
	rec = env.do(t, http.MethodGet, "/api/v1/auth/session", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("session lookup: %d %s", rec.Code, rec.Body.String())
	}

	// Writes without the csrf header are rejected.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/tokens", map[string]any{"name": "ci"}, cookies, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a write without csrf must be 403, got %d", rec.Code)
	}

	// With the csrf header the token is created and returned exactly once.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/tokens", map[string]any{"name": "ci"}, cookies,
		map[string]string{"X-CSRF-Token": login.CSRF})
	if rec.Code != http.StatusOK {
		t.Fatalf("token creation: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	if created.Token == "" {
		t.Fatal("the plain token must be returned once")
	}

	// The stored token must never be exposed again.
	rec = env.do(t, http.MethodGet, "/api/v1/auth/tokens", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list tokens: %d", rec.Code)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte(created.Token)) {
		t.Fatal("the token list must not contain the plain token")
	}

	// API tokens authenticate through the Authorization header without csrf.
	rec = env.do(t, http.MethodGet, "/api/v1/system/info", nil, nil,
		map[string]string{"Authorization": "Bearer " + created.Token})
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer authentication failed: %d %s", rec.Code, rec.Body.String())
	}

	// Logout invalidates the session.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/logout", nil, cookies,
		map[string]string{"X-CSRF-Token": login.CSRF})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", rec.Code)
	}
	rec = env.do(t, http.MethodGet, "/api/v1/auth/session", nil, cookies, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the session must be gone after logout, got %d", rec.Code)
	}
}

func TestLoginLockout(t *testing.T) {
	env := newTestEnv(t)
	if err := env.store.Update(func(c *model.Config) error {
		c.System.LoginMaxFail = 2
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	env.server.loginLimiter = security.NewLimiter(2, time.Minute, time.Minute)

	body := map[string]string{"username": "admin", "password": "nope"}
	env.do(t, http.MethodPost, "/api/v1/auth/login", body, nil, nil)
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", body, nil, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("the account must be locked after repeated failures, got %d", rec.Code)
	}
}

func TestConfigExportMasksSecrets(t *testing.T) {
	env := newTestEnv(t)
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin", "password": testPassword,
	}, nil, nil)
	var login struct {
		CSRF string `json:"csrf"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &login)

	if err := env.store.Update(func(c *model.Config) error {
		c.DDNS.Rules = append(c.DDNS.Rules, model.DDNSRule{
			ID:       "rule-1",
			Name:     "home",
			Domain:   "example.com",
			Provider: "alidns",
			Creds:    map[string]string{"token": "plain-dns-token"},
		})
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	rec = env.do(t, http.MethodGet, "/api/v1/system/config", nil, rec.Result().Cookies(),
		map[string]string{"X-CSRF-Token": login.CSRF})
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("plain-dns-token")) {
		t.Fatal("the exported configuration must not contain secrets")
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("passwordHash")) {
		t.Fatal("the exported configuration must not contain password hashes")
	}
}
