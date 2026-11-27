package web

import (
	"testing"
	"time"
)

// TestBasicAuthCacheKeyBindsStoredHash proves that changing the stored hash
// (a password change or a new salt) invalidates the cached credential.
func TestBasicAuthCacheKeyBindsStoredHash(t *testing.T) {
	c := newBasicAuthCache()
	first := c.key("rule", "alice", "hash-a", "secret")
	second := c.key("rule", "alice", "hash-b", "secret")
	if first == second {
		t.Fatal("keys for different stored hashes must differ")
	}
	if first != c.key("rule", "alice", "hash-a", "secret") {
		t.Fatal("the key must be deterministic")
	}
	if first == c.key("rule", "bob", "hash-a", "secret") {
		t.Fatal("keys for different users must differ")
	}
	if first == c.key("rule", "alice", "hash-a", "other") {
		t.Fatal("keys for different passwords must differ")
	}
}

func TestBasicAuthCacheHitAndExpiry(t *testing.T) {
	c := newBasicAuthCache()
	now := time.Unix(1700000000, 0)
	c.now = func() time.Time { return now }
	key := c.key("rule", "alice", "hash", "secret")

	if c.get(key) {
		t.Fatal("an unknown key must miss")
	}
	c.put(key)
	if !c.get(key) {
		t.Fatal("a stored key must hit")
	}
	now = now.Add(basicAuthCacheTTL)
	if c.get(key) {
		t.Fatal("an expired key must miss")
	}
}

func TestBasicAuthCacheBounds(t *testing.T) {
	c := newBasicAuthCache()
	now := time.Unix(1700000000, 0)
	c.now = func() time.Time { return now }
	for i := 0; i < basicAuthCacheMax+10; i++ {
		c.put(c.key("rule", "user", "hash", string(rune(i))))
	}
	if len(c.entries) > basicAuthCacheMax {
		t.Fatalf("cache grew to %d entries, want at most %d", len(c.entries), basicAuthCacheMax)
	}
}
