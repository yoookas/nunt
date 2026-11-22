package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/module"
)

// fakeChallenge is a stand in for the ACME module: it answers the well known
// http-01 path, which is all the router has to know about.
type fakeChallenge struct {
	module.Base
	served int
}

func (f *fakeChallenge) Start(context.Context) error { return nil }
func (f *fakeChallenge) Stop(context.Context) error  { return nil }

func (f *fakeChallenge) ServeChallenge(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, acmeChallengePath) {
		return false
	}
	f.served++
	_, _ = w.Write([]byte("token-answer"))
	return true
}

// The web listener must answer an in flight http-01 challenge even though the
// path matches no web rule: the CA only connects to port 80, which this
// listener may own.
func TestRouterServesACMEChallenge(t *testing.T) {
	store := testConfigStore(t)
	deps := testDeps(t, store)
	fake := &fakeChallenge{}
	fake.Init(deps, "acme", "Certificates")
	if err := deps.Registry.Register(fake); err != nil {
		t.Fatalf("register the acme stand in: %v", err)
	}
	rt := newRouter(New(deps), "127.0.0.1:0")

	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://example.com"+acmeChallengePath+"tok", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "token-answer" {
		t.Fatalf("challenge = %d %q", rec.Code, rec.Body.String())
	}
	if fake.served != 1 {
		t.Fatalf("the challenge module was called %d times", fake.served)
	}

	// An unrelated path still goes through the normal routing (no matcher is
	// installed in this test, so it reports the service as unavailable).
	other := httptest.NewRecorder()
	rt.ServeHTTP(other, httptest.NewRequest(http.MethodGet, "http://example.com/other", nil))
	if other.Code != http.StatusServiceUnavailable {
		t.Fatalf("unrelated path = %d, want 503", other.Code)
	}
}
