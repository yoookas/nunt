package dnsprov

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A TXT set has several values during an ACME dns-01 validation; the write has
// to carry the existing ones over instead of replacing the set.
func TestDESECSetMergesTXTValues(t *testing.T) {
	var written []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(desecRRset{
				Type:    "TXT",
				Records: []string{`"pending-challenge"`},
			})
		case http.MethodPut, http.MethodPost:
			var payload desecRRset
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode payload: %v", err)
			}
			written = payload.Records
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	p := &desecProvider{base: newBase(Credentials{"token": "t"}), token: "t", api: server.URL}
	rec := Record{Domain: "example.com", SubDomain: "_acme-challenge", Type: "TXT", Value: "new-challenge", TTL: 60}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("set: %v", err)
	}
	joined := strings.Join(written, ",")
	if !strings.Contains(joined, "pending-challenge") {
		t.Fatalf("the pending value was dropped: %v", written)
	}
	if !strings.Contains(joined, "new-challenge") {
		t.Fatalf("the new value was not written: %v", written)
	}
}

// GoDaddy replaces the whole set on PUT, so the merge happens before the
// request is sent.
func TestGoDaddySetMergesTXTValues(t *testing.T) {
	var written []goDaddyRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode([]goDaddyRecord{{Data: "pending", Name: "_acme-challenge", TTL: 600}})
		case http.MethodPut:
			if err := json.NewDecoder(r.Body).Decode(&written); err != nil {
				t.Errorf("decode payload: %v", err)
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	p := &goDaddyProvider{base: newBase(Credentials{"key": "k", "secret": "s"}), auth: "sso-key k:s", api: server.URL}
	rec := Record{Domain: "example.com", SubDomain: "_acme-challenge", Type: "TXT", Value: "new", TTL: 600}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("set: %v", err)
	}
	var seen []string
	for _, r := range written {
		seen = append(seen, r.Data)
	}
	if strings.Join(seen, ",") != "pending,new" {
		t.Fatalf("written records = %v", seen)
	}
}

// A non-TXT record keeps the replace semantics: the old address must be gone.
func TestGoDaddySetReplacesARecord(t *testing.T) {
	var written []goDaddyRecord
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode([]goDaddyRecord{{Data: "192.0.2.1", Name: "home", TTL: 600}})
		case http.MethodPut:
			_ = json.NewDecoder(r.Body).Decode(&written)
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	p := &goDaddyProvider{base: newBase(Credentials{"key": "k", "secret": "s"}), auth: "sso-key k:s", api: server.URL}
	rec := Record{Domain: "example.com", SubDomain: "home", Type: "A", Value: "192.0.2.2", TTL: 600}
	if err := p.Set(context.Background(), rec); err != nil {
		t.Fatalf("set: %v", err)
	}
	if len(written) != 1 || written[0].Data != "192.0.2.2" {
		t.Fatalf("written records = %+v", written)
	}
}

// The request path and headers the providers build are part of the contract
// with the API, so they are pinned here.
func TestDESECRequestShape(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	p := &desecProvider{base: newBase(Credentials{"token": "t"}), token: "t", api: server.URL}
	if _, err := p.find(context.Background(), Record{Domain: "example.com", SubDomain: "www", Type: "A"}); err != nil {
		t.Fatalf("find: %v", err)
	}
	if !strings.HasSuffix(gotPath, "/domains/example.com/rrsets/www/A/") {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Token t" {
		t.Fatalf("authorization = %q", gotAuth)
	}
}

// A failing read must stop the write: sending an empty set would delete the
// other values.
func TestDESECSetFailsWhenTheReadFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		t.Errorf("a write was attempted after a failed read")
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	defer server.Close()

	p := &desecProvider{base: newBase(Credentials{"token": "t"}), token: "t", api: server.URL}
	rec := Record{Domain: "example.com", SubDomain: "_acme-challenge", Type: "TXT", Value: "v"}
	if err := p.Set(context.Background(), rec); err == nil {
		t.Fatal("Set succeeded after the read failed")
	}
}
