package web

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/testutil"
)

// TestStripCookieKeepsOtherCookies checks the outbound filter that keeps the
// admin session cookie away from upstreams.
func TestStripCookieKeepsOtherCookies(t *testing.T) {
	h := http.Header{}
	h.Set("Cookie", "app=1; nunt_session=secret; theme=dark")
	stripCookie(h, security.SessionCookieName)
	if got := h.Get("Cookie"); got != "app=1; theme=dark" {
		t.Fatalf("Cookie = %q, want %q", got, "app=1; theme=dark")
	}
}

func TestStripCookieRemovesOnlyCookie(t *testing.T) {
	h := http.Header{}
	h.Set("Cookie", "nunt_session=secret")
	stripCookie(h, security.SessionCookieName)
	if got := h.Values("Cookie"); len(got) != 0 {
		t.Fatalf("Cookie header survived: %v", got)
	}
}

func TestStripCookieLeavesOtherRequestsAlone(t *testing.T) {
	h := http.Header{}
	h.Set("Cookie", "app=1; theme=dark")
	stripCookie(h, security.SessionCookieName)
	if got := h.Get("Cookie"); got != "app=1; theme=dark" {
		t.Fatalf("Cookie = %q, want it untouched", got)
	}

	empty := http.Header{}
	stripCookie(empty, security.SessionCookieName)
	if got := empty.Values("Cookie"); len(got) != 0 {
		t.Fatalf("empty header gained a Cookie value: %v", got)
	}
}

func TestStripCookieIsCaseInsensitive(t *testing.T) {
	h := http.Header{}
	h.Set("Cookie", "NUNT_SESSION=secret; app=1")
	stripCookie(h, security.SessionCookieName)
	if got := h.Get("Cookie"); got != "app=1" {
		t.Fatalf("Cookie = %q, want %q", got, "app=1")
	}
}

// TestAuthThrottleBudget pins the five failures per minute budget.
func TestAuthThrottleBudget(t *testing.T) {
	now := time.Unix(1700000000, 0)
	th := newAuthThrottle()
	th.now = func() time.Time { return now }
	key := "rule|192.0.2.1"

	for i := 0; i < basicAuthMaxFailures-1; i++ {
		if allowed, _ := th.allow(key); !allowed {
			t.Fatalf("attempt %d blocked too early", i+1)
		}
		th.fail(key)
	}
	if allowed, _ := th.allow(key); !allowed {
		t.Fatal("the fifth attempt must still be allowed")
	}
	th.fail(key)

	allowed, wait := th.allow(key)
	if allowed {
		t.Fatal("attempts must be blocked after the budget is spent")
	}
	if wait <= 0 || wait > basicAuthFailWindow {
		t.Fatalf("wait = %v, want a positive value within the window", wait)
	}

	now = now.Add(basicAuthFailWindow)
	if allowed, _ := th.allow(key); !allowed {
		t.Fatal("the block must end when the window is over")
	}
}

// TestAuthThrottleBounds keeps the failure table finite when a flood of
// distinct addresses arrives.
func TestAuthThrottleBounds(t *testing.T) {
	now := time.Unix(1700000000, 0)
	th := newAuthThrottle()
	th.now = func() time.Time { return now }
	for i := 0; i < basicAuthThrottleMax+100; i++ {
		th.fail(fmt.Sprintf("rule|192.0.2.%d", i))
	}
	if got := len(th.entries); got > basicAuthThrottleMax {
		t.Fatalf("throttle table grew to %d entries, want at most %d", got, basicAuthThrottleMax)
	}
}

// TestBasicAuthHandlerThrottles drives the real handler: five wrong passwords
// are answered with 401 and the next attempt with 429, even with the correct
// password.
func TestBasicAuthHandlerThrottles(t *testing.T) {
	hash := testutil.PasswordHash("correct horse")
	w := &Web{
		log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		cfg:          &model.Config{},
		authThrottle: newAuthThrottle(),
		authCache:    newBasicAuthCache(),
	}
	frozen := time.Unix(1700000000, 0)
	w.authThrottle.now = func() time.Time { return frozen }

	r := &rule{
		id:   "rule-1",
		name: "site",
		spec: &model.WebRule{
			Name: "site",
			BasicAuth: &model.BasicAuth{
				Enable: true,
				Users:  []model.BasicAuthUser{{Username: "alice", Password: hash}},
			},
		},
	}
	next := http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(http.StatusOK)
	})
	h := w.basicAuthHandler(r, next)

	do := func(password string) int {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.SetBasicAuth("alice", password)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr.Code
	}

	for i := 0; i < basicAuthMaxFailures; i++ {
		if code := do("wrong"); code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i+1, code)
		}
	}
	if code := do("wrong"); code != http.StatusTooManyRequests {
		t.Fatalf("blocked attempt: status = %d, want 429", code)
	}
	if code := do("correct horse"); code != http.StatusTooManyRequests {
		t.Fatalf("correct password while blocked: status = %d, want 429", code)
	}

	frozen = frozen.Add(basicAuthFailWindow)
	if code := do("correct horse"); code != http.StatusOK {
		t.Fatalf("after the window: status = %d, want 200", code)
	}
}
