package web

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/security"
)

// Failed basic auth budget of one client address on one rule: five wrong
// passwords inside a minute block further attempts until that minute is over.
const (
	basicAuthMaxFailures = 5
	basicAuthFailWindow  = time.Minute
	// basicAuthSweepAt bounds the memory of the throttle table; expired
	// entries are dropped once it grows past this many keys.
	basicAuthSweepAt = 1024
	// basicAuthThrottleMax caps the table. A distributed attack (or a spoofed
	// X-Forwarded-For chain) can present far more addresses than this; new
	// keys are then not tracked, which is no worse than the earlier behaviour
	// and keeps the process memory bounded.
	basicAuthThrottleMax = 8192
)

// authThrottle counts failed basic authentication attempts per key (rule and
// client address) inside a fixed window, so an unauthenticated caller cannot
// keep guessing passwords or keep the Argon2 slot busy.
type authThrottle struct {
	mu        sync.Mutex
	entries   map[string]*authThrottleEntry
	now       func() time.Time
	lastSweep time.Time
}

type authThrottleEntry struct {
	fails        int
	windowStart  time.Time
	blockedUntil time.Time
}

func newAuthThrottle() *authThrottle {
	return &authThrottle{entries: map[string]*authThrottleEntry{}, now: time.Now}
}

// allow reports whether key may attempt a password now and, when it may not,
// how long the caller has to wait.
func (t *authThrottle) allow(key string) (bool, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	e, ok := t.entries[key]
	if !ok {
		return true, 0
	}
	if now.Before(e.blockedUntil) {
		return false, e.blockedUntil.Sub(now)
	}
	if now.Sub(e.windowStart) >= basicAuthFailWindow {
		delete(t.entries, key)
	}
	return true, 0
}

// fail records one wrong password and starts the block when the budget of the
// current window is exhausted.
func (t *authThrottle) fail(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	e, ok := t.entries[key]
	if !ok || now.Sub(e.windowStart) >= basicAuthFailWindow {
		if !ok && len(t.entries) >= basicAuthThrottleMax {
			// The table is full: drop expired entries first, and if there are
			// none, stop tracking new keys instead of growing without bound.
			t.maybeSweepLocked(now)
			if len(t.entries) >= basicAuthThrottleMax {
				return
			}
		}
		e = &authThrottleEntry{windowStart: now}
		t.entries[key] = e
	}
	e.fails++
	if e.fails >= basicAuthMaxFailures {
		e.blockedUntil = e.windowStart.Add(basicAuthFailWindow)
	}
	t.maybeSweepLocked(now)
}

// maybeSweepLocked removes expired entries when the table is large. The sweep
// is rate limited: it is O(size), and running it on every failure of a flood
// would turn the table itself into the bottleneck.
func (t *authThrottle) maybeSweepLocked(now time.Time) {
	if len(t.entries) <= basicAuthSweepAt {
		return
	}
	if now.Sub(t.lastSweep) < time.Second {
		return
	}
	t.lastSweep = now
	t.sweepLocked(now)
}

// reset forgets the failures of a key after a successful authentication.
func (t *authThrottle) reset(key string) {
	t.mu.Lock()
	delete(t.entries, key)
	t.mu.Unlock()
}

// sweepLocked drops entries whose window is over. It runs rarely, only when
// the table grew past the threshold.
func (t *authThrottle) sweepLocked(now time.Time) {
	for key, e := range t.entries {
		if now.Before(e.blockedUntil) {
			continue
		}
		if now.Sub(e.windowStart) >= basicAuthFailWindow {
			delete(t.entries, key)
		}
	}
}

// clientIPString renders the caller address for logging and balancing. The
// X-Forwarded-For header is only honoured when the administrator declared a
// trusted proxy in front of the service.
func clientIPString(r *http.Request, trustProxy bool) string {
	ip := netutil.ClientIP(r, trustProxy)
	if ip == nil {
		return ""
	}
	return ip.String()
}

// accessHandler enforces the IP and User-Agent filter of a rule.
func (w *Web) accessHandler(r *rule, next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		trustProxy := w.trustProxy(w.cfg)
		ip := netutil.ClientIP(req, trustProxy)
		allowed, reason := r.filter.Allowed(ip)
		if !allowed {
			noteFrom(req.Context()).setReason("ip:" + reason)
			w.logger().Warn("web：客户端被 IP 过滤拒绝", "rule", r.name, "mode", r.spec.Access.Mode, "ip", ipString(ip), "reason", reason)
			http.Error(rw, "forbidden", http.StatusForbidden)
			return
		}
		if !netutil.UAAllowed(r.spec.Access.UAMode, r.spec.Access.UAs, req.UserAgent()) {
			noteFrom(req.Context()).setReason("ua")
			w.logger().Warn("web：客户端被 User-Agent 过滤拒绝", "rule", r.name, "mode", r.spec.Access.UAMode, "ua", req.UserAgent())
			http.Error(rw, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(rw, req)
	})
}

func ipString(ip net.IP) string {
	if ip == nil {
		return ""
	}
	return ip.String()
}

// basicAuthHandler guards a rule with HTTP basic authentication. Failed
// attempts are throttled per client address and rule, successful credentials
// are remembered for a minute (browsers resend them for every asset), and
// every real verification waits for the global password slot so a burst cannot
// allocate one hash buffer per request. Every configured user is verified
// without an early exit and the password check itself compares the derived key
// in constant time.
func (w *Web) basicAuthHandler(r *rule, next http.Handler) http.Handler {
	users := r.spec.BasicAuth.Users
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		ip := clientIPString(req, w.trustProxy(w.cfg))
		key := r.id + "|" + ip
		if allowed, wait := w.authThrottle.allow(key); !allowed {
			w.rejectBasicAuthThrottled(rw, req, r, ip, wait)
			return
		}
		username, password, ok := req.BasicAuth()
		if ok {
			user, known := findAuthUser(users, username)
			cacheKey := ""
			if known {
				cacheKey = w.authCache.key(r.id, user.Username, user.Password, password)
				if w.authCache.get(cacheKey) {
					w.authThrottle.reset(key)
					next.ServeHTTP(rw, req)
					return
				}
			}
			release, err := security.AcquirePasswordSlot(req.Context())
			if err != nil {
				// Client gone or server stopping: answer instead of the empty
				// 200 a bare return would send.
				http.Error(rw, "service unavailable", http.StatusServiceUnavailable)
				return
			}
			// Re-check after queueing: a request that waited behind a burst may
			// be over the limit already and must not burn a hash.
			allowed, wait := w.authThrottle.allow(key)
			granted := allowed && verifyUserHeld(users, username, password)
			release()
			if granted {
				w.authCache.put(cacheKey)
				w.authThrottle.reset(key)
				next.ServeHTTP(rw, req)
				return
			}
			if !allowed {
				w.rejectBasicAuthThrottled(rw, req, r, ip, wait)
				return
			}
			w.authThrottle.fail(key)
			noteFrom(req.Context()).setReason("basic-auth")
			w.logger().Warn("web：基本认证失败", "rule", r.name, "user", username, "ip", ip)
		}
		realm := r.spec.Name
		if realm == "" {
			realm = "restricted"
		}
		rw.Header().Set("WWW-Authenticate", fmt.Sprintf("Basic realm=%q, charset=\"UTF-8\"", realm))
		http.Error(rw, "unauthorized", http.StatusUnauthorized)
	})
}

// rejectBasicAuthThrottled answers a client that exceeded the failed login
// budget of a rule. The response is a plain 429 with Retry-After so clients
// (and the access log) can tell it apart from a wrong password.
func (w *Web) rejectBasicAuthThrottled(rw http.ResponseWriter, req *http.Request, r *rule, ip string, wait time.Duration) {
	seconds := int(wait.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	noteFrom(req.Context()).setReason("basic-auth-limit")
	w.logger().Warn("web：基本认证尝试过于频繁", "rule", r.name, "ip", ip,
		"retryAfter", wait.Round(time.Second).String())
	rw.Header().Set("Retry-After", strconv.Itoa(seconds))
	http.Error(rw, "too many authentication attempts", http.StatusTooManyRequests)
}

// verifyUserHeld checks the credentials against every configured user. The
// caller must hold the global password slot (see security.AcquirePasswordSlot).
func verifyUserHeld(users []model.BasicAuthUser, username, password string) bool {
	granted := false
	matched := false
	for i := range users {
		u := users[i]
		if subtle.ConstantTimeCompare([]byte(u.Username), []byte(username)) == 1 {
			matched = true
			if u.Password != "" && security.VerifyPasswordHeld(u.Password, password) {
				granted = true
			}
		}
	}
	// Run one dummy verification when no user matched to keep the timing of
	// unknown users close to the timing of a wrong password.
	if !matched {
		_ = security.VerifyPasswordHeld(dummyHash, password)
	}
	return granted
}

// dummyHash is a valid argon2id hash of a random value; it is only used to
// equalise the response time of unknown user names.
const dummyHash = "$argon2id$v=19$m=65536,t=2,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// wafHandler wraps a site with the WAF engine when the rule enables it.
func (w *Web) wafHandler(r *rule, next http.Handler) http.Handler {
	if !r.spec.WAF || w.waf == nil {
		return next
	}
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				w.logger().Error("web：WAF 中间件发生 panic", "rule", r.name, "panic", rec)
				http.Error(rw, "internal server error", http.StatusInternalServerError)
			}
		}()
		w.waf.Middleware(r.name, next).ServeHTTP(rw, req)
	})
}

// hstsHandler adds the Strict-Transport-Security header of a rule.
func (w *Web) hstsHandler(r *rule, next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		rw.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(rw, req)
	})
}
