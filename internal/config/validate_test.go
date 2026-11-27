package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

func TestValidateRejectsNonRegularDatabasePaths(t *testing.T) {
	base := func() *model.Config {
		return &model.Config{
			Users: []model.User{{ID: "u", PasswordHash: "$argon2id$v=19$m=65536,t=2,p=4$c2FsdA$aGFzaA"}},
		}
	}
	cfg := base()
	cfg.System.IP2RegionDB = "/dev/zero"
	if err := Validate(cfg); err == nil {
		t.Fatal("a character device must be rejected")
	}
	cfg = base()
	cfg.System.IP2RegionV6DB = "relative/ip2region.xdb"
	if err := Validate(cfg); err == nil {
		t.Fatal("a relative path must be rejected")
	}
	cfg = base()
	cfg.System.IP2RegionDB = "/nonexistent/ip2region.xdb"
	if err := Validate(cfg); err != nil {
		t.Fatalf("a missing file is allowed (it may be mounted later): %v", err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "ip2region.xdb")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg = base()
	cfg.System.IP2RegionDB = file
	if err := Validate(cfg); err != nil {
		t.Fatalf("a regular file must pass: %v", err)
	}
}

// Trusted proxies are part of the client address decision, so an invalid
// entry must be rejected instead of being silently dropped.
func TestValidateTrustedProxies(t *testing.T) {
	base := func() *model.Config {
		return &model.Config{
			Users: []model.User{{ID: "u", PasswordHash: "$argon2id$v=19$m=65536,t=2,p=4$c2FsdA$aGFzaA"}},
		}
	}
	cfg := base()
	cfg.System.TrustProxy = true
	cfg.System.TrustedProxies = []string{"10.0.0.0/8", "2001:db8::/32", "127.0.0.1"}
	if err := Validate(cfg); err != nil {
		t.Fatalf("valid proxy addresses must pass: %v", err)
	}

	cfg = base()
	cfg.System.TrustedProxies = []string{"not-an-address"}
	if err := Validate(cfg); err == nil {
		t.Fatal("an invalid trusted proxy must be rejected")
	}

	// Normalize trims and de-duplicates the list.
	cfg = base()
	cfg.System.TrustedProxies = []string{" 10.0.0.1 ", "10.0.0.1", "", "10.0.0.2"}
	Normalize(cfg)
	if len(cfg.System.TrustedProxies) != 2 || cfg.System.TrustedProxies[0] != "10.0.0.1" || cfg.System.TrustedProxies[1] != "10.0.0.2" {
		t.Fatalf("normalized list = %v", cfg.System.TrustedProxies)
	}
}
