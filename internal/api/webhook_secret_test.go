package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// The saved webhook response must never hand the plaintext header back, and a
// test request may address the stored entry by id and let the server fill it.
func TestWebhookSecretsStayMaskedAndResolveOnTest(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)
	headers := map[string]string{"X-CSRF-Token": csrf}

	hook := model.Webhook{
		ID: "w1", Name: "ops", Enable: true, URL: "https://example.com/hook",
		Headers: map[string]string{"Authorization": "Bearer secret-value"},
	}
	rec := env.do(t, http.MethodPut, "/api/v1/notify/webhooks", []model.Webhook{hook}, cookies, headers)
	if rec.Code != http.StatusOK {
		t.Fatalf("save webhook = %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); strings.Contains(body, "secret-value") {
		t.Fatalf("the save response leaked the header: %s", body)
	}

	rec = env.do(t, http.MethodGet, "/api/v1/notify/webhooks", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list webhooks = %d", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "secret-value") {
		t.Fatalf("the list response leaked the header: %s", body)
	}

	stored := map[string]model.Webhook{"w1": hook}
	got := resolveWebhookSecrets(model.Webhook{ID: "w1", Headers: map[string]string{"Authorization": "********"}}, stored)
	if got.URL != hook.URL || got.Headers["Authorization"] != "Bearer secret-value" {
		t.Fatalf("resolved webhook = %+v", got)
	}
	// A header that was never saved stays masked and is refused by the handler.
	other := resolveWebhookSecrets(model.Webhook{ID: "w1", Headers: map[string]string{"X-New": "********"}}, stored)
	if other.Headers["X-New"] != "********" {
		t.Fatalf("an unsaved masked header was filled: %+v", other.Headers)
	}
}

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
