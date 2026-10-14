package security

import (
	"sync"
	"time"
)

// Limiter is a keyed failure counter with exponential lockout. It is used to
// slow down password guessing on the admin API.
type Limiter struct {
	mu       sync.Mutex
	entries  map[string]*limitEntry
	maxFails int
	lockFor  time.Duration
	window   time.Duration
}

type limitEntry struct {
	fails    int
	first    time.Time
	lockedTo time.Time
}

// NewLimiter creates a limiter that locks a key for lockFor once maxFails
// failures happened inside window.
func NewLimiter(maxFails int, lockFor, window time.Duration) *Limiter {
	if maxFails <= 0 {
		maxFails = 5
	}
	if lockFor <= 0 {
		lockFor = 10 * time.Minute
	}
	if window <= 0 {
		window = 15 * time.Minute
	}
	l := &Limiter{entries: map[string]*limitEntry{}, maxFails: maxFails, lockFor: lockFor, window: window}
	go l.janitor()
	return l
}

// Allow reports whether the key may attempt an operation right now and, when
// it may not, how long the caller has to wait.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		return true, 0
	}
	now := time.Now()
	if now.Before(e.lockedTo) {
		return false, time.Until(e.lockedTo)
	}
	if now.Sub(e.first) > l.window {
		delete(l.entries, key)
		return true, 0
	}
	return true, 0
}

// Fail records a failed attempt and returns the remaining lock duration.
func (l *Limiter) Fail(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	e, ok := l.entries[key]
	if !ok || now.Sub(e.first) > l.window {
		e = &limitEntry{first: now}
		l.entries[key] = e
	}
	e.fails++
	if e.fails >= l.maxFails {
		// Exponential backoff on repeated lockouts.
		extra := time.Duration(e.fails-l.maxFails) * l.lockFor
		lock := l.lockFor + extra
		if lock > 24*time.Hour {
			lock = 24 * time.Hour
		}
		e.lockedTo = now.Add(lock)
		return lock
	}
	return 0
}

// Reset clears the counters of a key (successful authentication).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}

func (l *Limiter) janitor() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		l.mu.Lock()
		for k, e := range l.entries {
			if now.After(e.lockedTo) && now.Sub(e.first) > l.window {
				delete(l.entries, k)
			}
		}
		l.mu.Unlock()
	}
}

// RateLimiter is a simple token bucket per key for request throttling.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64
	burst   float64
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter allows rate requests per second with the given burst.
func NewRateLimiter(rate, burst float64) *RateLimiter {
	return &RateLimiter{buckets: map[string]*bucket{}, rate: rate, burst: burst}
}

// Allow consumes one token for key.
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	b, ok := r.buckets[key]
	if !ok {
		b = &bucket{tokens: r.burst, last: now}
		r.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * r.rate
	if b.tokens > r.burst {
		b.tokens = r.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
