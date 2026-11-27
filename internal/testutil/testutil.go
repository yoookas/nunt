// Package testutil holds the helpers shared by the test packages.
//
// No production file imports it, so it never reaches the binary. It exists
// because the credential code is deliberately expensive: an Argon2id
// verification of the administrator account allocates 64 MiB, and a suite that
// creates one configuration per test case pays that cost on every case. Under
// the race detector the same work is roughly an order of magnitude slower again.
package testutil

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/store"
)

// Password is the administrator password of a configuration seeded by Config.
const Password = "test-admin-password"

// Parameters of the cheap hash. They are a real Argon2id derivation, just a
// small one: the algorithm stores its parameters inside the PHC string, so a
// hash produced here is verified with these settings and every code path stays
// the one production uses. Only the cost changes.
const (
	cheapTime    = 1
	cheapMemory  = 1024 // KiB
	cheapThreads = 1
	cheapKeyLen  = 32
)

// PasswordHash returns a PHC string for password that is cheap to verify. Use
// it wherever a test needs a stored credential; the production hash functions
// keep their real cost.
func PasswordHash(password string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic(fmt.Sprintf("testutil: read password salt: %v", err))
	}
	key := argon2.IDKey([]byte(password), salt, cheapTime, cheapMemory, cheapThreads, cheapKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, cheapMemory, cheapTime, cheapThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
}

// Config writes a configuration whose administrator has the given password at
// path and loads it through the production loader. The file is written first on
// purpose: config.Load hashes a freshly generated password when the file is
// missing, which is the single most expensive thing this suite would otherwise
// do once per test.
func Config(t testing.TB, path, password string) *config.Store {
	t.Helper()
	cfg := config.Default()
	cfg.Users = []model.User{{
		ID:           model.NewID(),
		PasswordHash: PasswordHash(password),
		CreatedAt:    time.Now(),
	}}
	if err := store.WriteJSONAtomic(path, cfg, 0o600); err != nil {
		t.Fatalf("seed the configuration at %s: %v", path, err)
	}
	s, _, err := config.Load(path)
	if err != nil {
		t.Fatalf("load the configuration at %s: %v", path, err)
	}
	return s
}
