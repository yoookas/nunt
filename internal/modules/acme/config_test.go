package acme

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

func newConfigModule(t *testing.T) *ACME {
	t.Helper()
	store, _, err := config.Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if err := store.Update(func(c *model.Config) error {
		c.Users = []model.User{{ID: "u1", Username: "admin", Role: "admin", Enabled: true}}
		return nil
	}); err != nil {
		t.Fatalf("seed users: %v", err)
	}
	return &ACME{deps: &module.Deps{Cfg: store}}
}

func callConfig(t *testing.T, a *ACME, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/v1/acme/config", strings.NewReader(body))
	rec := httptest.NewRecorder()
	if method == http.MethodGet {
		a.handleGetConfig(rec, req)
	} else {
		a.handleUpdateConfig(rec, req)
	}
	return rec
}

func TestGetConfigDefaults(t *testing.T) {
	a := newConfigModule(t)
	rec := callConfig(t, a, http.MethodGet, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET config = %d: %s", rec.Code, rec.Body.String())
	}
	var view acmeConfigView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.CA != "letsencrypt" || view.KeyType != "ec256" {
		t.Fatalf("defaults = %+v", view)
	}
	if len(view.Authorities) != 3 || len(view.KeyTypes) != 4 {
		t.Fatalf("catalogs = %d authorities, %d key types", len(view.Authorities), len(view.KeyTypes))
	}
}

func TestUpdateConfigSavesAndReturnsTheView(t *testing.T) {
	a := newConfigModule(t)
	body := `{"email":"ops@example.com","ca":"letsencrypt-staging","keyType":"rsa2048"}`
	rec := callConfig(t, a, http.MethodPut, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT config = %d: %s", rec.Code, rec.Body.String())
	}
	cfg := a.deps.Cfg.Snapshot()
	if cfg.ACME.Email != "ops@example.com" || cfg.ACME.CA != "letsencrypt-staging" || cfg.ACME.KeyType != "rsa2048" {
		t.Fatalf("stored config = %+v", cfg.ACME)
	}
	var view acmeConfigView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.CA != "letsencrypt-staging" || view.Email != "ops@example.com" {
		t.Fatalf("response view = %+v", view)
	}
}

func TestUpdateConfigCustomDirectory(t *testing.T) {
	a := newConfigModule(t)
	rec := callConfig(t, a, http.MethodPut, `{"ca":"custom","caCustomUrl":"https://acme.example.com/directory"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("custom CA = %d: %s", rec.Code, rec.Body.String())
	}
	cfg := a.deps.Cfg.Snapshot()
	if cfg.ACME.CA != "custom" || cfg.ACME.CACustomURL != "https://acme.example.com/directory" {
		t.Fatalf("stored config = %+v", cfg.ACME)
	}
	// An empty CA and key type fall back to the defaults.
	rec = callConfig(t, a, http.MethodPut, `{"ca":"","keyType":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("default PUT = %d: %s", rec.Code, rec.Body.String())
	}
	cfg = a.deps.Cfg.Snapshot()
	if cfg.ACME.CA != "letsencrypt" || cfg.ACME.KeyType != "ec256" {
		t.Fatalf("defaults after save = %+v", cfg.ACME)
	}
}

func TestUpdateConfigRejectsInvalidInput(t *testing.T) {
	cases := map[string]string{
		"bad email":           `{"email":"not-an-email"}`,
		"unknown ca":          `{"ca":"nope"}`,
		"custom without url":  `{"ca":"custom"}`,
		"custom with bad url": `{"ca":"custom","caCustomUrl":"ftp://acme.example.com/directory"}`,
		"unknown key type":    `{"keyType":"ed25519"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			a := newConfigModule(t)
			before := a.deps.Cfg.Snapshot().ACME
			rec := callConfig(t, a, http.MethodPut, body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s = %d, want 400: %s", name, rec.Code, rec.Body.String())
			}
			if after := a.deps.Cfg.Snapshot().ACME; !reflect.DeepEqual(before, after) {
				t.Fatalf("a rejected update changed the configuration: %+v", after)
			}
		})
	}
}
