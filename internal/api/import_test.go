package api

import (
	"net/http"
	"testing"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
)

// Importing a configuration can replace the administrator (new id, new
// password hash). Sessions issued under the previous credentials must not
// survive that.
func TestConfigImportDropsSessionsOfTheOldAdmin(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)

	hash, err := security.HashPassword("another-long-password")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	cfg := env.store.Snapshot()
	cfg.Users = []model.User{{
		ID:           "imported-admin",
		PasswordHash: hash,
		CreatedAt:    cfg.Users[0].CreatedAt,
	}}

	rec := env.do(t, http.MethodPut, "/api/v1/system/config",
		map[string]any{"config": cfg}, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("import = %d: %s", rec.Code, rec.Body.String())
	}

	rec = env.do(t, http.MethodGet, "/api/v1/system/info", nil, cookies, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("the old session must be gone, got %d: %s", rec.Code, rec.Body.String())
	}

	// The imported credentials work.
	rec = env.do(t, http.MethodPost, "/api/v1/auth/login",
		map[string]string{"password": "another-long-password"}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login with the imported password = %d: %s", rec.Code, rec.Body.String())
	}
}
