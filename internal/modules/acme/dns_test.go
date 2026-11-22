package acme

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
)

// TestChallengeRecordName pins the dns-01 TXT record name: the prefix is
// always added to the bare domain, including for wildcard certificates.
func TestChallengeRecordName(t *testing.T) {
	cases := map[string]string{
		"example.com":         "_acme-challenge.example.com",
		"Example.COM":         "_acme-challenge.example.com",
		"example.com.":        "_acme-challenge.example.com",
		"*.example.com":       "_acme-challenge.example.com",
		"www.example.com":     "_acme-challenge.www.example.com",
		"*.sub.example.com.":  "_acme-challenge.sub.example.com",
		"a.b.c.example.co.uk": "_acme-challenge.a.b.c.example.co.uk",
	}
	for in, want := range cases {
		got, err := challengeRecordName(in)
		if err != nil {
			t.Fatalf("challengeRecordName(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("challengeRecordName(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "   ", ".", "*."} {
		if got, err := challengeRecordName(bad); err == nil {
			t.Fatalf("challengeRecordName(%q) = %q, want an error", bad, got)
		}
	}
}

// TestNormalizeResolvers checks that DNS server addresses always carry a port.
func TestNormalizeResolvers(t *testing.T) {
	got := normalizeResolvers([]string{"1.1.1.1", "8.8.8.8:5353", "  ", "[2001:4860:4860::8888]:53"})
	want := []string{"1.1.1.1:53", "8.8.8.8:5353", "[2001:4860:4860::8888]:53"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeResolvers = %v, want %v", got, want)
	}
	if got := normalizeResolvers(nil); len(got) != 0 {
		t.Fatalf("normalizeResolvers(nil) = %v, want an empty slice", got)
	}
}

// TestDefaultResolversAreUsable makes sure every built in resolver is a valid
// host:port address.
func TestDefaultResolversAreUsable(t *testing.T) {
	if len(defaultDNSResolvers) == 0 {
		t.Fatal("no default DNS resolver configured")
	}
	for _, server := range defaultDNSResolvers {
		if !strings.Contains(server, ":") {
			t.Fatalf("default resolver %q has no port", server)
		}
	}
	if dnsWaitWindow <= 0 || dnsPollInterval <= 0 || dnsQueryTimeout <= 0 {
		t.Fatal("the dns-01 timings must be positive")
	}
	if dnsPollInterval > dnsWaitWindow {
		t.Fatal("the poll interval must be shorter than the wait window")
	}
}

// TestDescribeAnswers checks the error rendering of the propagation report.
func TestDescribeAnswers(t *testing.T) {
	if got := describeAnswers(nil); got != "none" {
		t.Fatalf("describeAnswers(nil) = %q, want %q", got, "none")
	}
	got := describeAnswers(map[string]string{"1.1.1.1:53": "abc", "8.8.8.8:53": "error: timeout"})
	want := "1.1.1.1:53=abc; 8.8.8.8:53=error: timeout"
	if got != want {
		t.Fatalf("describeAnswers = %q, want %q", got, want)
	}
}

// TestDomainsKeyIsStable makes sure the single flight key ignores order, case
// and duplicates.
func TestDomainsKeyIsStable(t *testing.T) {
	a := domainsKey([]string{"www.example.com", "example.com", "example.com"})
	b := domainsKey([]string{"EXAMPLE.com", "WWW.example.com.", " example.com "})
	if a != b {
		t.Fatalf("domainsKey is not stable: %q vs %q", a, b)
	}
	if a != "example.com,www.example.com" {
		t.Fatalf("domainsKey = %q, want %q", a, "example.com,www.example.com")
	}
	if domainsKey(nil) != "" {
		t.Fatalf("domainsKey(nil) = %q, want an empty key", domainsKey(nil))
	}
}

// TestCoversAll covers the set comparison used by the single flight lookup.
func TestCoversAll(t *testing.T) {
	if !coversAll([]string{"example.com", "www.example.com"}, []string{"WWW.example.com"}) {
		t.Fatal("coversAll(..., WWW.example.com) = false, want true")
	}
	if coversAll([]string{"example.com"}, []string{"other.com"}) {
		t.Fatal("coversAll returned true for a domain that is not in the set")
	}
	if coversAll([]string{"example.com"}, nil) {
		t.Fatal("coversAll(..., nil) = true, want false")
	}
}

// TestMatchJob checks that EnsureCertificate reuses a configured job.
func TestMatchJob(t *testing.T) {
	cfg := &model.Config{ACME: model.ACMEConfig{Jobs: []model.CertJob{
		{ID: "a", Enable: true, Domains: []string{"example.com", "www.example.com"}},
		{ID: "b", Enable: false, Domains: []string{"disabled.com"}},
	}}}
	if job, ok := matchJob(cfg, []string{"www.example.com", "example.com"}); !ok || job.ID != "a" {
		t.Fatalf("matchJob returned %q/%v, want job a", job.ID, ok)
	}
	if _, ok := matchJob(cfg, []string{"disabled.com"}); ok {
		t.Fatal("matchJob matched a disabled job")
	}
	if _, ok := matchJob(cfg, nil); ok {
		t.Fatal("matchJob(nil domains) matched a job")
	}
	if findJob(cfg, "b") == nil {
		t.Fatal("findJob(b) = nil")
	}
	if findJob(cfg, "missing") != nil {
		t.Fatal("findJob(missing) != nil")
	}
}

// TestRenewWindowFollowsTheLargestJob checks the DueForRenew window.
func TestRenewWindowFollowsTheLargestJob(t *testing.T) {
	cfg := &model.Config{ACME: model.ACMEConfig{Jobs: []model.CertJob{
		{ID: "a", Enable: true, RenewDays: 10},
		{ID: "b", Enable: true, RenewDays: 20},
		{ID: "c", Enable: false, RenewDays: 90},
	}}}
	// The default window equals the cap, so a smaller per job value never widens
	// it; the per job value only narrows the re-check window in checkDue.
	if got, want := renewWindow(cfg), defaultRenewDays*24*time.Hour; got != want {
		t.Fatalf("renewWindow = %v, want %v", got, want)
	}
	// A window above the cap is clamped: a 90 day certificate would otherwise be
	// renewed on every check.
	capped := &model.Config{ACME: model.ACMEConfig{Jobs: []model.CertJob{
		{ID: "d", Enable: true, RenewDays: 90},
	}}}
	if got, want := renewWindow(capped), maxRenewDays*24*time.Hour; got != want {
		t.Fatalf("capped renewWindow = %v, want %v", got, want)
	}
	if got, want := renewWindow(nil), defaultRenewDays*24*time.Hour; got != want {
		t.Fatalf("renewWindow(nil) = %v, want %v", got, want)
	}
}

// TestBackoff pins the retry delay growth: 1h, 2h, 4h and then a 6h ceiling.
func TestBackoff(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, time.Hour},
		{1, time.Hour},
		{2, 2 * time.Hour},
		{3, 4 * time.Hour},
		{4, 6 * time.Hour},
		{10, 6 * time.Hour},
	}
	for _, tc := range cases {
		if got := backoff(tc.attempt); got != tc.want {
			t.Fatalf("backoff(%d) = %v, want %v", tc.attempt, got, tc.want)
		}
	}
	if backoff(100) > retryMax {
		t.Fatalf("backoff(100) = %v, want at most %v", backoff(100), retryMax)
	}
}

// TestNormalizeChallengeAcceptsBothForms covers the challenge parser.
func TestNormalizeChallengeAcceptsBothForms(t *testing.T) {
	cases := map[string]string{
		"":            challengeHTTP,
		"http":        challengeHTTP,
		"http-01":     challengeHTTP,
		"HTTP-01":     challengeHTTP,
		" dns ":       challengeDNS,
		"dns-01":      challengeDNS,
		"tls":         challengeTLSALPN,
		"tls-alpn-01": challengeTLSALPN,
	}
	for in, want := range cases {
		got, err := normalizeChallenge(in)
		if err != nil {
			t.Fatalf("normalizeChallenge(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("normalizeChallenge(%q) = %q, want %q", in, got, want)
		}
		wire, err := wireChallenge(got)
		if err != nil {
			t.Fatalf("wireChallenge(%q): %v", got, err)
		}
		if !strings.Contains(wire, "-01") {
			t.Fatalf("wireChallenge(%q) = %q, want an RFC 8555 name", got, wire)
		}
	}
	if _, err := normalizeChallenge("dns-02"); err == nil {
		t.Fatal("normalizeChallenge(dns-02) succeeded, want an error")
	}
}

// TestRequestValidate checks the request level validation.
func TestRequestValidate(t *testing.T) {
	base := func() request {
		return request{
			jobID:     "job-1",
			domains:   []string{"example.com"},
			challenge: challengeHTTP,
			keyType:   keyEC256,
		}
	}

	req := base()
	if err := req.validate(nil); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(req.domains) != 1 || req.domains[0] != "example.com" {
		t.Fatalf("domains were not normalized: %v", req.domains)
	}

	wild := base()
	wild.domains = []string{"*.example.com"}
	if err := wild.validate(nil); err == nil {
		t.Fatal("a wildcard domain with the http-01 challenge was accepted")
	}
	wild.challenge = challengeDNS
	if err := wild.validate(nil); err == nil {
		t.Fatal("dns-01 without a provider was accepted")
	}
	wild.dnsProvider = "alidns"
	if err := wild.validate(nil); err != nil {
		t.Fatalf("dns-01 with a provider: %v", err)
	}

	bad := base()
	bad.challenge = "nope"
	if err := bad.validate(nil); err == nil {
		t.Fatal("an unknown challenge was accepted")
	}
	empty := base()
	empty.domains = nil
	if err := empty.validate(nil); err == nil {
		t.Fatal("an empty domain list was accepted")
	}
}

// TestValidateDomain rejects the inputs that must never reach the ACME server.
func TestValidateDomain(t *testing.T) {
	good := []string{"example.com", "www.example.com", "*.example.com", "_dmarc.example.com", "a-b.example.co.uk"}
	for _, d := range good {
		if err := validateDomain(d); err != nil {
			t.Fatalf("validateDomain(%q): %v", d, err)
		}
	}
	bad := []string{
		"",
		"localhost",
		"127.0.0.1",
		"example.com/../../etc/passwd",
		"exa mple.com",
		"exam\nple.com",
		"*.com",
		"*.*.example.com",
		"-bad.example.com",
		"bad-.example.com",
		"exa$mple.com",
	}
	for _, d := range bad {
		if err := validateDomain(d); err == nil {
			t.Fatalf("validateDomain(%q) succeeded, want an error", d)
		}
	}
}

// TestNormalizeDomains covers port stripping, case folding and duplicates.
func TestNormalizeDomains(t *testing.T) {
	got, err := normalizeDomains([]string{"Example.COM:443", "example.com", " *.WWW.example.com. ", ""})
	if err != nil {
		t.Fatalf("normalizeDomains: %v", err)
	}
	want := []string{"example.com", "*.www.example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeDomains = %v, want %v", got, want)
	}
	if _, err := normalizeDomains(nil); err == nil {
		t.Fatal("normalizeDomains(nil) succeeded, want an error")
	}
	if _, err := normalizeDomains([]string{"localhost"}); err == nil {
		t.Fatal("normalizeDomains(localhost) succeeded, want an error")
	}
}
