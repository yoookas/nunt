package acme

import (
	"strings"
	"testing"
)

// TestDirectoryURL pins the directory endpoint of every supported CA.
func TestDirectoryURL(t *testing.T) {
	cases := []struct {
		name string
		cfg  acmeConfig
		want string
	}{
		{"default", acmeConfig{ca: "letsencrypt"}, "https://acme-v02.api.letsencrypt.org/directory"},
		{"empty", acmeConfig{}, "https://acme-v02.api.letsencrypt.org/directory"},
		{"staging", acmeConfig{ca: "letsencrypt-staging"}, "https://acme-staging-v02.api.letsencrypt.org/directory"},
		{"zerossl", acmeConfig{ca: "zerossl"}, "https://acme.zerossl.com/v2/DV90"},
		{"buypass", acmeConfig{ca: "buypass"}, "https://api.buypass.com/acme/directory"},
		{"custom", acmeConfig{ca: "custom", custom: "https://ca.internal/directory"}, "https://ca.internal/directory"},
		{"mixed case", acmeConfig{ca: "  LetsEncrypt  "}, "https://acme-v02.api.letsencrypt.org/directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.cfg.url()
			if err != nil {
				t.Fatalf("directoryURL: %v", err)
			}
			if got != tc.want {
				t.Fatalf("directoryURL = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestDirectoryURLErrors covers the rejected configurations.
func TestDirectoryURLErrors(t *testing.T) {
	cases := []struct {
		name string
		cfg  acmeConfig
	}{
		{"unknown", acmeConfig{ca: "startcom"}},
		{"custom without url", acmeConfig{ca: "custom"}},
		{"custom with a bad scheme", acmeConfig{ca: "custom", custom: "ftp://ca.internal/dir"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.cfg.url(); err == nil {
				t.Fatalf("directoryURL(%+v) succeeded, want an error", tc.cfg)
			}
		})
	}
}

// TestDirectoryURLEveryKnownCA makes sure the mapping and the catalog agree.
func TestDirectoryURLEveryKnownCA(t *testing.T) {
	for _, entry := range caCatalog() {
		id := entry["id"]
		if id == "custom" {
			continue
		}
		want, ok := caDirectories[id]
		if !ok {
			t.Fatalf("caCatalog lists %q but caDirectories has no entry", id)
		}
		got, err := (&acmeConfig{ca: id}).url()
		if err != nil {
			t.Fatalf("directoryURL(%q): %v", id, err)
		}
		if got != want {
			t.Fatalf("directoryURL(%q) = %q, want %q", id, got, want)
		}
		if !strings.HasPrefix(got, "https://") {
			t.Fatalf("directoryURL(%q) = %q, want an https endpoint", id, got)
		}
	}
}
