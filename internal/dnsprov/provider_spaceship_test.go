package dnsprov

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

type fakeSpaceship struct {
	mu      sync.Mutex
	records []spaceshipRecord
	put     []spaceshipRecord
	puts    int
	gets    int
}

func (f *fakeSpaceship) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Method {
		case http.MethodGet:
			f.gets++
			take, _ := strconv.Atoi(r.URL.Query().Get("take"))
			skip, _ := strconv.Atoi(r.URL.Query().Get("skip"))
			if take <= 0 || take > 200 {
				take = 200
			}
			end := skip + take
			if end > len(f.records) {
				end = len(f.records)
			}
			if skip > len(f.records) {
				skip = len(f.records)
			}
			page := f.records[skip:end]
			_ = json.NewEncoder(w).Encode(map[string]any{"items": page, "total": len(f.records)})
		case http.MethodPut:
			var body struct {
				Items []spaceshipRecord `json:"items"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.puts++
			f.put = body.Items
			f.records = body.Items
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})
}

func newSpaceshipForTest(t *testing.T, f *fakeSpaceship) *spaceshipProvider {
	t.Helper()
	ts := httptest.NewServer(f.handler())
	t.Cleanup(ts.Close)
	old := spaceshipEndpoint
	spaceshipEndpoint = ts.URL
	t.Cleanup(func() { spaceshipEndpoint = old })
	return &spaceshipProvider{base: newBase(nil), apiKey: "key", apiSecret: "secret"}
}

func TestSpaceshipSetKeepsOtherRecords(t *testing.T) {
	f := &fakeSpaceship{records: []spaceshipRecord{
		{Type: "A", Name: "@", TTL: 3600, Address: "192.0.2.1"},
		{Type: "MX", Name: "@", TTL: 3600, Address: "mail.example.com"},
		{Type: "A", Name: "www", TTL: 300, Address: "192.0.2.9"},
	}}
	p := newSpaceshipForTest(t, f)

	err := p.Set(context.Background(), Record{Domain: "example.com", SubDomain: "www", Type: "A", Value: "192.0.2.10", TTL: 120})
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	if f.puts != 1 {
		t.Fatalf("puts = %d", f.puts)
	}
	var www, mx int
	for _, rec := range f.put {
		switch {
		case rec.Name == "www" && rec.Type == "A":
			www++
			if rec.Address != "192.0.2.10" || rec.TTL != 120 {
				t.Fatalf("www = %+v", rec)
			}
		case rec.Type == "MX":
			mx++
		}
	}
	if www != 1 || mx != 1 || len(f.put) != 3 {
		t.Fatalf("items = %+v", f.put)
	}
}

func TestSpaceshipKeepsBothTXTValuesAtOneName(t *testing.T) {
	f := &fakeSpaceship{}
	p := newSpaceshipForTest(t, f)
	first := Record{Domain: "example.com", SubDomain: "_acme-challenge", Type: "TXT", Value: "value-a"}
	second := first
	second.Value = "value-b"

	if err := p.Set(context.Background(), first); err != nil {
		t.Fatalf("set first: %v", err)
	}
	if err := p.Set(context.Background(), second); err != nil {
		t.Fatalf("set second: %v", err)
	}
	if len(f.put) != 2 {
		t.Fatalf("zone = %+v, want both TXT values", f.put)
	}

	if err := p.Delete(context.Background(), first); err != nil {
		t.Fatalf("delete first: %v", err)
	}
	if len(f.put) != 1 || f.put[0].Address != "value-b" {
		t.Fatalf("zone after delete = %+v", f.put)
	}
}

func TestSpaceshipDeleteKeepsOtherRecords(t *testing.T) {
	f := &fakeSpaceship{records: []spaceshipRecord{
		{Type: "A", Name: "www", Address: "192.0.2.9"},
		{Type: "A", Name: "@", Address: "192.0.2.1"},
	}}
	p := newSpaceshipForTest(t, f)
	if err := p.Delete(context.Background(), Record{Domain: "example.com", SubDomain: "www", Type: "A"}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(f.put) != 1 || f.put[0].Name != "@" {
		t.Fatalf("items = %+v", f.put)
	}

	// Deleting something that is not there must not rewrite the zone.
	before := f.puts
	if err := p.Delete(context.Background(), Record{Domain: "example.com", SubDomain: "missing", Type: "A"}); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
	if f.puts != before {
		t.Fatal("a no-op delete must not PUT the zone")
	}
}

func TestSpaceshipPagination(t *testing.T) {
	f := &fakeSpaceship{}
	for i := 0; i < 450; i++ {
		f.records = append(f.records, spaceshipRecord{Type: "TXT", Name: "r" + strconv.Itoa(i), Address: "x"})
	}
	p := newSpaceshipForTest(t, f)
	items, err := p.list(context.Background(), "example.com")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 450 {
		t.Fatalf("items = %d, want 450 (pagination)", len(items))
	}
	if f.gets < 3 {
		t.Fatalf("gets = %d, want at least 3 pages", f.gets)
	}
}

func TestSpaceshipRequiresBothCredentials(t *testing.T) {
	registry := Default()
	if _, err := registry.New("spaceship", Credentials{"apikey": "k"}); err == nil {
		t.Fatal("a missing secret must be rejected")
	}
	provider, err := registry.New("spaceship", Credentials{"apikey": "k", "apisecret": "s"})
	if err != nil || provider == nil {
		t.Fatalf("valid credentials: %v", err)
	}
}
