package web

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// fakeChallenge is a stand in for the ACME module: it answers the well known
// http-01 path, which is all the router has to know about.
type fakeChallenge struct {
	module.Base
	served int
	http   bool
	tls    bool
}

func (f *fakeChallenge) Start(context.Context) error { return nil }
func (f *fakeChallenge) Stop(context.Context) error  { return nil }

func (f *fakeChallenge) ServesHTTPChallenge() bool { return f.http }

func (f *fakeChallenge) ServesTLSChallenge() bool { return f.tls }

// ALPNChallengeConfig stands in for the ACME tls-alpn-01 answer.
func (f *fakeChallenge) ALPNChallengeConfig(hello *tls.ClientHelloInfo) (*tls.Config, bool) {
	if !f.tls || hello == nil || hello.ServerName != "a.example.com" {
		return nil, false
	}
	for _, proto := range hello.SupportedProtos {
		if proto == "acme-tls/1" {
			return &tls.Config{
				Certificates: []tls.Certificate{{}},
				NextProtos:   []string{"acme-tls/1"},
			}, true
		}
	}
	return nil, false
}

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
	fake := &fakeChallenge{http: true, tls: true}
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

// The TLS listeners answer a tls-alpn-01 handshake with the challenge
// certificate and leave every other handshake to the normal selection.
func TestTLSListenerAnswersALPNChallenge(t *testing.T) {
	store := testConfigStore(t)
	deps := testDeps(t, store)
	fake := &fakeChallenge{tls: true}
	fake.Init(deps, "acme", "Certificates")
	if err := deps.Registry.Register(fake); err != nil {
		t.Fatalf("register the acme stand in: %v", err)
	}
	w := New(deps)
	plan := &listenerPlan{addr: ":443", tls: listenerTLS{mode: model.TLSModeAuto}}
	cfg := w.tlsSetup(
		func() *matcher { return newMatcher(":443", nil, plan.tls) },
		func() *listenerPlan { return plan },
		&tls.Config{},
	)

	got, err := cfg.GetConfigForClient(&tls.ClientHelloInfo{
		ServerName:      "a.example.com",
		SupportedProtos: []string{"acme-tls/1"},
	})
	if err != nil {
		t.Fatalf("challenge handshake: %v", err)
	}
	if got == nil || len(got.Certificates) != 1 || len(got.NextProtos) != 1 || got.NextProtos[0] != "acme-tls/1" {
		t.Fatalf("the challenge was not offered: %+v", got)
	}

	other, err := cfg.GetConfigForClient(&tls.ClientHelloInfo{ServerName: "a.example.com"})
	if err != nil || other != nil {
		t.Fatalf("an ordinary handshake must fall through, got %+v %v", other, err)
	}
}
