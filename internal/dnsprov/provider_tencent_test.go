package dnsprov

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// tencentFake is a small DNSPod API 3.0 server: it keeps one record list and
// records every call so the tests can assert the exact request shape.
type tencentFake struct {
	mu      sync.Mutex
	records []tencentRecord
	calls   []tencentCall
	nextID  int64
}

type tencentCall struct {
	Action, Auth, Timestamp, ContentType, Host, Body string
	Payload                                          map[string]any
}

func (f *tencentFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	// The real API rejects an unknown parameter by name instead of ignoring it.
	// That is how "Subdomain" on CreateRecord surfaced, so the fake checks the
	// parameter names too (note: CreateRecord wants SubDomain, while
	// DescribeRecordList wants Subdomain).
	allowed := map[string]map[string]bool{
		"DescribeRecordList": {"Domain": true, "Subdomain": true, "RecordType": true, "Limit": true},
		"CreateRecord":       {"Domain": true, "SubDomain": true, "RecordType": true, "RecordLine": true, "Value": true, "TTL": true},
		"ModifyRecord":       {"Domain": true, "SubDomain": true, "RecordType": true, "RecordLine": true, "Value": true, "TTL": true, "RecordId": true},
		"DeleteRecord":       {"Domain": true, "RecordId": true},
	}
	if set, ok := allowed[r.Header.Get("X-TC-Action")]; ok {
		for key := range payload {
			if !set[key] {
				_ = json.NewEncoder(w).Encode(map[string]any{"Response": map[string]any{
					"RequestId": "test-request",
					"Error": map[string]any{
						"Code":    "UnknownParameter",
						"Message": "The parameter `" + key + "` is not recognized.",
					},
				}})
				return
			}
		}
	}

	// Behave like the API: a signature that does not cover exactly the
	// headers it claims to cover is rejected, which is what a missing or
	// mismatched signed header looks like in production.
	if code := f.verifySignature(r, raw); code != "" {
		_ = json.NewEncoder(w).Encode(map[string]any{"Response": map[string]any{
			"RequestId": "test-request",
			"Error":     map[string]any{"Code": code, "Message": "The provided credentials could not be validated."},
		}})
		return
	}
	call := tencentCall{
		Action:      r.Header.Get("X-TC-Action"),
		Auth:        r.Header.Get("Authorization"),
		Timestamp:   r.Header.Get("X-TC-Timestamp"),
		ContentType: r.Header.Get("Content-Type"),
		Host:        r.Host,
		Payload:     payload,
	}
	body, _ := json.Marshal(payload)
	call.Body = string(body)

	f.mu.Lock()
	f.calls = append(f.calls, call)
	switch call.Action {
	case "CreateRecord":
		f.nextID++
		f.records = append(f.records, tencentRecord{
			RecordID: f.nextID,
			Name:     str(payload["SubDomain"]),
			Type:     str(payload["RecordType"]),
			Value:    str(payload["Value"]),
			Line:     str(payload["RecordLine"]),
			TTL:      int(num(payload["TTL"])),
		})
	case "ModifyRecord":
		for i := range f.records {
			if f.records[i].RecordID == int64(num(payload["RecordId"])) {
				f.records[i].Value = str(payload["Value"])
			}
		}
	case "DeleteRecord":
		kept := f.records[:0]
		for _, rec := range f.records {
			if rec.RecordID != int64(num(payload["RecordId"])) {
				kept = append(kept, rec)
			}
		}
		f.records = kept
	}
	records := append([]tencentRecord(nil), f.records...)
	f.mu.Unlock()

	resp := map[string]any{"RequestId": "test-request"}
	if call.Action == "DescribeRecordList" {
		// Mirror the real API: it filters by name and type, and reports an
		// empty result as an error (ResourceNotFound.NoDataOfRecord) inside a
		// 200 response. That detail is what broke the first TXT record.
		sub := str(payload["Subdomain"])
		typ := str(payload["RecordType"])
		matched := make([]tencentRecord, 0, len(records))
		for _, rec := range records {
			if sub != "" && !strings.EqualFold(rec.Name, sub) {
				continue
			}
			if typ != "" && !strings.EqualFold(rec.Type, typ) {
				continue
			}
			matched = append(matched, rec)
		}
		if len(matched) == 0 {
			resp["Error"] = map[string]any{
				"Code":    tencentNoDataCode,
				"Message": "记录列表为空。",
			}
		} else {
			resp["RecordList"] = matched
		}
	} else {
		resp["RecordId"] = f.nextID
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"Response": resp})
}

// secrets maps the test SecretId to its key.
var tencentTestSecrets = map[string]string{"AKIDTEST": "testsecret"}

// verifySignature rebuilds the canonical request from the headers that actually
// arrived and checks the signature, returning the API error code on failure.
func (f *tencentFake) verifySignature(r *http.Request, body []byte) string {
	auth := r.Header.Get("Authorization")
	const prefix = "TC3-HMAC-SHA256 "
	if !strings.HasPrefix(auth, prefix) {
		return "AuthFailure.SignatureFailure"
	}
	var credential, signedHeaders, signature string
	for _, part := range strings.Split(strings.TrimPrefix(auth, prefix), ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, "Credential="):
			credential = strings.TrimPrefix(part, "Credential=")
		case strings.HasPrefix(part, "SignedHeaders="):
			signedHeaders = strings.TrimPrefix(part, "SignedHeaders=")
		case strings.HasPrefix(part, "Signature="):
			signature = strings.TrimPrefix(part, "Signature=")
		}
	}
	credentialParts := strings.Split(credential, "/")
	if len(credentialParts) != 4 || credentialParts[2] != tencentService || credentialParts[3] != "tc3_request" {
		return "AuthFailure.SignatureFailure"
	}
	secretKey, ok := tencentTestSecrets[credentialParts[0]]
	if !ok {
		return "AuthFailure.SecretIdNotFound"
	}
	canonicalHeaders := ""
	for _, name := range strings.Split(signedHeaders, ";") {
		var value string
		switch name {
		case "content-type":
			value = r.Header.Get("Content-Type")
		case "host":
			value = r.Host
		case "x-tc-action":
			value = strings.ToLower(r.Header.Get("X-TC-Action"))
		default:
			return "AuthFailure.SignatureFailure"
		}
		canonicalHeaders += name + ":" + value + "\n"
	}
	canonicalRequest := r.Method + "\n" + r.URL.Path + "\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + sha256Hex(string(body))
	scope := credentialParts[1] + "/" + tencentService + "/tc3_request"
	stringToSign := "TC3-HMAC-SHA256\n" + r.Header.Get("X-TC-Timestamp") + "\n" + scope + "\n" + sha256Hex(canonicalRequest)
	key := hmacSHA256([]byte("TC3"+secretKey), credentialParts[1])
	key = hmacSHA256(key, tencentService)
	key = hmacSHA256(key, "tc3_request")
	if hex.EncodeToString(hmacSHA256(key, stringToSign)) != signature {
		return "AuthFailure.SignatureFailure"
	}
	return ""
}

func (f *tencentFake) actions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.calls))
	for _, call := range f.calls {
		out = append(out, call.Action)
	}
	return out
}

func (f *tencentFake) last() tencentCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func str(v any) string { s, _ := v.(string); return s }
func num(v any) float64 {
	n, _ := v.(float64)
	return n
}

func newTencentProvider(t *testing.T, fake *tencentFake, ts int64) *tencentProvider {
	t.Helper()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	old := tencentEndpoint
	tencentEndpoint = srv.URL
	t.Cleanup(func() { tencentEndpoint = old })

	provider, err := Default().New("tencent", Credentials{"secretid": "AKIDTEST", "secretkey": "testsecret"})
	if err != nil {
		t.Fatalf("new tencent provider: %v", err)
	}
	p := provider.(*tencentProvider)
	p.now = func() time.Time { return time.Unix(ts, 0).UTC() }
	return p
}

func TestTencentSetCreatesUpdatesAndSkipsUnchanged(t *testing.T) {
	fake := &tencentFake{}
	p := newTencentProvider(t, fake, 1700000000)
	rec := Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"}

	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := fake.actions(); len(got) != 2 || got[0] != "DescribeRecordList" || got[1] != "CreateRecord" {
		t.Fatalf("create calls = %v", got)
	}
	created := fake.last()
	if created.Payload["Domain"] != "example.com" || created.Payload["SubDomain"] != "www" ||
		created.Payload["RecordType"] != "A" || created.Payload["Value"] != "1.2.3.4" ||
		created.Payload["RecordLine"] != "默认" || created.Payload["TTL"] != float64(600) {
		t.Fatalf("create payload = %v", created.Payload)
	}

	// The same value only needs the lookup.
	fake.calls = nil
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("no-op set: %v", err)
	}
	if got := fake.actions(); len(got) != 1 || got[0] != "DescribeRecordList" {
		t.Fatalf("no-op calls = %v", got)
	}

	// A new value modifies the existing record by id.
	fake.calls = nil
	rec.Value = "5.6.7.8"
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("modify: %v", err)
	}
	if got := fake.actions(); len(got) != 2 || got[1] != "ModifyRecord" {
		t.Fatalf("modify calls = %v", got)
	}
	if id, _ := fake.last().Payload["RecordId"].(float64); id != 1 {
		t.Fatalf("modify record id = %v", fake.last().Payload["RecordId"])
	}
	rec.Value = "9.9.9.9"
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("second modify: %v", err)
	}
	if fake.records[0].Value != "9.9.9.9" {
		t.Fatalf("stored value = %q", fake.records[0].Value)
	}
}

// An apex and its wildcard share the _acme-challenge host but need different
// TXT values at the same time; the second write must add a record instead of
// replacing the first one, and deletion must only remove the value it owns.
func TestTencentKeepsBothTXTValuesAtOneName(t *testing.T) {
	fake := &tencentFake{}
	p := newTencentProvider(t, fake, 1700000000)
	first := Record{Domain: "lcyk.cc", SubDomain: "_acme-challenge", Type: "TXT", Value: "value-a"}
	second := first
	second.Value = "value-b"

	if err := p.Set(context.Background(), first); err != nil {
		t.Fatalf("set first: %v", err)
	}
	if err := p.Set(context.Background(), second); err != nil {
		t.Fatalf("set second: %v", err)
	}
	if len(fake.records) != 2 {
		t.Fatalf("records = %+v, want both TXT values", fake.records)
	}
	if got := fake.actions(); got[len(got)-1] != "CreateRecord" {
		t.Fatalf("the second value must be created, calls = %v", got)
	}

	if err := p.Delete(context.Background(), first); err != nil {
		t.Fatalf("delete first: %v", err)
	}
	if len(fake.records) != 1 || fake.records[0].Value != "value-b" {
		t.Fatalf("records after delete = %+v", fake.records)
	}
}

// The dns-01 solver asks for a 60 second TTL, which a free DNSPod plan rejects
// with LimitExceeded.RecordTtlLimit; the provider has to raise it to the
// minimum the API accepts.
func TestTencentRaisesTheTTLToThePlanMinimum(t *testing.T) {
	fake := &tencentFake{}
	p := newTencentProvider(t, fake, 1700000000)
	rec := Record{Domain: "cykk.site", SubDomain: "_acme-challenge", Type: "TXT", Value: "challenge-token", TTL: 60}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, _ := fake.last().Payload["TTL"].(float64); got != 600 {
		t.Fatalf("create TTL = %v, want the 600 minimum", fake.last().Payload["TTL"])
	}
	if len(fake.records) != 1 || fake.records[0].TTL != 600 {
		t.Fatalf("stored record = %+v", fake.records)
	}
}

// The first record for a name makes the API answer DescribeRecordList with
// ResourceNotFound.NoDataOfRecord; that must read as "no record yet" and the
// provider has to create it instead of failing the challenge.
func TestTencentCreatesWhenTheRecordListIsEmpty(t *testing.T) {
	fake := &tencentFake{}
	p := newTencentProvider(t, fake, 1700000000)
	rec := Record{Domain: "cykk.site", SubDomain: "_acme-challenge", Type: "TXT", Value: "challenge-token"}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("creating the first record failed: %v", err)
	}
	actions := fake.actions()
	if len(actions) != 2 || actions[0] != "DescribeRecordList" || actions[1] != "CreateRecord" {
		t.Fatalf("calls = %v, want a lookup followed by a create", actions)
	}
	if len(fake.records) != 1 || fake.records[0].Value != "challenge-token" {
		t.Fatalf("records = %+v", fake.records)
	}
}

func TestTencentDelete(t *testing.T) {
	fake := &tencentFake{}
	p := newTencentProvider(t, fake, 1700000000)
	rec := Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := p.Delete(context.Background(), rec); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(fake.records) != 0 {
		t.Fatalf("records after delete = %+v", fake.records)
	}
	fake.calls = nil
	if err := p.Delete(context.Background(), rec); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
	if got := fake.actions(); len(got) != 1 || got[0] != "DescribeRecordList" {
		t.Fatalf("delete missing calls = %v", got)
	}
}

func TestTencentRequestShapeAndSignature(t *testing.T) {
	fake := &tencentFake{}
	const ts = int64(1700000000)
	p := newTencentProvider(t, fake, ts)
	rec := Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	call := fake.last()
	if call.ContentType != tencentContentType {
		t.Fatalf("content type = %q", call.ContentType)
	}
	if call.Timestamp != fmt.Sprint(ts) {
		t.Fatalf("timestamp = %q", call.Timestamp)
	}
	if call.Host != strings.TrimPrefix(strings.TrimPrefix(tencentEndpoint, "http://"), "https://") {
		t.Fatalf("host = %q", call.Host)
	}
	if !strings.HasPrefix(call.Auth, "TC3-HMAC-SHA256 Credential=AKIDTEST/") {
		t.Fatalf("authorization = %q", call.Auth)
	}
	if !strings.Contains(call.Auth, "SignedHeaders=content-type;host,") {
		t.Fatalf("signed headers must be content-type;host, got %q", call.Auth)
	}
}

// testTC3Auth is an independent implementation of the published TC3
// authorization algorithm, used to check the provider.
// The golden values below were produced by an independent implementation
// (Python hmac/hashlib) from the documented canonical request. They pin the
// exact canonical form, which is where the signature failure came from: the
// signed-header list has to match the headers in the canonical request.
func TestTencentCanonicalRequestAndSignature(t *testing.T) {
	const body = `{"Domain":"example.com","Limit":100,"RecordType":"TXT","Subdomain":"_acme-challenge"}`
	const host = "dnspod.tencentcloudapi.com"
	canonical := tc3CanonicalRequest(host, body)
	wantCanonical := "POST\n/\n\n" +
		"content-type:application/json\n" +
		"host:dnspod.tencentcloudapi.com\n" +
		"\n" +
		"content-type;host\n" +
		"01eb36d4abe0c35b38fe57d1a7d8f0d4525fd5a86acb6afa5bf1520b217abe81"
	if canonical != wantCanonical {
		t.Fatalf("canonical request mismatch:\n got %q\nwant %q", canonical, wantCanonical)
	}
	auth := tc3Authorization("AKIDTEST", "testsecret", tencentService, host, 1700000000, body)
	want := "TC3-HMAC-SHA256 Credential=AKIDTEST/2023-11-14/dnspod/tc3_request, SignedHeaders=content-type;host, Signature=8b60cb3ab21af2556bcdceeae3050f045edb6e60fbcbf0751f54f109e6b4d0a0"
	if auth != want {
		t.Fatalf("authorization mismatch\n got %s\nwant %s", auth, want)
	}
}

func TestTencentAPIErrorIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"Response": map[string]any{
			"Error": map[string]any{"Code": "AuthFailure.SignatureFailure", "Message": "bad signature for AKIDTEST"},
		}})
	}))
	defer srv.Close()
	old := tencentEndpoint
	tencentEndpoint = srv.URL
	t.Cleanup(func() { tencentEndpoint = old })

	provider, err := Default().New("tencent", Credentials{"secretid": "AKIDTEST", "secretkey": "testsecret"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	err = provider.Set(context.Background(), Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "1.2.3.4"})
	if err == nil {
		t.Fatal("an API error must be returned")
	}
	msg := err.Error()
	if !strings.Contains(msg, "AuthFailure.SignatureFailure") {
		t.Fatalf("error = %q", msg)
	}
	if strings.Contains(msg, "AKIDTEST") {
		t.Fatalf("the secret id leaked into the error: %q", msg)
	}
}
