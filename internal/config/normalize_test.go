package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// The renewal window is capped while the configuration is normalised so an old
// configuration that asked for 365 days cannot renew a 90 day certificate on
// every check.
func TestNormalizeCapsRenewDays(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{0, 30}, {365, 30}, {7, 7}} {
		cfg := Default()
		cfg.ACME.Jobs = []model.CertJob{{
			ID: "job-1", Domains: []string{"a.example.com"}, RenewDays: tc.in,
		}}
		Normalize(cfg)
		if got := cfg.ACME.Jobs[0].RenewDays; got != tc.want {
			t.Fatalf("renewDays %d normalised to %d, want %d", tc.in, got, tc.want)
		}
	}
}

// Concurrent updates must all land: the file write happens outside the read
// lock, so writers are serialised separately.
func TestConcurrentUpdatesDoNotLoseChanges(t *testing.T) {
	store, _, err := Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	const n = 8
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := store.Update(func(c *model.Config) error {
				c.Tasks.Items = append(c.Tasks.Items, model.Task{
					ID: fmt.Sprintf("t-%d", i), Name: "x", Cron: "0 3 * * *", Enable: true,
				})
				return nil
			}); err != nil {
				t.Errorf("update %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()
	if got := len(store.Snapshot().Tasks.Items); got != n {
		t.Fatalf("%d updates produced %d tasks", n, got)
	}
}

// A subscriber that mutates the snapshot it receives must not affect another
// subscriber or the stored configuration.
func TestSubscribersGetIndependentSnapshots(t *testing.T) {
	store, _, err := Load(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	var seen string
	store.Subscribe(func(c *model.Config) {
		c.System.LogLevel = "mutated-by-first"
	})
	store.Subscribe(func(c *model.Config) {
		seen = c.System.LogLevel
	})
	if err := store.Update(func(c *model.Config) error { c.System.LogLevel = "info"; return nil }); err != nil {
		t.Fatalf("update: %v", err)
	}
	if seen != "info" {
		t.Fatalf("the second subscriber saw %q", seen)
	}
	if got := store.Snapshot().System.LogLevel; got != "info" {
		t.Fatalf("the stored configuration was mutated: %q", got)
	}
}

// An enabled rule may only name a provider this build ships; a disabled draft
// is allowed to stay incomplete.
func TestValidateRejectsUnknownDNSProviders(t *testing.T) {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1", Username: "admin", Role: "admin", Enabled: true}}
	cfg.DDNS.Rules = []model.DDNSRule{{
		ID: "r1", Name: "home", Enable: true, Domain: "example.com", Provider: "cloudflare",
	}}
	err := Validate(cfg)
	if err == nil || !strings.Contains(err.Error(), "unknown DNS provider") {
		t.Fatalf("an unknown provider was accepted: %v", err)
	}

	cfg.DDNS.Rules[0].Provider = "alidns"
	if err := Validate(cfg); err != nil {
		t.Fatalf("alidns was rejected: %v", err)
	}

	cfg.DDNS.Rules[0].Enable = false
	cfg.DDNS.Rules[0].Provider = "nope"
	if err := Validate(cfg); err != nil {
		t.Fatalf("a disabled draft was rejected: %v", err)
	}

	cfg.ACME.Jobs = []model.CertJob{{
		ID: "j1", Name: "cert", Enable: true, Domains: []string{"a.example.com"},
		Challenge: "dns", DNSProvider: "cloudflare",
	}}
	if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), "unknown DNS provider") {
		t.Fatalf("an unknown certificate provider was accepted: %v", err)
	}
}
