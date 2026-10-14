package acme

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
)

// Key type selectors accepted by the certificate jobs.
const (
	keyEC256   = "ec256"
	keyEC384   = "ec384"
	keyRSA2048 = "rsa2048"
	keyRSA4096 = "rsa4096"
)

// keyCatalog lists the selectable key types for the UI.
func keyCatalog() []map[string]string {
	return []map[string]string{
		{"id": keyEC256, "title": "ECDSA P-256"},
		{"id": keyEC384, "title": "ECDSA P-384"},
		{"id": keyRSA2048, "title": "RSA 2048"},
		{"id": keyRSA4096, "title": "RSA 4096"},
	}
}

// generateKey creates the certificate private key for a key type selector.
func generateKey(keyType string) (crypto.Signer, error) {
	kind, err := normalizeKeyType(keyType)
	if err != nil {
		return nil, err
	}
	switch kind {
	case keyEC256:
		return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	case keyEC384:
		return ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	case keyRSA2048:
		return rsa.GenerateKey(rand.Reader, 2048)
	case keyRSA4096:
		return rsa.GenerateKey(rand.Reader, 4096)
	default:
		return nil, fmt.Errorf("unsupported key type %q", keyType)
	}
}

// publicKeyAlgorithm reports the x509 algorithm of a signer.
func publicKeyAlgorithm(key crypto.Signer) x509.PublicKeyAlgorithm {
	switch key.Public().(type) {
	case *ecdsa.PublicKey:
		return x509.ECDSA
	case *rsa.PublicKey:
		return x509.RSA
	default:
		return x509.UnknownPublicKeyAlgorithm
	}
}

// encodeKeyPEM serialises a private key as PEM. ECDSA keys use SEC 1 (the
// format every ACME client writes) and RSA keys PKCS#1, so the stored key
// stays readable by openssl and other tools.
func encodeKeyPEM(key crypto.Signer) ([]byte, error) {
	switch k := key.(type) {
	case *ecdsa.PrivateKey:
		der, err := x509.MarshalECPrivateKey(k)
		if err != nil {
			return nil, fmt.Errorf("encode ecdsa key: %w", err)
		}
		return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
	case *rsa.PrivateKey:
		der := x509.MarshalPKCS1PrivateKey(k)
		return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: der}), nil
	default:
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, fmt.Errorf("encode private key: %w", err)
		}
		return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
	}
}
