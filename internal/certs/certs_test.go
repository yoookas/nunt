package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"path/filepath"
	"testing"
	"time"
)

func selfSigned(t *testing.T, domains []string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: domains[0]},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              domains,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func TestStoreAddLookupDelete(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	store, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	certPEM, keyPEM := selfSigned(t, []string{"example.com", "*.example.com"})
	info, err := store.Add(nil, certPEM, keyPEM, "upload", "", true)
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if info.ID != "example.com" {
		t.Fatalf("unexpected id %q", info.ID)
	}
	if !store.Has("example.com") || !store.Has("www.example.com") {
		t.Fatal("exact and wildcard lookups must succeed")
	}
	if store.Has("other.org") {
		t.Fatal("an unrelated domain must not match")
	}
	cert, err := store.GetCertificate(&tls.ClientHelloInfo{ServerName: "api.example.com"})
	if err != nil || cert == nil {
		t.Fatalf("GetCertificate: %v", err)
	}
	if len(store.List()) != 1 {
		t.Fatal("the certificate must be listed")
	}
	if due := store.DueForRenew(time.Hour); len(due) != 0 {
		t.Fatal("a fresh certificate must not be due for renewal")
	}
	if due := store.DueForRenew(48 * time.Hour); len(due) != 1 {
		t.Fatal("a certificate expiring within the window must be due")
	}

	// A reopened store must find the certificate on disk again.
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !reopened.Has("example.com") {
		t.Fatal("certificates must survive a restart")
	}
	if err := reopened.Delete(info.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if reopened.Has("example.com") {
		t.Fatal("the certificate must be gone after deletion")
	}
	if err := reopened.Delete("../escape"); err == nil {
		t.Fatal("path traversal in the id must be refused")
	}
}

func TestTLSConfigHardening(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "certs"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cfg := store.TLSConfig()
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Fatalf("minimum version must be TLS 1.2, got %d", cfg.MinVersion)
	}
	if cfg.GetCertificate == nil {
		t.Fatal("GetCertificate must be wired")
	}
	if _, err := store.GetCertificate(&tls.ClientHelloInfo{ServerName: "missing.example"}); err == nil {
		t.Fatal("an empty store must not hand out certificates")
	}
}
