package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// The console has exactly one account, so signing in asks for the password
// alone; there is no user name to type.
func TestLoginWithPasswordOnly(t *testing.T) {
	env := newTestEnv(t)

	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{"password": testPassword}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("password only login = %d: %s", rec.Code, rec.Body.String())
	}
	if len(rec.Result().Cookies()) == 0 {
		t.Fatal("password only login must set a session cookie")
	}

	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{"password": "wrong"}, nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d, want 401", rec.Code)
	}
}

// A configuration that still carries extra accounts (from a build that had
// user names) keeps the first one and drops the rest.
func TestOnlyOneAdministratorSurvivesNormalization(t *testing.T) {
	env := newTestEnv(t)
	if err := env.store.Update(func(c *model.Config) error {
		c.Users = append(c.Users, model.User{ID: "u2"})
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if got := len(env.store.Snapshot().Users); got != 1 {
		t.Fatalf("users = %d, want the extra account dropped", got)
	}
}

// Until the temporary password is replaced the session can only read itself,
// change the password or log out; anything else would run with a credential
// the operator has not chosen.
func TestForcedPasswordChangeBlocksOtherEndpoints(t *testing.T) {
	env := newTestEnv(t)
	if err := env.store.Update(func(c *model.Config) error {
		c.Users[0].MustChangePassword = true
		return nil
	}); err != nil {
		t.Fatalf("flag the password: %v", err)
	}

	cookies, csrf := login(t, env)

	rec := env.do(t, http.MethodGet, "/api/v1/system/info", nil, cookies, nil)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "password_change_required") {
		t.Fatalf("other endpoints must be blocked, got %d: %s", rec.Code, rec.Body.String())
	}
	rec = env.do(t, http.MethodGet, "/api/v1/auth/session", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("the session endpoint must stay reachable, got %d", rec.Code)
	}

	rec = env.do(t, http.MethodPost, "/api/v1/auth/password",
		map[string]string{"current": testPassword, "new": "a-new-password"}, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("changing the password = %d: %s", rec.Code, rec.Body.String())
	}
	if env.store.Admin().MustChangePassword {
		t.Fatal("the flag must be cleared after the change")
	}
	rec = env.do(t, http.MethodGet, "/api/v1/system/info", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("the console must open after the change, got %d: %s", rec.Code, rec.Body.String())
	}
}
