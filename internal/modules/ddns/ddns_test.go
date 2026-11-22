package ddns

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"github.com/robfig/cron/v3"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/secret"
)

func TestFirstIP(t *testing.T) {
	cases := []struct {
		in     string
		family string
		want   string
	}{
		{"1.2.3.4", "4", "1.2.3.4"},
		{"your ip is 203.0.113.7 today", "4", "203.0.113.7"},
		{"2001:db8::1", "6", "2001:db8::1"},
		{"your ip is 2001:db8::1 ok", "6", "2001:db8::1"},
		{"1.2.3.4", "6", ""},
		{"2001:db8::1", "4", ""},
		{"nothing to see", "4", ""},
	}
	for _, c := range cases {
		if got := firstIP(c.in, c.family); got != c.want {
			t.Fatalf("firstIP(%q, %q) = %q, want %q", c.in, c.family, got, c.want)
		}
	}
}

func TestUsableAddresses(t *testing.T) {
	good4 := []string{"8.8.8.8", "203.0.113.9"}
	bad4 := []string{"127.0.0.1", "169.254.1.1", "::1", "2001:db8::1"}
	for _, s := range good4 {
		if !usableV4(net.ParseIP(s)) {
			t.Fatalf("%s must be usable", s)
		}
	}
	for _, s := range bad4 {
		if usableV4(net.ParseIP(s)) {
			t.Fatalf("%s must not be usable", s)
		}
	}
	good6 := []string{"2001:db8::1"}
	bad6 := []string{"::1", "fe80::1", "fd00::1", "1.2.3.4"}
	for _, s := range good6 {
		if !usableV6(net.ParseIP(s)) {
			t.Fatalf("%s must be usable", s)
		}
	}
	for _, s := range bad6 {
		if usableV6(net.ParseIP(s)) {
			t.Fatalf("%s must not be usable", s)
		}
	}
}

func TestDetectIPStaticMode(t *testing.T) {
	ctx := context.Background()
	ip, err := detectIP(ctx, model.GetIP{Mode: "static", Value: "203.0.113.5"}, "4")
	if err != nil || ip != "203.0.113.5" {
		t.Fatalf("static ipv4 = %q, %v", ip, err)
	}
	if _, err := detectIP(ctx, model.GetIP{Mode: "static", Value: "203.0.113.5"}, "6"); err == nil {
		t.Fatal("an ipv4 address must be rejected for the ipv6 slot")
	}
	if _, err := detectIP(ctx, model.GetIP{Mode: "static", Value: "not-an-ip"}, "4"); err == nil {
		t.Fatal("an invalid address must be rejected")
	}
}

func TestDetectIPRemoteMode(t *testing.T) {
	ctx := context.Background()
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("203.0.113.42"))
	}))
	defer plain.Close()
	ip, err := detectIP(ctx, model.GetIP{Mode: "url", Value: plain.URL}, "4")
	if err != nil || ip != "203.0.113.42" {
		t.Fatalf("url mode = %q, %v", ip, err)
	}

	withRegex := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("current=198.51.100.9;ttl=60"))
	}))
	defer withRegex.Close()
	ip, err = detectIP(ctx, model.GetIP{Mode: "url", Value: withRegex.URL, Regex: "current=([0-9.]+)"}, "4")
	if err != nil || ip != "198.51.100.9" {
		t.Fatalf("regex mode = %q, %v", ip, err)
	}

}

func TestInterfaceDetectionFailsClearly(t *testing.T) {
	if _, err := interfaceIP("definitely-not-an-interface", "4"); err == nil {
		t.Fatal("an unknown interface must report an error")
	}
}

func TestSubDomains(t *testing.T) {
	got := subDomains(&model.DDNSRule{SubDomains: []string{"www", " ", "@"}})
	if len(got) != 2 || got[0] != "www" || got[1] != "@" {
		t.Fatalf("subDomains = %v", got)
	}
	if got := subDomains(&model.DDNSRule{}); len(got) != 1 || got[0] != "@" {
		t.Fatalf("an empty list must default to the root domain, got %v", got)
	}
}

func TestCredentialSealingAndMasking(t *testing.T) {
	box, err := secret.Open(filepath.Join(t.TempDir(), "secret.key"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	d := &DDNS{deps: &module.Deps{Box: box}}

	rule := model.DDNSRule{
		ID:       "r1",
		Provider: "alidns",
		Creds:    map[string]string{"token": "plain-token", "account": "abc"},
	}
	if err := d.sealRule(&rule, nil); err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !secret.IsSealed(rule.Creds["token"]) {
		t.Fatal("credentials must be stored encrypted")
	}

	// A masked value coming back from the UI must not overwrite the stored one.
	update := model.DDNSRule{
		ID:       "r1",
		Provider: "alidns",
		Creds:    map[string]string{"token": secret.Mask(rule.Creds["token"]), "account": "xyz"},
	}
	if err := d.sealRule(&update, &rule); err != nil {
		t.Fatalf("seal update: %v", err)
	}
	if update.Creds["token"] != rule.Creds["token"] {
		t.Fatal("a masked field must keep the stored value")
	}
	if !secret.IsSealed(update.Creds["account"]) || update.Creds["account"] == "xyz" {
		t.Fatal("a changed field must be sealed")
	}

	creds, err := d.credentials(&rule)
	if err != nil || creds["token"] != "plain-token" {
		t.Fatalf("credentials = %v, %v", creds, err)
	}

	masked := maskRule(rule)
	if masked.Creds["token"] == rule.Creds["token"] || masked.Creds["token"] == "plain-token" {
		t.Fatal("maskRule must hide credentials")
	}
}

func TestRuleStateTracking(t *testing.T) {
	box, _ := secret.Open(filepath.Join(t.TempDir(), "secret.key"))
	d := &DDNS{
		deps:    &module.Deps{Box: box},
		entries: map[string]cron.EntryID{},
		states:  map[string]*ruleState{},
		locks:   map[string]*sync.Mutex{},
	}
	st := d.state("missing")
	if st == nil {
		t.Fatal("state must be created on demand")
	}
	st.record(true, "updated example.com")
	st.record(false, "provider refused")
	snap := st.snapshot()
	if snap.lastRun.IsZero() {
		t.Fatal("lastRun must be recorded")
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.success != 1 || st.failures != 1 || len(st.records) != 2 {
		t.Fatalf("unexpected counters: %d/%d/%d", st.success, st.failures, len(st.records))
	}
}
