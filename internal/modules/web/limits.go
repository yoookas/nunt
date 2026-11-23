package web

import (
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Messages shown to a visitor whose request was refused. The user facing text
// of the project is Chinese.
const (
	rateLimitMessage = "请求过于频繁，请稍后重试"
	bodyLimitMessage = "请求体过大"
)

// Housekeeping of the request rate limiter. Buckets are swept lazily while a
// request is being served, so the module never has to own a background
// goroutine that could outlive Stop.
const (
	rateSweepInterval = 30 * time.Second
	rateBucketTTL     = 5 * time.Minute
	// maxRateBuckets bounds the memory a flood from many addresses can pin.
	maxRateBuckets = 100000
)

// ---------------------------------------------------------------------------
// request rate limiting
// ---------------------------------------------------------------------------

// rateLimiter is a token bucket per client address. It is created once per rule
// and is safe for concurrent use.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rateBucket
	// rate is the refill speed in tokens per second; burst is the capacity of a
	// bucket, one second worth of traffic by default.
	rate      float64
	burst     float64
	lastSweep time.Time
}

// rateBucket is the state of one client address.
type rateBucket struct {
	tokens float64
	last   time.Time
}

// newRateLimiter builds a limiter that allows perSec requests per second with a
// burst of one second. A non positive rate would never let a request through,
// so callers must not create a limiter in that case.
func newRateLimiter(perSec int) *rateLimiter {
	rate := float64(perSec)
	return &rateLimiter{
		buckets:   map[string]*rateBucket{},
		rate:      rate,
		burst:     rate,
		lastSweep: time.Now(),
	}
}

// allow consumes one token for key. The second return value tells the caller
// how long it should wait before the next attempt may succeed.
func (l *rateLimiter) allow(key string) (bool, time.Duration) {
	if l == nil || l.rate <= 0 {
		return true, 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	l.sweepLocked(now)
	b := l.buckets[key]
	if b == nil {
		b = &rateBucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	}
	b.tokens--
	return true, 0
}

// sweepLocked drops the buckets that have been idle for longer than the TTL.
// It runs at most once per sweep interval, unless the table grew past the hard
// cap and has to be trimmed right away.
func (l *rateLimiter) sweepLocked(now time.Time) {
	if len(l.buckets) < maxRateBuckets && now.Sub(l.lastSweep) < rateSweepInterval {
		return
	}
	l.lastSweep = now
	for key, b := range l.buckets {
		if now.Sub(b.last) >= rateBucketTTL {
			delete(l.buckets, key)
		}
	}
	if len(l.buckets) <= maxRateBuckets {
		return
	}
	// Still too large: the least recently used buckets are dropped first, which
	// keeps the table bounded without disturbing the busy clients.
	type entry struct {
		key  string
		last time.Time
	}
	all := make([]entry, 0, len(l.buckets))
	for key, b := range l.buckets {
		all = append(all, entry{key: key, last: b.last})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].last.Before(all[j].last) })
	for i := 0; i < len(all)-maxRateBuckets/2; i++ {
		delete(l.buckets, all[i].key)
	}
}

// rateLimitHandler throttles the requests of a rule per client address. It runs
// before the basic authentication check so a flood cannot burn the password
// hashing budget.
func (w *Web) rateLimitHandler(r *rule, next http.Handler) http.Handler {
	limiter := r.limiter
	if limiter == nil {
		return next
	}
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		client := clientIPString(req, w.trustProxy(w.cfg))
		ok, retry := limiter.allow(client)
		if ok {
			next.ServeHTTP(rw, req)
			return
		}
		wait := int((retry + time.Second - 1) / time.Second)
		if wait < 1 {
			wait = 1
		}
		w.noteRateLimited(r, req, client)
		rw.Header().Set("Retry-After", strconv.Itoa(wait))
		http.Error(rw, rateLimitMessage, http.StatusTooManyRequests)
	})
}

// noteRateLimited counts and logs a request refused by the rate limit.
func (w *Web) noteRateLimited(r *rule, req *http.Request, client string) {
	w.countersMu.Lock()
	w.rateLimited++
	w.countersMu.Unlock()
	w.logger().Warn("web：请求触发限速",
		"rule", r.name, "client", client, "method", req.Method, "path", req.URL.Path,
		"limitPerSec", r.spec.Proxy.RateLimitPerSec)
}

// ---------------------------------------------------------------------------
// request body limit
// ---------------------------------------------------------------------------

// bodyTooLargeError marks a request body that hit the configured cap. It is
// reported to the reverse proxy so the answer is a 413 and not an upstream
// failure.
type bodyTooLargeError struct {
	limit int64
}

func (e *bodyTooLargeError) Error() string {
	return "request body exceeds the configured limit of " + strconv.FormatInt(e.limit, 10) + " bytes"
}

// cappedBody limits how much of a request body reaches the upstream. It wraps
// the reader of http.MaxBytesReader so an overflow is recognisable by the
// reverse proxy error handler instead of surfacing as "connection broken".
type cappedBody struct {
	rc     io.ReadCloser
	limit  int64
	onFull func()
	// hit is written by the goroutine that reads the body and read by the one
	// that reports the failure, so it is atomic.
	hit atomic.Bool
}

func (c *cappedBody) Read(p []byte) (int, error) {
	n, err := c.rc.Read(p)
	if err != nil && c.markFull(err) {
		return n, &bodyTooLargeError{limit: c.limit}
	}
	return n, err
}

func (c *cappedBody) Close() error { return c.rc.Close() }

// markFull records the overflow exactly once and reports whether err is the
// overflow of the configured cap.
func (c *cappedBody) markFull(err error) bool {
	if c.hit.Load() {
		return true
	}
	var tooLarge *http.MaxBytesError
	if !errors.As(err, &tooLarge) {
		return false
	}
	c.hit.Store(true)
	if c.onFull != nil {
		c.onFull()
	}
	return true
}

// bodyLimitHit reports whether a failed upstream request was caused by the
// request body cap.
func bodyLimitHit(req *http.Request, err error) bool {
	var tooLarge *bodyTooLargeError
	if errors.As(err, &tooLarge) {
		return true
	}
	if req != nil {
		if body, ok := req.Body.(*cappedBody); ok && body.hit.Load() {
			return true
		}
	}
	return false
}

// capRequestBody applies the body limit of a proxy rule. It reports whether the
// request may be forwarded; when it may not, a 413 answer has already been
// written. The body itself is never buffered: the limit is enforced while the
// upstream reads it.
func (w *Web) capRequestBody(rw http.ResponseWriter, r *rule, req *http.Request) bool {
	limit := r.maxBody
	if limit <= 0 {
		return true
	}
	if req.ContentLength > limit {
		w.noteBodyRejected(r, req, limit)
		http.Error(rw, bodyLimitMessage, http.StatusRequestEntityTooLarge)
		return false
	}
	if req.Body == nil || req.Body == http.NoBody {
		return true
	}
	req.Body = &cappedBody{
		rc:     http.MaxBytesReader(underlyingWriter(rw), req.Body, limit),
		limit:  limit,
		onFull: func() { w.noteBodyRejected(r, req, limit) },
	}
	return true
}

// noteBodyRejected counts and logs one oversized request body.
func (w *Web) noteBodyRejected(r *rule, req *http.Request, limit int64) {
	w.countersMu.Lock()
	w.bodyRejected++
	w.countersMu.Unlock()
	w.logger().Warn("web：请求体被拒绝",
		"rule", r.name, "method", req.Method, "path", req.URL.Path, "limit", limit)
}
