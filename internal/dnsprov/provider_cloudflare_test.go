package dnsprov

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeCloudflare implements just enough of the v4 API for the provider.
type fakeCloudflare struct {
	mu       sync.Mutex
	zones    []cloudflareZone
	records  []cloudflareRecord
	nextID   int
	requests []string
	body     map[string]any
	failWith string
}

func (f *fakeCloudflare) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/zones", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requests = append(f.requests, "zones "+r.URL.Query().Get("name"))
		name := r.URL.Query().Get("name")
		var out []cloudflareZone
		for _, z := range f.zones {
			if strings.EqualFold(z.Name, name) {
				out = append(out, z)
			}
		}
		writeEnvelope(w, out, "")
	})
	mux.HandleFunc("/zones/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		// Paths: /zones/{zone}/dns_records[/{id}]
		rest := strings.TrimPrefix(r.URL.Path, "/zones/")
		parts := strings.Split(rest, "/")
		if len(parts) < 2 || parts[1] != "dns_records" {
			http.NotFound(w, r)
			return
		}
		id := ""
		if len(parts) > 2 {
			id = parts[2]
		}
		switch r.Method {
		case http.MethodGet:
			if f.failWith != "" {
				writeEnvelope(w, nil, f.failWith)
				return
			}
			name := r.URL.Query().Get("name")
			typ := r.URL.Query().Get("type")
			out := []cloudflareRecord{}
			for _, rec := range f.records {
				if strings.EqualFold(rec.Name, name) && strings.EqualFold(rec.Type, typ) {
					out = append(out, rec)
				}
			}
			writeEnvelope(w, out, "")
		case http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.body = body
			f.nextID++
			rec := cloudflareRecord{ID: "rec-" + string(rune('0'+f.nextID)), Name: body["name"].(string), Type: body["type"].(string), Content: body["content"].(string)}
			f.records = append(f.records, rec)
			writeEnvelope(w, rec, "")
		case http.MethodPut:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.body = body
			for i := range f.records {
				if f.records[i].ID == id {
					f.records[i].Content = body["content"].(string)
					writeEnvelope(w, f.records[i], "")
					return
				}
			}
			writeEnvelope(w, nil, "record not found")
		case http.MethodDelete:
			out := f.records[:0]
			for _, rec := range f.records {
				if rec.ID != id {
					out = append(out, rec)
				}
			}
			f.records = out
			writeEnvelope(w, map[string]string{"id": id}, "")
		}
	})
	return mux
}

func writeEnvelope(w http.ResponseWriter, result any, errMsg string) {
	env := map[string]any{"success": errMsg == "", "result": result}
	if errMsg != "" {
		env["errors"] = []map[string]any{{"code": 1001, "message": errMsg}}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(env)
}

func newCloudflareForTest(t *testing.T, f *fakeCloudflare) *cloudflareProvider {
	t.Helper()
	ts := httptest.NewServer(f.handler())
	t.Cleanup(ts.Close)
	old := cloudflareEndpoint
	cloudflareEndpoint = ts.URL
	t.Cleanup(func() { cloudflareEndpoint = old })

	return &cloudflareProvider{base: newBase(nil), token: "test-token", zones: map[string]string{}}
}

func TestCloudflareCreatesAndUpdatesRecords(t *testing.T) {
	f := &fakeCloudflare{zones: []cloudflareZone{{ID: "zone-1", Name: "example.com"}}}
	p := newCloudflareForTest(t, f)
	ctx := context.Background()
	rec := Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "192.0.2.10", TTL: 300}

	if err := p.Set(ctx, rec); err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(f.records) != 1 || f.records[0].Content != "192.0.2.10" {
		t.Fatalf("records = %+v", f.records)
	}
	if f.body["proxied"] != false {
		t.Fatalf("proxied must stay false: %v", f.body)
	}

	rec.Value = "192.0.2.20"
	if err := p.Set(ctx, rec); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(f.records) != 1 || f.records[0].Content != "192.0.2.20" {
		t.Fatalf("records after update = %+v", f.records)
	}

	if err := p.Delete(ctx, rec); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(f.records) != 0 {
		t.Fatalf("records after delete = %+v", f.records)
	}
}

func TestCloudflareZoneLookupWalksUp(t *testing.T) {
	f := &fakeCloudflare{zones: []cloudflareZone{{ID: "zone-1", Name: "example.com"}}}
	p := newCloudflareForTest(t, f)

	// The record lives in sub.example.com, the zone is example.com.
	rec := Record{Domain: "sub.example.com", SubDomain: "host", Type: "TXT", Value: "x"}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("set: %v", err)
	}
	if len(f.records) != 1 || f.records[0].Name != "host.sub.example.com" {
		t.Fatalf("records = %+v", f.records)
	}
}

func TestCloudflareSurfacesAPIErrors(t *testing.T) {
	f := &fakeCloudflare{zones: []cloudflareZone{{ID: "zone-1", Name: "example.com"}}, failWith: "invalid token"}
	p := newCloudflareForTest(t, f)
	err := p.Set(context.Background(), Record{Domain: "example.com", SubDomain: "@", Type: "A", Value: "192.0.2.1"})
	if err == nil || !strings.Contains(err.Error(), "invalid token") {
		t.Fatalf("error = %v", err)
	}
}

func TestCloudflareDeleteMissingIsFine(t *testing.T) {
	f := &fakeCloudflare{zones: []cloudflareZone{{ID: "zone-1", Name: "example.com"}}}
	p := newCloudflareForTest(t, f)
	if err := p.Delete(context.Background(), Record{Domain: "example.com", SubDomain: "www", Type: "A"}); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestCloudflareTTL(t *testing.T) {
	cases := map[int]int{0: 1, -5: 1, 30: 60, 60: 60, 300: 300, 3600: 3600}
	for in, want := range cases {
		if got := cloudflareTTL(in); got != want {
			t.Fatalf("cloudflareTTL(%d) = %d, want %d", in, got, want)
		}
	}
}
