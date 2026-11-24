package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

func jsonRequest(t *testing.T, method, target, body string, pathValues map[string]string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range pathValues {
		req.SetPathValue(k, v)
	}
	return req.WithContext(api.WithIdentity(req.Context(), &api.Identity{Kind: api.IdentitySession}))
}

func newListenerTestWeb(t *testing.T) *Web {
	t.Helper()
	store := testConfigStore(t)
	return New(&module.Deps{Cfg: store, Registry: module.NewRegistry()})
}

func TestListenerCRUD(t *testing.T) {
	w := newListenerTestWeb(t)

	rec := httptest.NewRecorder()
	w.handleCreateListener(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/listeners",
		`{"name":"tls","listen":[":8443"],"tls":{"mode":"auto"}}`, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("create listener = %d: %s", rec.Code, rec.Body.String())
	}
	var created listenerView
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode listener: %v", err)
	}
	if created.ID == "" || created.TLS.Mode != model.TLSModeAuto {
		t.Fatalf("created listener = %+v", created)
	}

	// The same socket cannot belong to two listeners.
	rec = httptest.NewRecorder()
	w.handleCreateListener(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/listeners",
		`{"name":"dup","listen":[":8443"]}`, nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "already used") {
		t.Fatalf("duplicate address = %d: %s", rec.Code, rec.Body.String())
	}

	// A route may reference the new listener.
	rec = httptest.NewRecorder()
	w.handleCreateRule(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/rules",
		`{"name":"r","enable":true,"listenerId":"`+created.ID+`","type":"proxy","domains":["a.example.com"],"path":"/","proxy":{"targets":["http://127.0.0.1:9000"]}}`, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("create route = %d: %s", rec.Code, rec.Body.String())
	}

	// Deleting a listener with routes is refused.
	rec = httptest.NewRecorder()
	w.handleDeleteListener(rec, jsonRequest(t, http.MethodDelete, "/api/v1/web/listeners/"+created.ID, "", map[string]string{"id": created.ID}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("delete listener with routes = %d: %s", rec.Code, rec.Body.String())
	}

	// Deleting the route first makes it possible.
	var routeID string
	for _, r := range w.snapshot().Web.Rules {
		if r.ListenerID == created.ID {
			routeID = r.ID
		}
	}
	rec = httptest.NewRecorder()
	w.handleDeleteRule(rec, jsonRequest(t, http.MethodDelete, "/api/v1/web/rules/"+routeID, "", map[string]string{"id": routeID}))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete route = %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	w.handleDeleteListener(rec, jsonRequest(t, http.MethodDelete, "/api/v1/web/listeners/"+created.ID, "", map[string]string{"id": created.ID}))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete listener = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRuleRejectsUnknownListenerAndDuplicateRoute(t *testing.T) {
	w := newListenerTestWeb(t)

	rec := httptest.NewRecorder()
	w.handleCreateRule(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/rules",
		`{"name":"r","enable":true,"listenerId":"nope","type":"proxy","domains":["a.example.com"],"path":"/","proxy":{"targets":["http://127.0.0.1:9000"]}}`, nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "监听器") {
		t.Fatalf("unknown listener = %d: %s", rec.Code, rec.Body.String())
	}

	body := `{"name":"r","enable":true,"listenerId":"l1","type":"proxy","domains":["a.example.com"],"path":"/","proxy":{"targets":["http://127.0.0.1:9000"]}}`
	rec = httptest.NewRecorder()
	w.handleCreateRule(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/rules", body, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("first route = %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	w.handleCreateRule(rec, jsonRequest(t, http.MethodPost, "/api/v1/web/rules", body, nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("duplicate route = %d: %s", rec.Code, rec.Body.String())
	}
}
