package dnsprov

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	var payload map[string]any
	_ = json.NewDecoder(r.Body).Decode(&payload)
	call := tencentCall{
		Action:      r.Header.Get("X-TC-Action"),
		Auth:        r.Header.Get("Authorization"),
		Timestamp:   r.Header.Get("X-TC-Timestamp"),
		ContentType: r.Header.Get("Content-Type"),
		Host:        r.Host,
		Payload:     payload,
	}
	raw, _ := json.Marshal(payload)
	call.Body = string(raw)

	f.mu.Lock()
	f.calls = append(f.calls, call)
	switch call.Action {
	case "CreateRecord":
		f.nextID++
		f.records = append(f.records, tencentRecord{
			RecordID: f.nextID,
			Name:     str(payload["Subdomain"]),
			Type:     str(payload["RecordType"]),
			Value:    str(payload["Value"]),
			Line:     str(payload["RecordLine"]),
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
		resp["RecordList"] = records
	} else {
		resp["RecordId"] = f.nextID
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"Response": resp})
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
	if created.Payload["Domain"] != "example.com" || created.Payload["Subdomain"] != "www" ||
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
	wantAuth := testTC3Auth("AKIDTEST", "testsecret", tencentService, call.Host, ts, call.Body)
	if call.Auth != wantAuth {
		t.Fatalf("authorization mismatch\n got %s\nwant %s", call.Auth, wantAuth)
	}
	if !strings.HasPrefix(call.Auth, "TC3-HMAC-SHA256 Credential=AKIDTEST/") {
		t.Fatalf("authorization = %q", call.Auth)
	}
}

// testTC3Auth is an independent implementation of the published TC3
// authorization algorithm, used to check the provider.
func testTC3Auth(secretID, secretKey, service, host string, ts int64, body string) string {
	hash := func(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
	mac := func(key []byte, msg string) []byte {
		h := hmac.New(sha256.New, key)
		h.Write([]byte(msg))
		return h.Sum(nil)
	}
	date := time.Unix(ts, 0).UTC().Format("2006-01-02")
	canonicalHeaders := "content-type:" + tencentContentType + "\nhost:" + host + "\n"
	canonicalRequest := "POST\n/\n\n" + canonicalHeaders + "\n" + tencentSignedHeaders + "\n" + hash([]byte(body))
	scope := date + "/" + service + "/tc3_request"
	stringToSign := "TC3-HMAC-SHA256\n" + fmt.Sprint(ts) + "\n" + scope + "\n" + hash([]byte(canonicalRequest))
	key := mac([]byte("TC3"+secretKey), date)
	key = mac(key, service)
	key = mac(key, "tc3_request")
	signature := hex.EncodeToString(mac(key, stringToSign))
	return "TC3-HMAC-SHA256 Credential=" + secretID + "/" + scope + ", SignedHeaders=" + tencentSignedHeaders + ", Signature=" + signature
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
