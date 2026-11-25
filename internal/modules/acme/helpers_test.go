package acme

import (
	"crypto"
	"encoding/pem"
	"testing"
)

// pemTypeOf returns the PEM block type of an encoded key or certificate.
func pemTypeOf(t *testing.T, data []byte) string {
	t.Helper()
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatalf("no pem block found in %q", data)
	}
	return block.Type
}

// publicKeyEqual compares two public keys.
func publicKeyEqual(a, b crypto.PublicKey) bool {
	type equaler interface{ Equal(crypto.PublicKey) bool }
	if e, ok := a.(equaler); ok {
		return e.Equal(b)
	}
	return false
}

func TestDirectoryURL(t *testing.T) {
	if got := directoryURL(false); got != letsencryptDirectory {
		t.Fatalf("production directory = %q", got)
	}
	if got := directoryURL(true); got != letsencryptStagingDirectory {
		t.Fatalf("staging directory = %q", got)
	}
}

func TestAuthorizationCoversRequestedDomains(t *testing.T) {
	domains := []string{"example.com", "*.example.com", "www.example.org"}
	for _, id := range []string{"example.com", "www.example.org"} {
		if !authorizationCovers(domains, id) {
			t.Fatalf("authorization for %q should be accepted", id)
		}
	}
	// A wildcard order authorises the base name, which is what the CA returns.
	if !authorizationCovers(domains, "example.com") {
		t.Fatal("the base of a wildcard must be accepted")
	}
	for _, id := range []string{"victim.example", "www.example.com", ""} {
		if authorizationCovers(domains, id) {
			t.Fatalf("authorization for %q must be rejected", id)
		}
	}
}
