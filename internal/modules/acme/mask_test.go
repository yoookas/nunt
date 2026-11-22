package acme

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/secret"
)

// TestMaskCreds checks that no credential value ever leaves the process.
func TestMaskCreds(t *testing.T) {
	if got := maskCreds(nil); len(got) != 0 {
		t.Fatalf("maskCreds(nil) = %v, want an empty map", got)
	}
	in := map[string]string{
		"token":  "supersecrettoken",
		"short":  "abc",
		"empty":  "",
		"sealed": "enc:v1:abcdef",
	}
	out := maskCreds(in)
	for k, v := range out {
		if v == in[k] && in[k] != "" {
			t.Fatalf("credential %q was returned unmasked: %q", k, v)
		}
		if !strings.Contains(v, "********") && v != "" {
			t.Fatalf("credential %q = %q, want a mask", k, v)
		}
	}
	if out["empty"] != "" {
		t.Fatalf("an empty credential must stay empty, got %q", out["empty"])
	}
	if out["sealed"] != "********" {
		t.Fatalf("a sealed credential must be fully masked, got %q", out["sealed"])
	}
	if in["token"] != "supersecrettoken" {
		t.Fatal("maskCreds modified the input map")
	}
}

// TestMergeCredsKeepsStoredValues is the rule that protects secrets on update.
func TestMergeCredsKeepsStoredValues(t *testing.T) {
	stored := map[string]string{
		"token": "enc:v1:stored-token",
		"zone":  "enc:v1:stored-zone",
	}

	// The UI posts back what it received: masked values must be preserved.
	got := mergeCreds(stored, map[string]string{
		"token": secret.Mask(stored["token"]),
		"zone":  "new-zone",
	})
	if got["token"] != stored["token"] {
		t.Fatalf("a masked token overwrote the stored value: %q", got["token"])
	}
	if got["zone"] != "new-zone" {
		t.Fatalf("a real value was not applied: %q", got["zone"])
	}

	// An empty value also keeps the stored one so a partial form cannot wipe it.
	got = mergeCreds(stored, map[string]string{"token": ""})
	if got["token"] != "" {
		t.Fatalf("an empty value = %q, want the field cleared", got["token"])
	}

	// A masked value without a stored counterpart cannot be recovered.
	got = mergeCreds(nil, map[string]string{"token": "********"})
	if got["token"] != "" {
		t.Fatalf("masked value without stored data = %q, want empty", got["token"])
	}

	// Unknown keys are copied as is.
	got = mergeCreds(stored, map[string]string{"fresh": "value"})
	if got["fresh"] != "value" {
		t.Fatalf("a new credential was dropped: %v", got)
	}
	if _, ok := got["token"]; ok {
		t.Fatal("mergeCreds invented a credential that was not submitted")
	}
}

// TestIsMasked covers the placeholder detection.
func TestIsMasked(t *testing.T) {
	for _, v := range []string{"********", "abc********xy", secret.Mask("supersecrettoken")} {
		if !isMasked(v) {
			t.Fatalf("isMasked(%q) = false, want true", v)
		}
	}
	for _, v := range []string{"", "plain", "tok*en"} {
		if isMasked(v) {
			t.Fatalf("isMasked(%q) = true, want false", v)
		}
	}
}

// TestJobViewMasksCredentials checks the API projection of a job.
func TestJobViewMasksCredentials(t *testing.T) {
	a := &ACME{}
	job := model.CertJob{
		ID:          "job-1",
		Name:        "example",
		Domains:     []string{"example.com", "www.example.com"},
		Challenge:   challengeDNS,
		DNSProvider: "alidns",
		DNSCreds:    map[string]string{"token": "enc:v1:secret"},
	}
	view := a.jobView(job)
	if !view.HasCreds {
		t.Fatal("HasCreds = false, want true")
	}
	if view.DNSCreds["token"] == "enc:v1:secret" {
		t.Fatal("the API view leaked the stored credential")
	}
	if view.DomainsJoined != "example.com, www.example.com" {
		t.Fatalf("DomainsJoined = %q", view.DomainsJoined)
	}
	if !reflect.DeepEqual(view.Domains, job.Domains) {
		t.Fatalf("Domains = %v, want %v", view.Domains, job.Domains)
	}

	empty := a.jobView(model.CertJob{ID: "job-2"})
	if empty.HasCreds {
		t.Fatal("HasCreds = true for a job without credentials")
	}
	if len(empty.DNSCreds) != 0 {
		t.Fatalf("DNSCreds = %v, want an empty map", empty.DNSCreds)
	}
}

// TestMissingDomains checks the certificate coverage report used before a
// certificate is stored.
func TestMissingDomains(t *testing.T) {
	sans := []string{"example.com", "*.example.com"}
	if got := missingDomains(sans, []string{"example.com", "www.example.com"}); len(got) != 0 {
		t.Fatalf("missingDomains = %v, want none", got)
	}
	got := missingDomains(sans, []string{"other.com"})
	if !reflect.DeepEqual(got, []string{"other.com"}) {
		t.Fatalf("missingDomains = %v, want [other.com]", got)
	}
	if !reflect.DeepEqual(missingDomains(nil, []string{"example.com"}), []string{"example.com"}) {
		t.Fatal("missingDomains(nil, ...) must report the domain as missing")
	}
}

// TestCoversAllKeepsCaseInsensitiveMatching pins the behaviour relied upon by
// HasCertificate and the single flight lookup.
func TestCoversAllKeepsCaseInsensitiveMatching(t *testing.T) {
	if !coversAll([]string{"Example.COM"}, []string{"example.com"}) {
		t.Fatal("coversAll must ignore the case of a domain")
	}
}

// TestDefaultChallengeIsHTTP01 documents the on demand default.
func TestDefaultChallengeIsHTTP01(t *testing.T) {
	if got := defaultChallenge(); got != challengeHTTP {
		t.Fatalf("defaultChallenge() = %q, want %q", got, challengeHTTP)
	}
	if d := defaultRenewDays; d != 30 {
		t.Fatalf("defaultRenewDays = %d, want 30", d)
	}
	if checkInterval != 12*time.Hour {
		t.Fatalf("checkInterval = %v, want 12h", checkInterval)
	}
}
