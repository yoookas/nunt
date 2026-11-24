package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// A deployment with one enabled account offers a password only sign in: the
// login page asks the mode endpoint, and the API accepts an empty username.
func TestLoginWithPasswordOnlyWhenSingleUser(t *testing.T) {
	env := newTestEnv(t)

	rec := env.do(t, http.MethodGet, "/api/v1/auth/mode", nil, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("auth mode = %d: %s", rec.Code, rec.Body.String())
	}
	var mode struct {
		SingleUser bool `json:"singleUser"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &mode); err != nil {
		t.Fatalf("decode auth mode: %v", err)
	}
	if !mode.SingleUser {
		t.Fatalf("a fresh install has one admin, got %+v", mode)
	}

	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{"password": testPassword}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("password only login = %d: %s", rec.Code, rec.Body.String())
	}
	if len(rec.Result().Cookies()) == 0 {
		t.Fatal("password only login must set a session cookie")
	}

	// The wrong password still fails, and reports the usual reason.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{"password": "wrong"}, nil, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d, want 401", rec.Code)
	}
}

// Two accounts cannot share one password box: the username is required again.
func TestLoginRequiresUsernameWithSeveralAccounts(t *testing.T) {
	env := newTestEnv(t)
	if err := env.store.Update(func(c *model.Config) error {
		c.Users = append(c.Users, model.User{ID: "u2", Username: "family", Role: "admin", Enabled: true})
		return nil
	}); err != nil {
		t.Fatalf("add user: %v", err)
	}

	rec := env.do(t, http.MethodGet, "/api/v1/auth/mode", nil, nil, nil)
	var mode struct {
		SingleUser bool `json:"singleUser"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &mode)
	if mode.SingleUser {
		t.Fatalf("two enabled users must not report single user mode")
	}

	rec = env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{"password": testPassword}, nil, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("password only login with two users = %d, want 400", rec.Code)
	}
}
