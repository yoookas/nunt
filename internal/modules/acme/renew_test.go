package acme

import (
	"net/http/httptest"
	"testing"
	"time"

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
