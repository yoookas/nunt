package api

import (
	"net/http"
	"strings"
	"testing"
)

// The session list must expose the hashed id so the UI can revoke one session.
func TestSessionListExposesIDs(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)
	rec := env.do(t, http.MethodGet, "/api/v1/auth/sessions", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("sessions = %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"id":"`) {
		t.Fatalf("the session list carries no id: %s", body)
	}
}
