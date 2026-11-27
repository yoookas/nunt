package web

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
)

// basicAuthCacheTTL is how long one successful basic auth verification is
// remembered. Browsers resend the Authorization header on every request of a
// page (assets included), so without a cache every asset would occupy the
// global password slot and a site with basic auth would be limited to the
// throughput of one Argon2 verification.
const basicAuthCacheTTL = time.Minute

// basicAuthCacheMax bounds the number of remembered credentials.
const basicAuthCacheMax = 4096

// basicAuthCache remembers successful verifications for a short time. The key
// contains the stored password hash, so changing the password (or replacing
// the user) makes every old entry unreachable.
type basicAuthCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	now     func() time.Time
}

func newBasicAuthCache() *basicAuthCache {
	return &basicAuthCache{entries: map[string]time.Time{}, now: time.Now}
}

// key derives the cache key from the rule, the user, the stored hash and the
// presented password. Only a digest of the password is kept in memory.
func (c *basicAuthCache) key(ruleID, username, storedHash, password string) string {
	sum := sha256.Sum256([]byte(storedHash + "\x00" + password))
	return ruleID + "\x00" + username + "\x00" + hex.EncodeToString(sum[:])
}

// get reports whether the credential was verified recently.
func (c *basicAuthCache) get(key string) bool {
	if c == nil || key == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	expires, ok := c.entries[key]
	if !ok {
		return false
	}
	if !c.now().Before(expires) {
		delete(c.entries, key)
		return false
	}
	return true
}

// put remembers one verified credential.
func (c *basicAuthCache) put(key string) {
	if c == nil || key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if len(c.entries) >= basicAuthCacheMax {
		for k, expires := range c.entries {
			if !now.Before(expires) {
				delete(c.entries, k)
			}
		}
		// Still full: skip caching rather than growing without bound.
		if len(c.entries) >= basicAuthCacheMax {
			return
		}
	}
	c.entries[key] = now.Add(basicAuthCacheTTL)
}

// findAuthUser returns the configured user with this name. The comparison is
// constant time, like the password check.
func findAuthUser(users []model.BasicAuthUser, username string) (model.BasicAuthUser, bool) {
	var found model.BasicAuthUser
	ok := false
	for i := range users {
		if subtle.ConstantTimeCompare([]byte(users[i].Username), []byte(username)) == 1 {
			if !ok {
				found = users[i]
				ok = true
			}
		}
	}
	return found, ok
}
