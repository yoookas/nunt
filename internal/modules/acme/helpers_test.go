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
