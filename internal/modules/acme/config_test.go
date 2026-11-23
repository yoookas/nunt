package acme

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/crypto/acme"

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
	if view.KeyType != "ec256" || view.Email != "" {
		t.Fatalf("defaults = %+v", view)
	}
	if len(view.KeyTypes) != 4 {
		t.Fatalf("key types = %d", len(view.KeyTypes))
	}
}

func TestUpdateConfigSavesAndReturnsTheView(t *testing.T) {
	a := newConfigModule(t)
	body := `{"email":"ops@example.com","keyType":"rsa2048"}`
	rec := callConfig(t, a, http.MethodPut, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT config = %d: %s", rec.Code, rec.Body.String())
	}
	cfg := a.deps.Cfg.Snapshot()
	if cfg.ACME.Email != "ops@example.com" || cfg.ACME.KeyType != "rsa2048" {
		t.Fatalf("stored config = %+v", cfg.ACME)
	}
	var view acmeConfigView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if view.KeyType != "rsa2048" || view.Email != "ops@example.com" {
		t.Fatalf("response view = %+v", view)
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

func TestConfigViewExposesStaging(t *testing.T) {
	view := configView(&model.ACMEConfig{Email: "ops@example.com", Staging: true})
	if !view.Staging {
		t.Fatal("staging must be reported")
	}
	if view.Directory != letsencryptStagingDirectory {
		t.Fatalf("directory = %q", view.Directory)
	}
	prod := configView(&model.ACMEConfig{})
	if prod.Staging || prod.Directory != letsencryptDirectory {
		t.Fatalf("production view = %+v", prod)
	}
}

func TestStoredAccountKeepsTheDirectory(t *testing.T) {
	deps := &module.Deps{DataDir: t.TempDir()}
	m := newAccountManager(deps, slog.New(slog.NewTextHandler(io.Discard, nil)))
	m.directory = letsencryptStagingDirectory
	if err := m.saveAccount(&acme.Account{URI: "https://acme-staging-v02.api.letsencrypt.org/acct/1", Status: "valid"}); err != nil {
		t.Fatalf("saveAccount: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(deps.DataDir, "acme", "account.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored storedAccount
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Directory != letsencryptStagingDirectory {
		t.Fatalf("stored directory = %q, want staging", stored.Directory)
	}
}
