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
		Name:   "site",
		Enable: true,
		Type:   model.WebTypeRedirect,
		Listen: []string{":8080"},
		Path:   "ui",
		Redirect: &model.RedirectTgt{
			To: "https://example.com",
		},
	}
	if err := store.Update(func(c *model.Config) error {
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
		c.Web.Rules = append(c.Web.Rules, model.WebRule{
			Name:   "broken",
			Enable: true,
			Type:   model.WebTypeProxy,
			Listen: []string{":8081"},
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

// ---------------------------------------------------------------------------
// WebDAV exposes the mounted storage and must be authenticated or allow-listed.
// ---------------------------------------------------------------------------

// davRule builds a WebDAV rule with a valid listen address so the only
// remaining validation error can be the missing authentication.
func davRule(name string, mutate func(*model.WebRule)) model.WebRule {
	r := model.WebRule{
		ID:     "rule-dav",
		Name:   name,
		Enable: true,
		Type:   model.WebTypeWebDAV,
		Listen: []string{":8080"},
		Path:   "/files",
		Files:  &model.FilesTgt{Root: "/srv/files"},
	}
	if mutate != nil {
		mutate(&r)
	}
	return r
}

func validConfigWith(rules ...model.WebRule) *model.Config {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1", Username: "admin", Enabled: true}}
	cfg.Web.Rules = rules
	return cfg
}

func TestValidateRequiresAuthForWebDAV(t *testing.T) {
	cases := []struct {
		name    string
		rule    model.WebRule
		wantErr bool
	}{
		{
			name:    "webdav without any authentication is rejected",
			rule:    davRule("dav", nil),
			wantErr: true,
		},
		{
			name: "basic auth with a user is accepted",
			rule: davRule("dav", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: "$argon2id$v=19$m=1,t=1,p=1$x$y"}}}
			}),
		},
		{
			name: "basic auth that is disabled is not enough",
			rule: davRule("dav", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: false, Users: []model.BasicAuthUser{{Username: "alice", Password: "x"}}}
			}),
			wantErr: true,
		},
		{
			name: "basic auth without users is not enough",
			rule: davRule("dav", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: true}
			}),
			wantErr: true,
		},
		{
			name: "allow list with addresses is accepted even without basic auth",
			rule: davRule("dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessAllow, IPs: []string{"10.0.0.0/8", "192.168.1.5"}}
			}),
		},
		{
			name: "allow list without addresses is not enough",
			rule: davRule("dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessAllow}
			}),
			wantErr: true,
		},
		{
			name: "a deny list does not count as an allow list",
			rule: davRule("dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessDeny, IPs: []string{"203.0.113.0/24"}}
			}),
			wantErr: true,
		},
		{
			name: "a rule can carry both basic auth and an allow list",
			rule: davRule("dav", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "bob", Password: "x"}}}
				r.Access = model.Access{Mode: model.AccessAllow, IPs: []string{"127.0.0.1"}}
			}),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(validConfigWith(tc.rule))
			if tc.wantErr && err == nil {
				t.Fatal("the configuration must be rejected")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("the configuration must be accepted: %v", err)
			}
		})
	}
}

func TestUpdateRejectsAnonymousFileService(t *testing.T) {
	store, _, err := Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	rule := davRule("dav", nil)
	err = store.Update(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, rule)
		return nil
	})
	if err == nil {
		t.Fatal("saving an anonymous WebDAV rule must fail")
	}
	if len(store.Snapshot().Web.Rules) != 0 {
		t.Fatal("a rejected update must not change the live configuration")
	}

	rule.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: "x"}}}
	if err := store.Update(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, rule)
		return nil
	}); err != nil {
		t.Fatalf("a guarded WebDAV rule must be accepted: %v", err)
	}
	if len(store.Snapshot().Web.Rules) != 1 {
		t.Fatal("the guarded rule must be persisted")
	}
}
