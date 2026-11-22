package acme

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"golang.org/x/crypto/acme"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/model"
)

// A renewal window wider than the certificate lifetime would make every check
// renew the certificate and burn the CA rate limit.
func TestRenewWindowIsCapped(t *testing.T) {
	cfg := &model.Config{ACME: model.ACMEConfig{Jobs: []model.CertJob{
		{Enable: true, RenewDays: 365},
	}}}
	if got, want := renewWindow(cfg), time.Duration(maxRenewDays)*24*time.Hour; got != want {
		t.Fatalf("renewWindow = %v, want %v", got, want)
	}
	if maxRenewDays > 30 {
		t.Fatalf("maxRenewDays = %d, want at most 30", maxRenewDays)
	}
}

// The web service answers http-01 tokens through this method while a challenge
// is being validated.
func TestServeChallengeAnswersOnlyActiveTokens(t *testing.T) {
	a := &ACME{}
	path := "/.well-known/acme-challenge/token-1"
	a.challenges.Store(path, "key-auth-1")

	rec := httptest.NewRecorder()
	if !a.ServeChallenge(rec, httptest.NewRequest("GET", path, nil)) {
		t.Fatal("an active token was not served")
	}
	if rec.Code != 200 || rec.Body.String() != "key-auth-1" {
		t.Fatalf("serve = %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("content type = %q", got)
	}

	other := httptest.NewRecorder()
	if a.ServeChallenge(other, httptest.NewRequest("GET", "/.well-known/acme-challenge/unknown", nil)) {
		t.Fatal("an unknown token was served")
	}

	a.challenges.Delete(path)
	gone := httptest.NewRecorder()
	if a.ServeChallenge(gone, httptest.NewRequest("GET", path, nil)) {
		t.Fatal("a finished challenge was still served")
	}
}

// The tls-alpn-01 answer is only offered while a challenge is in flight, and
// only to a handshake that carries the acme-tls/1 protocol.
func TestALPNChallengeConfigAnswersOnlyActiveChallenges(t *testing.T) {
	a := &ACME{}
	cert := &tls.Certificate{}
	a.alpnCerts.Store("a.example.com", cert)

	hello := &tls.ClientHelloInfo{ServerName: "A.Example.com.", SupportedProtos: []string{"acme-tls/1"}}
	cfg, ok := a.ALPNChallengeConfig(hello)
	if !ok || cfg == nil || len(cfg.Certificates) != 1 || len(cfg.NextProtos) != 1 || cfg.NextProtos[0] != acme.ALPNProto {
		t.Fatalf("active challenge not offered: %+v %v", cfg, ok)
	}

	if _, ok := a.ALPNChallengeConfig(&tls.ClientHelloInfo{ServerName: "b.example.com", SupportedProtos: []string{"acme-tls/1"}}); ok {
		t.Fatal("a challenge was offered for an unrelated domain")
	}
	if _, ok := a.ALPNChallengeConfig(&tls.ClientHelloInfo{ServerName: "a.example.com", SupportedProtos: []string{"h2"}}); ok {
		t.Fatal("a challenge was offered without the acme-tls/1 protocol")
	}

	a.alpnCerts.Delete("a.example.com")
	if _, ok := a.ALPNChallengeConfig(hello); ok {
		t.Fatal("a finished challenge was still offered")
	}
}

// A certificate issued on demand has no configured job, but it must still be
// renewed: its synthetic job id is recognised and renewed with the defaults it
// was issued with. Certificates uploaded by hand stay untouched.
func TestRenewalJobCoversOnDemandCertificates(t *testing.T) {
	cfg := &model.Config{}
	info := certs.Info{
		Source:  "acme",
		JobID:   onDemandJobPrefix + "example.com",
		Domains: []string{"example.com", "www.example.com"},
	}
	job, ok := renewalJob(cfg, info)
	if !ok {
		t.Fatal("an on demand certificate is not renewed")
	}
	if job.ID != info.JobID || job.Challenge == "" || len(job.Domains) != 2 {
		t.Fatalf("synthetic job = %+v", job)
	}

	if _, ok := renewalJob(cfg, certs.Info{Source: "manual"}); ok {
		t.Fatal("a certificate uploaded by hand must not be renewed")
	}

	cfg.ACME.Jobs = []model.CertJob{{ID: "job-1", Enable: false, Domains: []string{"a.example.com"}}}
	if _, ok := renewalJob(cfg, certs.Info{Source: "acme", JobID: "job-1"}); ok {
		t.Fatal("a disabled job must not be renewed")
	}
	cfg.ACME.Jobs[0].Enable = true
	job, ok = renewalJob(cfg, certs.Info{Source: "acme", JobID: "job-1"})
	if !ok || job.ID != "job-1" {
		t.Fatalf("configured job = %+v, %v", job, ok)
	}
}

// A job that keeps failing must not notify on every retry: the first failure
// is announced, then at most once per failureNotifyInterval.
func TestRecordFailureThrottlesNotifications(t *testing.T) {
	a := &ACME{attempts: map[string]*attempt{}}
	if !a.recordFailure("job-1", errors.New("boom")) {
		t.Fatal("the first failure was not announced")
	}
	if a.recordFailure("job-1", errors.New("boom")) {
		t.Fatal("the second failure was announced again")
	}
	a.schedMu.Lock()
	a.attempts["job-1"].notified = time.Now().Add(-failureNotifyInterval - time.Minute)
	a.schedMu.Unlock()
	if !a.recordFailure("job-1", errors.New("boom")) {
		t.Fatal("a failure after the interval was not announced")
	}
}

// The number of concurrent orders is bounded, so a batch of due certificates
// cannot all hit the CA at once.
func TestIssueSlotsAreBounded(t *testing.T) {
	a := &ACME{issueSem: make(chan struct{}, 1)}
	if err := a.acquireIssue(context.Background()); err != nil {
		t.Fatalf("first slot: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := a.acquireIssue(ctx); err == nil {
		t.Fatal("a second order was admitted past the bound")
	}
	a.releaseIssue()
	if err := a.acquireIssue(context.Background()); err != nil {
		t.Fatalf("the slot was not released: %v", err)
	}
}

// Only certificates inside their own renewal window are scheduled, and manual
// certificates never enter the queue.
func TestJobsDueThreshold(t *testing.T) {
	now := time.Now()
	cfg := &model.Config{ACME: model.ACMEConfig{Jobs: []model.CertJob{
		{ID: "j1", Enable: true, Domains: []string{"a.example.com"}, RenewDays: 30},
	}}}
	infos := []certs.Info{
		{ID: "j1", Source: "acme", JobID: "j1", Domains: []string{"a.example.com"}, NotAfter: now.Add(10 * 24 * time.Hour)},
		{ID: "j2", Source: "acme", JobID: "j1", Domains: []string{"b.example.com"}, NotAfter: now.Add(60 * 24 * time.Hour)},
		{ID: "manual", Source: "manual", Domains: []string{"c.example.com"}, NotAfter: now.Add(time.Hour)},
		{ID: "on-demand", Source: "acme", JobID: "on-demand-x", Domains: []string{"d.example.com"}, NotAfter: now.Add(5 * 24 * time.Hour)},
	}
	jobs := jobsDue(cfg, infos, now)
	if len(jobs) != 2 {
		t.Fatalf("jobs due = %d, want the configured and the on demand certificate", len(jobs))
	}
	for _, job := range jobs {
		if job.ID == "manual" {
			t.Fatal("a manual certificate was scheduled")
		}
	}
}
