package dnsprov

import (
	"strings"
	"testing"
)

func TestRecordFQDN(t *testing.T) {
	cases := []struct {
		sub, domain, want string
	}{
		{"", "example.com", "example.com"},
		{"@", "example.com", "example.com"},
		{"www", "example.com", "www.example.com"},
		{"*", "example.com", "*.example.com"},
		{"_acme-challenge", "example.com", "_acme-challenge.example.com"},
		{"www", " example.com. ", "www.example.com"},
	}
	for _, tc := range cases {
		rec := Record{Domain: tc.domain, SubDomain: tc.sub}
		if got := rec.FQDN(); got != tc.want {
			t.Errorf("FQDN(sub=%q domain=%q) = %q, want %q", tc.sub, tc.domain, got, tc.want)
		}
	}
}

func TestRootDomainAndRecordName(t *testing.T) {
	rec := Record{Domain: "Example.com", SubDomain: "@"}
	if got := rootDomain(rec.Domain); got != "example.com" {
		t.Errorf("rootDomain = %q, want example.com", got)
	}
	if got := recordName(rec); got != "@" {
		t.Errorf("recordName = %q, want @", got)
	}
	if got := absoluteName(rec); got != "example.com" {
		t.Errorf("absoluteName = %q, want example.com", got)
	}
	rec = Record{Domain: "example.com", SubDomain: "www"}
	if got := absoluteName(rec); got != "www.example.com" {
		t.Errorf("absoluteName = %q, want www.example.com", got)
	}
}

func TestNormalizeTypeAndTTL(t *testing.T) {
	if got := normalizeType(" txt "); got != "TXT" {
		t.Errorf("normalizeType = %q, want TXT", got)
	}
	if got := normalizeType(""); got != "A" {
		t.Errorf("normalizeType(empty) = %q, want A", got)
	}
	if got := ttlOr(Record{TTL: 120}, 600); got != 120 {
		t.Errorf("ttlOr = %d, want 120", got)
	}
	if got := ttlOr(Record{}, 600); got != 600 {
		t.Errorf("ttlOr default = %d, want 600", got)
	}
}

func TestSanitizeRedactsSecrets(t *testing.T) {
	creds := Credentials{"token": "super-secret-value", "short": "ab"}
	text := "line1\n  line2 token=super-secret-value end"
	got := sanitize(text, creds, summaryLimit)
	if strings.Contains(got, "super-secret-value") {
		t.Fatalf("secret leaked: %q", got)
	}
	if strings.Contains(got, "\n") {
		t.Fatalf("newlines not collapsed: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("expected redaction marker in %q", got)
	}
}

func TestTruncateRunes(t *testing.T) {
	long := strings.Repeat("a", 300)
	if got := truncateRunes(long, 200); len(got) != 203 || !strings.HasSuffix(got, "...") {
		t.Fatalf("truncateRunes length = %d, want 203", len(got))
	}
	if got := truncateRunes("短", 10); got != "短" {
		t.Fatalf("truncateRunes short = %q", got)
	}
}

func TestSuccessText(t *testing.T) {
	cases := []struct {
		body   string
		tokens []string
		want   bool
	}{
		{"OK", []string{"OK"}, true},
		{"ok\n", []string{"OK"}, true},
		{"KO", []string{"OK"}, false},
		{"good 1.2.3.4", []string{"good", "nochg"}, true},
		{"nochg 1.2.3.4", []string{"good", "nochg"}, true},
		{"badauth", []string{"good"}, false},
		{"ERROR: Invalid update URL", []string{"Updated"}, false},
		{"Updated 1.2.3.4", []string{"Updated"}, true},
		{"No change", []string{"Updated", "No change"}, true},
		{"", []string{"OK"}, false},
		{"forbidden", []string{"ok"}, false},
	}
	for _, tc := range cases {
		if got := successText(tc.body, tc.tokens); got != tc.want {
			t.Errorf("successText(%q, %v) = %v, want %v", tc.body, tc.tokens, got, tc.want)
		}
	}
}

func TestEscapeHost(t *testing.T) {
	if got := escapeHost("*"); got != "%2A" {
		t.Errorf("escapeHost(*) = %q", got)
	}
	if got := escapeHost("www"); got != "www" {
		t.Errorf("escapeHost(www) = %q", got)
	}
}

func TestRenderTemplate(t *testing.T) {
	rec := Record{
		Domain:    "example.com",
		SubDomain: "_acme-challenge",
		Type:      "TXT",
		Value:     "token value",
		TTL:       120,
	}
	raw := "https://dns.example/update?host={fqdn}&ip={ip}&type={type}&sub={sub}"
	got := renderTemplate(raw, rec, true)
	for _, want := range []string{
		"host=_acme-challenge.example.com",
		"ip=token%20value",
		"type=TXT",
		"sub=_acme-challenge",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered url %q missing %q", got, want)
		}
	}
	body := renderTemplate("{\"fqdn\":\"{fqdn}\",\"ip\":\"{ip}\",\"domain\":\"{domain}\",\"ttl\":\"{ttl}\"}", rec, false)
	want := "{\"fqdn\":\"_acme-challenge.example.com\",\"ip\":\"token value\",\"domain\":\"example.com\",\"ttl\":\"120\"}"
	if body != want {
		t.Errorf("rendered body = %q, want %q", body, want)
	}
}

func TestParseHeaderLines(t *testing.T) {
	headers := parseHeaderLines("Authorization: Bearer abc\n\n# comment\nX-Note: a:b:c\nbroken-line\nContent-Type: application/json")
	if got := headers["Authorization"]; got != "Bearer abc" {
		t.Errorf("Authorization = %q", got)
	}
	if got := headers["X-Note"]; got != "a:b:c" {
		t.Errorf("X-Note = %q", got)
	}
	if got := headers["Content-Type"]; got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if _, ok := headers["broken-line"]; ok {
		t.Errorf("line without colon must be ignored")
	}
	if got := parseHeaderLines("   "); got != nil {
		t.Errorf("blank input should yield nil, got %v", got)
	}
}

func TestContentTypeFor(t *testing.T) {
	cases := map[string]string{
		"{\"a\":1}": "application/json",
		"[1,2]":     "application/json",
		"a=1&b=2":   "application/x-www-form-urlencoded",
		"plain":     "text/plain; charset=utf-8",
	}
	for body, want := range cases {
		if got := contentTypeFor(body); got != want {
			t.Errorf("contentTypeFor(%q) = %q, want %q", body, got, want)
		}
	}
}

func TestCustomProviderBuildRequest(t *testing.T) {
	creds := Credentials{
		"url":     "https://dns.example/update?host={fqdn}&ip={ip}",
		"method":  "put",
		"headers": "X-Token: {type}",
		"body":    "{\"ip\":\"{ip}\"}",
		"user":    "u",
		"pass":    "p",
	}
	provider, err := Default().New("custom", creds)
	if err != nil {
		t.Fatalf("build custom provider: %v", err)
	}
	custom, ok := provider.(*customProvider)
	if !ok {
		t.Fatalf("unexpected provider type %T", provider)
	}
	req := custom.buildRequest(Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"})
	if req.Method != "PUT" {
		t.Errorf("method = %q, want PUT", req.Method)
	}
	if !strings.HasSuffix(req.URL, "host=www.example.com&ip=1.2.3.4") {
		t.Errorf("url = %q", req.URL)
	}
	if req.Headers["X-Token"] != "A" {
		t.Errorf("headers = %v", req.Headers)
	}
	if req.Body != "{\"ip\":\"1.2.3.4\"}" {
		t.Errorf("body = %q", req.Body)
	}
	if req.ContentType != "application/json" {
		t.Errorf("content type = %q", req.ContentType)
	}
	if req.BasicUser != "u" || req.BasicPass != "p" {
		t.Errorf("basic auth = %q/%q", req.BasicUser, req.BasicPass)
	}
}

func TestCustomProviderHidesURLWithSecret(t *testing.T) {
	creds := Credentials{"url": "https://dns.example/update?token=topsecretvalue&host={fqdn}"}
	provider, err := Default().New("custom", creds)
	if err != nil {
		t.Fatalf("build custom provider: %v", err)
	}
	custom := provider.(*customProvider)
	req := custom.buildRequest(Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"})
	if req.URL != "(url hidden)" {
		t.Errorf("url = %q, want it to be hidden", req.URL)
	}
}

func TestCustomDeleteIsNoop(t *testing.T) {
	provider, err := Default().New("custom", Credentials{"url": "https://dns.example/update?ip={ip}"})
	if err != nil {
		t.Fatalf("build custom provider: %v", err)
	}
	if err := provider.Delete(nil, Record{Domain: "example.com", Type: "A", Value: "1.2.3.4"}); err != nil {
		t.Fatalf("custom delete = %v, want nil", err)
	}
}
func TestURLQueryValues(t *testing.T) {
	template := "https://user:s3cr3t@dns.example/update/{sub}?token=abcdef123456&host={fqdn}&t={ttl}"
	got := urlQueryValues(template)
	if len(got) != 1 || got[0] != "abcdef123456" {
		t.Fatalf("urlQueryValues = %q, want [abcdef123456]", got)
	}
	if values := urlQueryValues("https://dns.example/update?host={fqdn}&ip={ip}"); len(values) != 0 {
		t.Fatalf("placeholders must be skipped, got %q", values)
	}
}
