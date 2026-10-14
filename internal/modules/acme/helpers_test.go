package acme

import (
	"crypto"
	"encoding/pem"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// acmeConfig is a compact view of model.ACMEConfig used by the tests.
type acmeConfig struct {
	ca     string
	custom string
	email  string
}

// url resolves the directory of the compact view.
func (c acmeConfig) url() (string, error) {
	return directoryURL(&model.ACMEConfig{CA: c.ca, CACustomURL: c.custom, Email: c.email})
}

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
