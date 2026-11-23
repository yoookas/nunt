package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
)

func TestLoadCreatesSecureDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	store, password, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if password == "" {
		t.Fatal("a random password must be generated on first start")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("the configuration must be 0600, got %v", info.Mode().Perm())
	}
	user, ok := store.FindUser("admin")
	if !ok {
		t.Fatal("the default administrator must exist")
	}
	if !user.MustChangePassword {
		t.Fatal("the generated password must be marked as temporary")
	}
	if !security.VerifyPassword(user.PasswordHash, password) {
		t.Fatal("the reported password must match the stored hash")
	}
	if _, ok := store.FindUser("nobody"); ok {
		t.Fatal("unknown users must not be found")
	}
}

func TestUpdatePersistsAndNotifies(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	store, _, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	var notified int
	store.Subscribe(func(*model.Config) { notified++ })

	rule := model.WebRule{
		Name:       "site",
		Enable:     true,
		Type:       model.WebTypeRedirect,
		ListenerID: "l1",
		Path:       "ui",
		Redirect: &model.RedirectTgt{
			To: "https://example.com",
		},
	}
	if err := store.Update(func(c *model.Config) error {
		c.Web.Listeners = []model.WebListener{{ID: "l1", Name: "http", Listen: []string{":8080"}}}
		c.Web.Rules = append(c.Web.Rules, rule)
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if notified != 1 {
		t.Fatalf("subscribers must be notified once, got %d", notified)
	}

	reloaded, _, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	snapshot := reloaded.Snapshot()
	if len(snapshot.Web.Rules) != 1 {
		t.Fatalf("the rule must be persisted, got %d rules", len(snapshot.Web.Rules))
	}
	got := snapshot.Web.Rules[0]
	if got.ID == "" {
		t.Fatal("an id must be assigned during normalization")
	}
	if got.Path != "/ui" {
		t.Fatalf("the path must be normalized, got %q", got.Path)
	}
	if got.Redirect.Status != 302 {
		t.Fatalf("the default redirect status must be filled in, got %d", got.Redirect.Status)
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Fatalf("a backup of the previous revision must exist: %v", err)
	}
}

func TestUpdateRejectsInvalidConfiguration(t *testing.T) {
	store, _, err := Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	err = store.Update(func(c *model.Config) error {
		c.Web.Listeners = []model.WebListener{{ID: "l1", Name: "http", Listen: []string{":8081"}}}
		c.Web.Rules = append(c.Web.Rules, model.WebRule{
			Name:       "broken",
			Enable:     true,
			Type:       model.WebTypeProxy,
			ListenerID: "l1",
		})
		return nil
	})
	if err == nil {
		t.Fatal("a proxy rule without a target must be rejected")
	}
	if len(store.Snapshot().Web.Rules) != 0 {
		t.Fatal("a rejected update must not change the live configuration")
	}
}

func TestValidate(t *testing.T) {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1", Username: "admin", Enabled: true}}
	if err := Validate(cfg); err != nil {
		t.Fatalf("the default configuration must be valid: %v", err)
	}
	cfg.Users = nil
	if err := Validate(cfg); err == nil {
		t.Fatal("a configuration without users must be rejected")
	}
}

func TestNormalizeDisablesSeedlessTOTP(t *testing.T) {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1", Username: "admin", Role: "admin", Enabled: true,
		TOTP: model.TOTP{Enabled: true}}}
	Normalize(cfg)
	if cfg.Users[0].TOTP.Enabled {
		t.Fatal("a TOTP factor without a secret must be disabled")
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("the repaired configuration must be valid: %v", err)
	}
}

func TestClientCertificateValidation(t *testing.T) {
	cfg := Default()
	cfg.Web.Listeners = []model.WebListener{{
		ID: "l1", Name: "tls", Listen: []string{":8443"},
		TLS: model.WebTLS{Mode: model.TLSModeAuto, ClientAuth: model.ClientAuthRequire},
	}}
	Normalize(cfg)
	if err := Validate(cfg); err == nil {
		t.Fatal("require without a CA bundle must be rejected")
	}
}

func TestClientCertificateClearedOnPlainListener(t *testing.T) {
	cfg := Default()
	cfg.Web.Listeners = []model.WebListener{{
		ID: "l1", Name: "plain", Listen: []string{":8080"},
		TLS: model.WebTLS{Mode: model.TLSModeOff, ClientAuth: model.ClientAuthRequire, ClientCA: "x"},
	}}
	Normalize(cfg)
	if cfg.Web.Listeners[0].TLS.ClientAuth != model.ClientAuthOff || cfg.Web.Listeners[0].TLS.ClientCA != "" {
		t.Fatalf("plain listener kept client auth: %+v", cfg.Web.Listeners[0].TLS)
	}
}
