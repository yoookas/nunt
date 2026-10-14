package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// TestTokenUsageWriteIsJoinable guards the Windows flake where the
// asynchronous "token last used" write raced with the t.TempDir cleanup
// ("the directory is not empty"): WaitBackground must join that write, and the
// write must still be persisted.
func TestTokenUsageWriteIsJoinable(t *testing.T) {
	env := newTestEnv(t)

	rec := env.do(t, http.MethodPost, "/api/v1/auth/login",
		map[string]string{"username": "admin", "password": testPassword}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	var login map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &login); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	csrf, _ := login["csrf"].(string)
	cookies := rec.Result().Cookies()

	rec = env.do(t, http.MethodPost, "/api/v1/auth/tokens", map[string]string{"name": "background"},
		cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("token creation: %d %s", rec.Code, rec.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	token, _ := created["token"].(string)

	// Using the token schedules the deferred usage write.
	rec = env.do(t, http.MethodGet, "/api/v1/system/info", nil, nil,
		map[string]string{"Authorization": "Bearer " + token})
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer call: %d %s", rec.Code, rec.Body.String())
	}

	env.server.WaitBackground()
	cfg := env.store.Snapshot()
	if len(cfg.Tokens) != 1 || cfg.Tokens[0].LastUsed == nil {
		t.Fatalf("the token usage timestamp must be flushed before teardown: %+v", cfg.Tokens)
	}
}
