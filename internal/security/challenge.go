package security

import (
	"sync"
	"time"
)

// Challenge is a short lived token issued after the password step of a two
// factor login. It is not a session: it only proves "the password was correct a
// moment ago" and is exchanged for a real session once the second factor
// checks out.
type Challenge struct {
	Token     string
	UserID    string
	IP        string
	UserAgent string
	ExpiresAt time.Time
	Attempts  int
}

// ChallengeStore keeps the pending second factor challenges in memory. They die
// with the process, exactly like sessions do, and are removed as soon as they
// are used.
type ChallengeStore struct {
	mu    sync.Mutex
	items map[string]*Challenge
	ttl   time.Duration
	now   func() time.Time
}

// NewChallengeStore creates a store whose challenges live for ttl.
func NewChallengeStore(ttl time.Duration) *ChallengeStore {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	return &ChallengeStore{
		items: map[string]*Challenge{},
		ttl:   ttl,
		now:   time.Now,
	}
}

// Issue creates a challenge for the user and returns it.
func (s *ChallengeStore) Issue(userID, ip, userAgent string) (Challenge, error) {
	token, err := RandomToken(32)
	if err != nil {
		return Challenge{}, err
	}
	now := s.now()
	c := Challenge{
		Token:     token,
		UserID:    userID,
		IP:        ip,
		UserAgent: userAgent,
		ExpiresAt: now.Add(s.ttl),
	}

	s.mu.Lock()
	s.sweepLocked(now)
	s.items[token] = &c
	s.mu.Unlock()
	return c, nil
}

// Get returns a copy of the challenge. Expired entries are removed on the way
// out so a caller never sees one past its deadline.
func (s *ChallengeStore) Get(token string) (Challenge, bool) {
	if token == "" {
		return Challenge{}, false
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.items[token]
	if !ok {
		return Challenge{}, false
	}
	if !now.Before(c.ExpiresAt) {
		delete(s.items, token)
		return Challenge{}, false
	}
	out := *c
	return out, true
}

// Fail records one failed attempt and reports how many are left before the
// challenge is dropped. A challenge that runs out of attempts disappears, so
// the client has to authenticate with the password again.
func (s *ChallengeStore) Fail(token string, maxAttempts int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.items[token]
	if !ok {
		return 0
	}
	c.Attempts++
	left := maxAttempts - c.Attempts
	if left <= 0 {
		delete(s.items, token)
		return 0
	}
	return left
}

// Delete drops a challenge, used after a successful exchange.
func (s *ChallengeStore) Delete(token string) {
	s.mu.Lock()
	delete(s.items, token)
	s.mu.Unlock()
}

// Len reports how many challenges are pending (tests and diagnostics).
func (s *ChallengeStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items)
}

// sweepLocked removes expired challenges. It runs on every issue, which keeps
// the map bounded without a background goroutine.
func (s *ChallengeStore) sweepLocked(now time.Time) {
	for token, c := range s.items {
		if !now.Before(c.ExpiresAt) {
			delete(s.items, token)
		}
	}
}
