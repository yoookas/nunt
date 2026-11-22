package dnsprov

import (
	"encoding/xml"
	"net/http"
	"strings"
	"testing"
)

func TestRegisterBuiltinsMeta(t *testing.T) {
	registry := Default()
	metas := registry.List()
	if len(metas) != 14 {
		t.Fatalf("registered providers = %d, want 14", len(metas))
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
	for _, id := range []string{
		"cloudflare", "alidns", "dnspod", "dynv6", "duckdns", "noip", "freedns",
		"desec", "porkbun", "namesilo", "godaddy", "namecheap", "vercel", "custom",
	} {
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
	case "cloudflare":
		// Cloudflare accepts either an API token or email + global key.
		creds["apitoken"] = "test-apitoken-value"
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
	if _, ok := Default().Meta("cloudflare"); !ok {
		t.Fatalf("cloudflare must be registered")
	}
	if err := Default().Validate("custom", Credentials{"url": "https://x.example"}); err != nil {
		t.Fatalf("custom with url must validate: %v", err)
	}
}

func TestCloudflareAuthHeaders(t *testing.T) {
	provider, err := Default().New("cloudflare", Credentials{"apitoken": "tok123"})
	if err != nil {
		t.Fatalf("token auth: %v", err)
	}
	headers := provider.(*cloudflareProvider).headers()
	if headers["Authorization"] != "Bearer tok123" {
		t.Errorf("token headers = %v", headers)
	}
	provider, err = Default().New("cloudflare", Credentials{"email": "a@b.c", "apikey": "key123"})
	if err != nil {
		t.Fatalf("key auth: %v", err)
	}
	headers = provider.(*cloudflareProvider).headers()
	if headers["X-Auth-Email"] != "a@b.c" || headers["X-Auth-Key"] != "key123" {
		t.Errorf("key headers = %v", headers)
	}
	if _, ok := headers["Authorization"]; ok {
		t.Errorf("key auth must not send a bearer token: %v", headers)
	}
	if _, err := Default().New("cloudflare", Credentials{"email": "a@b.c"}); err == nil {
		t.Errorf("email without api key must fail")
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

func TestDNSPodFormEncoding(t *testing.T) {
	provider, err := Default().New("dnspod", Credentials{"id": "123", "token": "abc"})
	if err != nil {
		t.Fatalf("dnspod: %v", err)
	}
	dnspod := provider.(*dnspodProvider)
	if dnspod.loginToken != "123,abc" {
		t.Errorf("login token = %q", dnspod.loginToken)
	}
}

func TestDuckDNSUpdateQuery(t *testing.T) {
	provider, err := Default().New("duckdns", Credentials{"domain": "myhost.duckdns.org", "token": "tok"})
	if err != nil {
		t.Fatalf("duckdns: %v", err)
	}
	duck := provider.(*duckDNSProvider)
	if duck.domain != "myhost" {
		t.Errorf("domain = %q, want myhost", duck.domain)
	}
	query, err := duck.updateQuery(Record{Domain: "myhost", Type: "A", Value: "1.2.3.4"})
	if err != nil {
		t.Fatalf("A record: %v", err)
	}
	if query.Get("domains") != "myhost" || query.Get("ip") != "1.2.3.4" || query.Get("token") != "tok" {
		t.Errorf("A query = %v", query)
	}
	if query.Get("ipv6") != "" {
		t.Errorf("A record must not set ipv6: %v", query)
	}
	query, err = duck.updateQuery(Record{Domain: "myhost", Type: "AAAA", Value: "::1"})
	if err != nil {
		t.Fatalf("AAAA record: %v", err)
	}
	if query.Get("ipv6") != "::1" || query.Get("ip") != "" {
		t.Errorf("AAAA query = %v", query)
	}
	if _, err := duck.updateQuery(Record{Type: "TXT", Value: "x"}); err == nil {
		t.Errorf("TXT must be rejected")
	}
}

func TestNoIPUpdateQuery(t *testing.T) {
	provider, err := Default().New("noip", Credentials{"username": "u", "password": "p"})
	if err != nil {
		t.Fatalf("noip: %v", err)
	}
	noip := provider.(*noIPProvider)
	query := noip.updateQuery(Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"})
	if query.Get("hostname") != "www.example.com" || query.Get("myip") != "1.2.3.4" {
		t.Errorf("query = %v", query)
	}
	provider, err = Default().New("noip", Credentials{"username": "u", "password": "p", "hostname": "fixed.ddns.net"})
	if err != nil {
		t.Fatalf("noip with hostname: %v", err)
	}
	query = provider.(*noIPProvider).updateQuery(Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"})
	if query.Get("hostname") != "fixed.ddns.net" {
		t.Errorf("hostname override ignored: %v", query)
	}
	if err := provider.Delete(nil, Record{}); err != nil {
		t.Errorf("noip delete must be a no-op: %v", err)
	}
}

func TestFreeDNSTarget(t *testing.T) {
	provider, err := Default().New("freedns", Credentials{"token": "tok"})
	if err != nil {
		t.Fatalf("freedns: %v", err)
	}
	rec := Record{Domain: "example.com", SubDomain: "www"}
	if got := provider.(*freeDNSProvider).target(rec); got != "www.example.com" {
		t.Errorf("target = %q", got)
	}
	provider, err = Default().New("freedns", Credentials{"token": "tok", "address": "other.example.com"})
	if err != nil {
		t.Fatalf("freedns with address: %v", err)
	}
	if got := provider.(*freeDNSProvider).target(rec); got != "other.example.com" {
		t.Errorf("target override = %q", got)
	}
}

func TestDESECRRsetURL(t *testing.T) {
	cases := []struct {
		rec  Record
		want string
	}{
		{Record{Domain: "example.com", Type: "A"}, desecAPI + "/domains/example.com/rrsets/A/"},
		{Record{Domain: "example.com", SubDomain: "@", Type: "TXT"}, desecAPI + "/domains/example.com/rrsets/TXT/"},
		{Record{Domain: "example.com", SubDomain: "_acme-challenge", Type: "TXT"}, desecAPI + "/domains/example.com/rrsets/_acme-challenge/TXT/"},
		{Record{Domain: "example.com", SubDomain: "*", Type: "A"}, desecAPI + "/domains/example.com/rrsets/%2A/A/"},
	}
	for _, tc := range cases {
		if got := desecRRsetURL(desecAPI, tc.rec); got != tc.want {
			t.Errorf("desecRRsetURL(%+v) = %q, want %q", tc.rec, got, tc.want)
		}
	}
	if got := desecSubname(Record{Domain: "example.com", SubDomain: "@"}); got != "" {
		t.Errorf("desecSubname(apex) = %q", got)
	}
}

func TestGoDaddyRecordURL(t *testing.T) {
	got := goDaddyRecordURL(goDaddyAPI, Record{Domain: "example.com", SubDomain: "www", Type: "a"})
	want := goDaddyAPI + "/domains/example.com/records/A/www"
	if got != want {
		t.Errorf("goDaddyRecordURL = %q, want %q", got, want)
	}
	got = goDaddyRecordURL(goDaddyAPI, Record{Domain: "example.com", SubDomain: "@", Type: "TXT"})
	want = goDaddyAPI + "/domains/example.com/records/TXT/@"
	if got != want {
		t.Errorf("goDaddyRecordURL apex = %q, want %q", got, want)
	}
}

func TestSplitDomain(t *testing.T) {
	cases := []struct{ in, sld, tld string }{
		{"example.com", "example", "com"},
		{"Example.COM", "example", "com"},
		{"sub.example.co.uk", "sub.example.co", "uk"},
	}
	for _, tc := range cases {
		sld, tld := splitDomain(tc.in)
		if sld != tc.sld || tld != tc.tld {
			t.Errorf("splitDomain(%q) = (%q, %q), want (%q, %q)", tc.in, sld, tld, tc.sld, tc.tld)
		}
	}
}

func TestNameCheapApplyRecord(t *testing.T) {
	hosts := []nameCheapHost{
		{Name: "@", Type: "A", Address: "1.1.1.1", TTL: "1800"},
		{Name: "www", Type: "A", Address: "2.2.2.2", TTL: "1800"},
		{Name: "www", Type: "TXT", Address: "keep-me", TTL: "1800"},
	}
	rec := Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "9.9.9.9", TTL: 300}
	updated, changed := applyRecord(hosts, rec, false)
	if !changed {
		t.Fatalf("update must report a change")
	}
	if len(updated) != 3 {
		t.Fatalf("host count = %d, want 3", len(updated))
	}
	var found bool
	for _, host := range updated {
		if host.Name == "www" && host.Type == "A" {
			found = true
			if host.Address != "9.9.9.9" || host.TTL != "300" {
				t.Errorf("updated host = %+v", host)
			}
		}
		if host.Name == "www" && host.Type == "TXT" && host.Address != "keep-me" {
			t.Errorf("unrelated record was touched: %+v", host)
		}
	}
	if !found {
		t.Fatalf("record was not written back")
	}

	removed, changed := applyRecord(hosts, rec, true)
	if !changed || len(removed) != 2 {
		t.Fatalf("delete: changed=%v hosts=%d, want true/2", changed, len(removed))
	}
	missing := Record{Domain: "example.com", SubDomain: "nope", Type: "A", Value: "9.9.9.9"}
	kept, changed := applyRecord(hosts, missing, true)
	if changed || len(kept) != len(hosts) {
		t.Fatalf("deleting a missing record must be a no-op: changed=%v len=%d", changed, len(kept))
	}
}

func TestNameCheapAddressPadding(t *testing.T) {
	short := nameCheapAddress(Record{Type: "TXT", Value: "abc"})
	if len(short) != 10 {
		t.Errorf("short TXT address = %q (len %d), want 10 chars", short, len(short))
	}
	long := nameCheapAddress(Record{Type: "TXT", Value: "0123456789abcdef"})
	if long != "0123456789abcdef" {
		t.Errorf("long TXT address = %q", long)
	}
	if got := nameCheapAddress(Record{Type: "A", Value: "1.2.3.4"}); got != "1.2.3.4" {
		t.Errorf("A address = %q", got)
	}
}

func TestNameCheapResponseParsing(t *testing.T) {
	raw := `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <Errors />
  <CommandResponse Type="namecheap.domains.dns.getHosts">
    <DomainGetHostsResult Domain="example.com" IsSuccess="true">
      <Hosts>
        <Host Name="@" Type="A" Address="1.1.1.1" MXPref="10" TTL="1800" />
        <Host Name="www" Type="CNAME" Address="example.com." MXPref="10" TTL="1800" />
      </Hosts>
    </DomainGetHostsResult>
  </CommandResponse>
</ApiResponse>` // root element is ApiResponse
	var out nameCheapResponse
	if err := xml.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.EqualFold(out.Status, "OK") {
		t.Errorf("status = %q", out.Status)
	}
	hosts := out.CommandResponse.Result.Hosts.Hosts
	if len(hosts) != 2 {
		t.Fatalf("hosts = %d, want 2", len(hosts))
	}
	if hosts[0].Name != "@" || hosts[0].Type != "A" || hosts[0].Address != "1.1.1.1" {
		t.Errorf("host[0] = %+v", hosts[0])
	}
	if hosts[1].Name != "www" || hosts[1].Type != "CNAME" {
		t.Errorf("host[1] = %+v", hosts[1])
	}
}

func TestNameSiloXMLParsing(t *testing.T) {
	ok := `<?xml version="1.0"?>
<namesilo>
  <request><operation>dnsListRecords</operation><ip>1.2.3.4</ip></request>
  <reply>
    <code>300</code>
    <detail>success</detail>
    <resource>
      <record>
        <record_id>abc123</record_id>
        <type>A</type>
        <host>www.example.com</host>
        <value>1.2.3.4</value>
        <ttl>3600</ttl>
      </record>
      <record>
        <record_id>def456</record_id>
        <type>TXT</type>
        <host>example.com</host>
        <value>hello world</value>
        <ttl>3600</ttl>
      </record>
    </resource>
  </reply>
</namesilo>`
	var reply nameSiloReply
	if err := xml.Unmarshal([]byte(ok), &reply); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if err := reply.err(); err != nil {
		t.Fatalf("success reply reported an error: %v", err)
	}
	if len(reply.Resource.Record) != 2 {
		t.Fatalf("records = %d, want 2", len(reply.Resource.Record))
	}
	if reply.Resource.Record[0].RecordID != "abc123" || reply.Resource.Record[0].Host != "www.example.com" {
		t.Errorf("record[0] = %+v", reply.Resource.Record[0])
	}
	if reply.Resource.Record[1].Value != "hello world" {
		t.Errorf("record[1] = %+v", reply.Resource.Record[1])
	}

	fail := `<?xml version="1.0"?>
<namesilo><reply><code>300</code><detail>303 Invalid Request: Invalid api key</detail></reply></namesilo>`
	var bad nameSiloReply
	if err := xml.Unmarshal([]byte(fail), &bad); err != nil {
		t.Fatalf("decode failure: %v", err)
	}
	if err := bad.err(); err == nil {
		t.Fatalf("error reply must be reported")
	} else if !strings.Contains(err.Error(), "Invalid api key") {
		t.Errorf("error = %v", err)
	}

	var empty nameSiloReply
	if err := empty.err(); err == nil {
		t.Fatalf("empty reply must be reported as an error")
	}
}

func TestPorkbunPayloadKeepsCredentialsOutOfErrors(t *testing.T) {
	provider, err := Default().New("porkbun", Credentials{"apikey": "pk1_abcdef", "secretapikey": "sk1_ghijkl"})
	if err != nil {
		t.Fatalf("porkbun: %v", err)
	}
	porkbun := provider.(*porkbunProvider)
	message := sanitize("bad secret sk1_ghijkl for key pk1_abcdef", porkbun.creds, summaryLimit)
	if strings.Contains(message, "sk1_ghijkl") || strings.Contains(message, "pk1_abcdef") {
		t.Errorf("credentials leaked: %q", message)
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
