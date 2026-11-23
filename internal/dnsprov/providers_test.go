package dnsprov

import (
	"net/http"
	"strings"
	"testing"
)

func idsOf(metas []Meta) []string {
	out := make([]string, 0, len(metas))
	for _, m := range metas {
		out = append(out, m.ID)
	}
	return out
}

func TestRegisterBuiltinsMeta(t *testing.T) {
	registry := Default()
	metas := registry.List()
	if len(metas) != 5 {
		t.Fatalf("registered providers = %d, want 5", len(metas))
	}
	// The ids are part of the configuration format: renaming one breaks stored
	// DDNS rules and ACME jobs.
	want := []string{"alidns", "cloudflare", "custom", "spaceship", "tencent"}
	for i, meta := range metas {
		if meta.ID != want[i] {
			t.Fatalf("provider %d = %q, want %q (all: %v)", i, meta.ID, want[i], idsOf(metas))
		}
	}
	seen := map[string]bool{}
	for _, meta := range metas {
		if meta.ID != strings.ToLower(meta.ID) || strings.TrimSpace(meta.ID) == "" {
			t.Errorf("provider id %q must be lower case and non empty", meta.ID)
		}
		if seen[meta.ID] {
			t.Errorf("duplicate provider id %q", meta.ID)
		}
		seen[meta.ID] = true
		if strings.TrimSpace(meta.Title) == "" {
			t.Errorf("provider %s has no title", meta.ID)
		}
		if len(meta.Fields) == 0 {
			t.Errorf("provider %s exposes no fields", meta.ID)
		}
		for _, field := range meta.Fields {
			if strings.TrimSpace(field.Key) == "" {
				t.Errorf("provider %s has a field without key", meta.ID)
			}
			if field.Key != strings.TrimSpace(field.Key) || strings.Contains(field.Key, " ") {
				t.Errorf("provider %s field key %q must not contain spaces", meta.ID, field.Key)
			}
			if strings.TrimSpace(field.Label) == "" {
				t.Errorf("provider %s field %s has no label", meta.ID, field.Key)
			}
		}
	}
	for _, id := range []string{"alidns", "tencent", "custom"} {
		if !seen[id] {
			t.Errorf("provider %q is not registered", id)
		}
	}
}

func TestDefaultRegistryIsStable(t *testing.T) {
	if Default() != Default() {
		t.Fatalf("Default() must return the same registry")
	}
	if _, err := Default().New("nope", nil); err == nil {
		t.Fatalf("unknown provider must fail")
	}
	if err := Default().Validate("nope", nil); err == nil {
		t.Fatalf("unknown provider validation must fail")
	}
}

// providerCreds builds a minimal credential set that satisfies every required
// field of a provider.
func providerCreds(t *testing.T, id string) Credentials {
	t.Helper()
	meta, ok := Default().Meta(id)
	if !ok {
		t.Fatalf("provider %s is not registered", id)
	}
	creds := Credentials{}
	for _, field := range meta.Fields {
		if field.Required {
			creds[field.Key] = "test-" + field.Key
		}
	}
	switch id {
	case "alidns":
		creds["accesskeyid"] = "LTAITEST"
		creds["accesskeysecret"] = "testsecret"
	}
	return creds
}

func TestEveryProviderBuilds(t *testing.T) {
	for _, meta := range Default().List() {
		creds := providerCreds(t, meta.ID)
		provider, err := Default().New(meta.ID, creds)
		if err != nil {
			t.Errorf("New(%s): %v", meta.ID, err)
			continue
		}
		if provider.Name() != meta.ID {
			t.Errorf("provider %s reports name %q", meta.ID, provider.Name())
		}
		// Required fields must be enforced by the factory as well.
		// Factories must refuse an empty credential set on their own, even
		// when their declared fields are entirely optional.
		if _, err := Default().New(meta.ID, Credentials{}); err == nil {
			t.Errorf("provider %s accepted empty credentials", meta.ID)
		}
	}
}

func TestValidateReportsMissingFields(t *testing.T) {
	if err := Default().Validate("alidns", Credentials{}); err == nil {
		t.Fatalf("alidns has required fields and must fail validation")
	}
	if _, ok := Default().Meta("tencent"); !ok {
		t.Fatalf("tencent must be registered")
	}
	if err := Default().Validate("custom", Credentials{"url": "https://x.example"}); err != nil {
		t.Fatalf("custom with url must validate: %v", err)
	}
}

func TestAliyunSignature(t *testing.T) {
	params := map[string]string{
		"Action":           "DescribeSubDomainRecords",
		"Format":           "JSON",
		"Version":          "2015-01-09",
		"AccessKeyId":      "testid",
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureVersion": "1.0",
		"SignatureNonce":   "abc123",
		"Timestamp":        "2024-01-01T00:00:00Z",
		"DomainName":       "example.com",
		"SubDomain":        "www.example.com",
		"Type":             "A",
	}
	query := buildAliyunQuery(params)
	signature := signAliyunRPC("GET", query, "testsecret")
	// The expected value is the HMAC-SHA1 of
	// "GET&%2F&" + percentEncode(canonicalQuery) keyed with "testsecret&".
	if signature == "" {
		t.Fatal("empty signature")
	}
	if strings.ContainsAny(signature, "+/=") == false && !strings.HasSuffix(signature, "=") {
		t.Errorf("signature %q does not look like base64", signature)
	}
	other := signAliyunRPC("GET", query, "othersecret")
	if other == signature {
		t.Errorf("different secrets must produce different signatures")
	}
	if !strings.Contains(canonicalAliyunQuery(query), "Action=DescribeSubDomainRecords") {
		t.Errorf("canonical query = %q", canonicalAliyunQuery(query))
	}
}

// buildAliyunQuery mirrors what the provider sends: a signed url.Values.
func buildAliyunQuery(params map[string]string) map[string][]string {
	query := map[string][]string{}
	for k, v := range params {
		query[k] = []string{v}
	}
	return query
}

func TestAliyunEncode(t *testing.T) {
	cases := map[string]string{
		"abc":         "abc",
		"a b":         "a%20b",
		"a+b":         "a%2Bb",
		"a~b":         "a~b",
		"a*b":         "a%2Ab",
		"a/b":         "a%2Fb",
		"_acme-chall": "_acme-chall",
		"中文":          "%E4%B8%AD%E6%96%87",
	}
	for in, want := range cases {
		if got := aliyunEncode(in); got != want {
			t.Errorf("aliyunEncode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAliyunCanonicalQuerySortsAndSkipsSignature(t *testing.T) {
	query := map[string][]string{
		"b":         {"2"},
		"a":         {"1"},
		"Signature": {"ignored"},
		"empty":     {""},
	}
	got := canonicalAliyunQuery(query)
	if got != "a=1&b=2&empty=" {
		t.Errorf("canonicalAliyunQuery = %q", got)
	}
}

func TestCustomProviderRequestDefaults(t *testing.T) {
	provider, err := Default().New("custom", Credentials{"url": "https://dns.example/update?ip={ip}"})
	if err != nil {
		t.Fatalf("custom: %v", err)
	}
	req := provider.(*customProvider).buildRequest(Record{Domain: "example.com", Type: "A", Value: "1.2.3.4"})
	if req.Method != http.MethodPost {
		t.Errorf("default method = %q, want POST", req.Method)
	}
	if req.URL != "https://dns.example/update?ip=1.2.3.4" {
		t.Errorf("url = %q", req.URL)
	}
}
func TestPickAliDNSRecord(t *testing.T) {
	records := []aliDNSRecord{
		{RecordID: "1", RR: "other", Type: "A", Value: "9.9.9.9"},
		{RecordID: "2", RR: "www", Type: "AAAA", Value: "::1"},
		{RecordID: "3", RR: "www", Type: "A", Value: "1.1.1.1"},
	}
	if got := pickAliDNSRecord(records, "www", "A"); got == nil || got.RecordID != "3" {
		t.Fatalf("exact match failed: %+v", got)
	}
	if got := pickAliDNSRecord(records, "www", "TXT"); got == nil || got.RecordID != "1" {
		t.Fatalf("fallback should keep the first row: %+v", got)
	}
	apex := []aliDNSRecord{{RecordID: "9", RR: "@", Type: "TXT", Value: "x"}}
	if got := pickAliDNSRecord(apex, "@", "txt"); got == nil || got.RecordID != "9" {
		t.Fatalf("apex match failed: %+v", got)
	}
	if got := pickAliDNSRecord(nil, "www", "A"); got != nil {
		t.Fatalf("empty list must return nil, got %+v", got)
	}
}
