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
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	info, err := store.Add(nil, certPEM, keyPEM, "upload", "", "", true)
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

// selfSignedPair builds a certificate and key for tests.
func selfSignedPair(t *testing.T, cn string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		DNSNames:     []string{"example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

// A replaced certificate is swapped in atomically: a reader can only ever load
// a matching certificate and key pair, and no temporary directory survives.
func TestAddReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	certA, keyA := selfSignedPair(t, "first")
	if _, err := s.Add([]string{"example.com"}, certA, keyA, "manual", "", "", false); err != nil {
		t.Fatalf("add A: %v", err)
	}
	certB, keyB := selfSignedPair(t, "second")
	if _, err := s.Add([]string{"example.com"}, certB, keyB, "manual", "", "", false); err != nil {
		t.Fatalf("add B: %v", err)
	}

	// A fresh store must load the replacement, not a mix of the two.
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	info, ok := reopened.Get(IDFor([]string{"example.com"}))
	if !ok {
		t.Fatal("the certificate was not loaded")
	}
	if info.Source != "manual" {
		t.Fatalf("info = %+v", info)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if len(e.Name()) > 0 && e.Name()[0] == '.' {
			t.Fatalf("temporary directory left behind: %s", e.Name())
		}
	}
}

// Concurrent replacements of the same id must never pair one certificate with
// the key of another: a fresh load verifies the pair.
func TestConcurrentAddKeepsPairsMatched(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			cert, key := selfSignedPair(t, "concurrent")
			if _, err := s.Add([]string{"example.com"}, cert, key, "manual", "", "", false); err != nil {
				t.Errorf("add %d: %v", n, err)
			}
		}(i)
	}
	wg.Wait()
	if _, err := Open(dir); err != nil {
		t.Fatalf("the store does not load after concurrent replacements: %v", err)
	}
}

// A directory that cannot be loaded is skipped, but counted so the system page
// can show it instead of hiding the problem.
func TestOpenCountsBrokenEntries(t *testing.T) {
	dir := t.TempDir()
	good, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	certPEM, keyPEM := selfSignedPair(t, "good")
	if _, err := good.Add([]string{"good.example.com"}, certPEM, keyPEM, "manual", "", "", false); err != nil {
		t.Fatalf("add: %v", err)
	}

	// A directory with a certificate but no key must be skipped.
	broken := filepath.Join(dir, "broken.example.com")
	if err := os.MkdirAll(broken, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(broken, "cert.pem"), certPEM, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := reopened.LoadErrors(); got != 1 {
		t.Fatalf("loadErrors = %d, want 1", got)
	}
	if len(reopened.List()) != 1 {
		t.Fatalf("the good certificate was not loaded: %d", len(reopened.List()))
	}
}

// The remark of an issued certificate is stored with it, so the UI can show
// which job or upload it belongs to.
func TestStoreKeepsRemark(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "certs"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	certPEM, keyPEM := selfSigned(t, []string{"remark.example.com"})
	if _, err := store.Add(nil, certPEM, keyPEM, "acme", "job-1", "主站证书", true); err != nil {
		t.Fatalf("add: %v", err)
	}
	list := store.List()
	if len(list) != 1 || list[0].Remark != "主站证书" {
		t.Fatalf("stored info = %+v", list)
	}
}

// A certificate is uploaded by an administrator and its subject alternative
// names come from the file, so a name such as ".." must not be turned into a
// directory expression by the store.
func TestAddRejectsADomainThatEscapesTheStore(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for _, domain := range []string{".", "..", "a..b", "../../etc"} {
		certPEM, keyPEM := selfSigned(t, []string{domain})
		if _, err := s.Add([]string{domain}, certPEM, keyPEM, "test", "", "", false); err == nil {
			t.Fatalf("Add(%q) succeeded", domain)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read the store directory: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("a rejected add left files behind: %v", entries)
	}
}

// IDFor must only ever produce a single path element, whatever the domain is.
func TestIDForKeepsTheStoreBoundary(t *testing.T) {
	for _, domain := range []string{"../../etc/passwd", `..\..\windows`, "a/b:c d", "*.example.com"} {
		id := IDFor([]string{domain})
		if strings.ContainsAny(id, `/\`) {
			t.Fatalf("IDFor(%q) = %q contains a separator", domain, id)
		}
		if id == "" || id == "." || id == ".." {
			t.Fatalf("IDFor(%q) = %q is not a usable name", domain, id)
		}
	}
	if got := IDFor([]string{"*.Example.COM"}); got != "_wildcard.example.com" {
		t.Fatalf("wildcard id = %q, want _wildcard.example.com", got)
	}
}
