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
