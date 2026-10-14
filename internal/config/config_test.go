package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
// File services (filebrowser / webdav) must be authenticated or allow-listed.
// ---------------------------------------------------------------------------

// fileRule builds a filebrowser/webdav rule with a valid listen address so the
// only remaining validation error can be the missing authentication.
func fileRule(kind, name string, mutate func(*model.WebRule)) model.WebRule {
	r := model.WebRule{
		ID:     "rule-" + kind,
		Name:   name,
		Enable: true,
		Type:   kind,
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

func TestValidateRequiresAuthForFileServices(t *testing.T) {
	cases := []struct {
		name    string
		rule    model.WebRule
		wantErr bool
	}{
		{
			name:    "filebrowser without any authentication is rejected",
			rule:    fileRule(model.WebTypeFiles, "files", nil),
			wantErr: true,
		},
		{
			name:    "webdav without any authentication is rejected",
			rule:    fileRule(model.WebTypeWebDAV, "dav", nil),
			wantErr: true,
		},
		{
			name: "basic auth with a user is accepted",
			rule: fileRule(model.WebTypeFiles, "files", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: "$argon2id$v=19$m=1,t=1,p=1$x$y"}}}
			}),
		},
		{
			name: "basic auth that is disabled is not enough",
			rule: fileRule(model.WebTypeFiles, "files", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: false, Users: []model.BasicAuthUser{{Username: "alice", Password: "x"}}}
			}),
			wantErr: true,
		},
		{
			name: "basic auth without users is not enough",
			rule: fileRule(model.WebTypeFiles, "files", func(r *model.WebRule) {
				r.BasicAuth = &model.BasicAuth{Enable: true}
			}),
			wantErr: true,
		},
		{
			name: "allow list with addresses is accepted even without basic auth",
			rule: fileRule(model.WebTypeWebDAV, "dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessAllow, IPs: []string{"10.0.0.0/8", "192.168.1.5"}}
			}),
		},
		{
			name: "allow list without addresses is not enough",
			rule: fileRule(model.WebTypeWebDAV, "dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessAllow}
			}),
			wantErr: true,
		},
		{
			name: "a deny list does not count as an allow list",
			rule: fileRule(model.WebTypeWebDAV, "dav", func(r *model.WebRule) {
				r.Access = model.Access{Mode: model.AccessDeny, IPs: []string{"203.0.113.0/24"}}
			}),
			wantErr: true,
		},
		{
			name: "a rule can carry both basic auth and an allow list",
			rule: fileRule(model.WebTypeFiles, "files", func(r *model.WebRule) {
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
			if tc.wantErr {
				msg := err.Error()
				for _, want := range []string{"BasicAuth", "allow", "IP"} {
					if !strings.Contains(msg, want) {
						t.Fatalf("the error must mention %q, got %q", want, msg)
					}
				}
			}
		})
	}
}

func TestValidateFileServiceRuleKeepsOtherTypesWorking(t *testing.T) {
	proxy := model.WebRule{
		ID: "p", Name: "proxy", Enable: true, Type: model.WebTypeProxy,
		Listen: []string{":8080"}, Proxy: &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}},
	}
	static := model.WebRule{
		ID: "s", Name: "static", Enable: true, Type: model.WebTypeStatic,
		Listen: []string{":8080"}, Static: &model.StaticTgt{Root: "/srv/www"},
	}
	redirect := model.WebRule{
		ID: "r", Name: "redirect", Enable: true, Type: model.WebTypeRedirect,
		Listen: []string{":8080"}, Redirect: &model.RedirectTgt{To: "https://example.com"},
	}
	if err := Validate(validConfigWith(proxy, static, redirect)); err != nil {
		t.Fatalf("proxy, static and redirect rules must not need authentication: %v", err)
	}
}

func TestUpdateRejectsAnonymousFileService(t *testing.T) {
	store, _, err := Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	rule := fileRule(model.WebTypeFiles, "files", nil)
	err = store.Update(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, rule)
		return nil
	})
	if err == nil {
		t.Fatal("saving an anonymous file browser rule must fail")
	}
	if len(store.Snapshot().Web.Rules) != 0 {
		t.Fatal("a rejected update must not change the live configuration")
	}

	rule.BasicAuth = &model.BasicAuth{Enable: true, Users: []model.BasicAuthUser{{Username: "alice", Password: "x"}}}
	if err := store.Update(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, rule)
		return nil
	}); err != nil {
		t.Fatalf("a guarded file browser rule must be accepted: %v", err)
	}
	if len(store.Snapshot().Web.Rules) != 1 {
		t.Fatal("the guarded rule must be persisted")
	}
}
