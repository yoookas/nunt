package api

import (
	"net/http"
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
