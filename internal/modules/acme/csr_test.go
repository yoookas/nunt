package acme

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"testing"
)

// TestGenerateKeyAndCSR covers every selectable key type: the generated key
// must have the expected algorithm and the CSR must carry the common name, the
// SAN list and a signature that matches the key.
func TestGenerateKeyAndCSR(t *testing.T) {
	domains := []string{"example.com", "www.example.com"}
	cases := []struct {
		keyType string
		alg     x509.PublicKeyAlgorithm
		sigAlg  x509.SignatureAlgorithm
	}{
		{keyEC256, x509.ECDSA, x509.ECDSAWithSHA256},
		{keyEC384, x509.ECDSA, x509.ECDSAWithSHA384},
		{keyRSA2048, x509.RSA, x509.SHA256WithRSA},
	}
	for _, tc := range cases {
		t.Run(tc.keyType, func(t *testing.T) {
			key, err := generateKey(tc.keyType)
			if err != nil {
				t.Fatalf("generateKey(%q): %v", tc.keyType, err)
			}
			if got := publicKeyAlgorithm(key); got != tc.alg {
				t.Fatalf("publicKeyAlgorithm(%q) = %v, want %v", tc.keyType, got, tc.alg)
			}
			switch k := key.(type) {
			case *ecdsa.PrivateKey:
				switch tc.keyType {
				case keyEC256:
					if k.Curve != elliptic.P256() {
						t.Fatalf("curve = %v, want P-256", k.Curve.Params().Name)
					}
				case keyEC384:
					if k.Curve != elliptic.P384() {
						t.Fatalf("curve = %v, want P-384", k.Curve.Params().Name)
					}
				}
			case *rsa.PrivateKey:
				if k.N.BitLen() < 2048 {
					t.Fatalf("rsa key is %d bits, want at least 2048", k.N.BitLen())
				}
			default:
				t.Fatalf("unexpected key type %T", key)
			}

			der, err := createCSR(key, domains)
			if err != nil {
				t.Fatalf("createCSR: %v", err)
			}
			csr, err := x509.ParseCertificateRequest(der)
			if err != nil {
				t.Fatalf("parse csr: %v", err)
			}
			if csr.Subject.CommonName != domains[0] {
				t.Fatalf("common name = %q, want %q", csr.Subject.CommonName, domains[0])
			}
			if len(csr.DNSNames) != len(domains) {
				t.Fatalf("DNS names = %v, want %v", csr.DNSNames, domains)
			}
			for i := range domains {
				if csr.DNSNames[i] != domains[i] {
					t.Fatalf("DNS names = %v, want %v", csr.DNSNames, domains)
				}
			}
			if err := csr.CheckSignature(); err != nil {
				t.Fatalf("csr signature: %v", err)
			}
			if csr.SignatureAlgorithm != tc.sigAlg {
				t.Fatalf("signature algorithm = %v, want %v", csr.SignatureAlgorithm, tc.sigAlg)
			}
		})
	}
}

// TestCreateCSRRejectsEmptyDomains makes sure a CSR is never built for nothing.
func TestCreateCSRRejectsEmptyDomains(t *testing.T) {
	key, err := generateKey(keyEC256)
	if err != nil {
		t.Fatalf("generateKey: %v", err)
	}
	if _, err := createCSR(key, nil); err == nil {
		t.Fatal("createCSR(nil) succeeded, want an error")
	}
}

// TestEncodeKeyPEM checks the PEM type of every generated key and that the
// result can be parsed back into an equivalent public key.
func TestEncodeKeyPEM(t *testing.T) {
	cases := []struct {
		keyType string
		pemType string
	}{
		{keyEC256, "EC PRIVATE KEY"},
		{keyRSA2048, "RSA PRIVATE KEY"},
	}
	for _, tc := range cases {
		t.Run(tc.keyType, func(t *testing.T) {
			key, err := generateKey(tc.keyType)
			if err != nil {
				t.Fatalf("generateKey: %v", err)
			}
			encoded, err := encodeKeyPEM(key)
			if err != nil {
				t.Fatalf("encodeKeyPEM: %v", err)
			}
			if got := pemTypeOf(t, encoded); got != tc.pemType {
				t.Fatalf("pem type = %q, want %q", got, tc.pemType)
			}
			pub, err := publicKeyOf(encoded)
			if err != nil {
				t.Fatalf("publicKeyOf: %v", err)
			}
			if !publicKeyEqual(key.Public(), pub) {
				t.Fatal("the decoded public key differs from the generated one")
			}
		})
	}
}

// TestNormalizeKeyType covers the accepted spellings and the rejections.
func TestNormalizeKeyType(t *testing.T) {
	cases := map[string]string{
		"":        keyEC256,
		"ec256":   keyEC256,
		"EC256":   keyEC256,
		" ec384 ": keyEC384,
		"rsa2048": keyRSA2048,
		"rsa4096": keyRSA4096,
	}
	for in, want := range cases {
		got, err := normalizeKeyType(in)
		if err != nil {
			t.Fatalf("normalizeKeyType(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("normalizeKeyType(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := normalizeKeyType("ec521"); err == nil {
		t.Fatal("normalizeKeyType(ec521) succeeded, want an error")
	}
	if _, err := generateKey("rsa1024"); err == nil {
		t.Fatal("generateKey(rsa1024) succeeded, want an error")
	}
}

// TestKeyCatalogIsNormalizable makes sure the UI catalog matches the parser.
func TestKeyCatalogIsNormalizable(t *testing.T) {
	entries := keyCatalog()
	if len(entries) != 4 {
		t.Fatalf("keyCatalog has %d entries, want 4", len(entries))
	}
	for _, entry := range entries {
		id := entry["id"]
		got, err := normalizeKeyType(id)
		if err != nil {
			t.Fatalf("normalizeKeyType(%q): %v", id, err)
		}
		if got != id {
			t.Fatalf("normalizeKeyType(%q) = %q, want the id itself", id, got)
		}
	}
}
