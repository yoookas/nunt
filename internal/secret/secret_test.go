package secret

import (
	"path/filepath"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	box, err := Open(filepath.Join(t.TempDir(), "secret.key"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	sealed, err := box.Seal("super-secret-token")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !IsSealed(sealed) || sealed == "super-secret-token" {
		t.Fatalf("unexpected sealed value %q", sealed)
	}
	plain, err := box.Open(sealed)
	if err != nil || plain != "super-secret-token" {
		t.Fatalf("open = %q, %v", plain, err)
	}
	// Plain values written by hand must pass through untouched.
	if plain, err := box.Open("plaintext"); err != nil || plain != "plaintext" {
		t.Fatalf("plain passthrough = %q, %v", plain, err)
	}
	if sealed2, err := box.Seal(sealed); err != nil || sealed2 != sealed {
		t.Fatal("sealing twice must be a no-op")
	}
	if _, err := box.Open("enc:v1:not-base64!!"); err == nil {
		t.Fatal("a corrupted value must not decrypt")
	}
	if Mask("short") != "********" {
		t.Fatal("short secrets must be fully masked")
	}
	if Mask("") != "" {
		t.Fatal("an empty secret stays empty")
	}
}

func TestKeyIsStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.key")
	box1, err := Open(path)
	if err != nil {
		t.Fatalf("open 1: %v", err)
	}
	sealed, _ := box1.Seal("value")
	box2, err := Open(path)
	if err != nil {
		t.Fatalf("open 2: %v", err)
	}
	if plain, err := box2.Open(sealed); err != nil || plain != "value" {
		t.Fatalf("a reopened key must decrypt old values: %q %v", plain, err)
	}
}
