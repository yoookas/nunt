// Package certs stores the TLS certificates used by the web service.
//
// Certificates live in <dir>/<id>/{cert.pem,key.pem,meta.json}. The store is
// safe for concurrent use and serves as tls.Config.GetCertificate, so a
// renewed certificate is picked up without restarting any listener.
package certs

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/store"
)

// Info describes one stored certificate.
type Info struct {
	ID        string    `json:"id"`
	Domains   []string  `json:"domains"`
	Issuer    string    `json:"issuer"`
	NotBefore time.Time `json:"notBefore"`
	NotAfter  time.Time `json:"notAfter"`
	Source    string    `json:"source"`
	JobID     string    `json:"jobId,omitempty"`
	Remark    string    `json:"remark,omitempty"`
	AutoRenew bool      `json:"autoRenew"`
	UpdatedAt time.Time `json:"updatedAt"`
	KeyType   string    `json:"keyType,omitempty"`
}

type entry struct {
	info Info
	cert *tls.Certificate
}

// Store holds every certificate known to the service.
type Store struct {
	dir string
	// mu guards the in-memory index; writeMu serialises the directory swap so
	// two Add calls for the same id can never interleave their renames.
	mu      sync.RWMutex
	writeMu sync.Mutex
	items   map[string]*entry
	// loadErrors counts the directories that could not be loaded at startup,
	// so a silently skipped certificate shows up in the system information.
	loadErrors int
}

// Open loads (or creates) the certificate directory.
func Open(dir string) (*Store, error) {
	if err := store.EnsureDir(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, items: map[string]*entry{}}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read certificate dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		// Leftovers of an interrupted swap (or of a crash) are removed: they
		// are never a valid certificate and must not be loaded.
		if strings.HasPrefix(e.Name(), ".") {
			_ = os.RemoveAll(filepath.Join(dir, e.Name()))
			continue
		}
		if err := s.load(e.Name()); err != nil {
			// A broken certificate must not stop the service, but it must be
			// visible: the count is reported in the system information.
			s.loadErrors++
			continue
		}
	}
	return s, nil
}

// syncDir flushes a directory entry so a renamed certificate survives a crash.
// It is best effort: some platforms refuse to sync a directory.
func syncDir(path string) {
	d, err := os.Open(path)
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}

// Dir returns the certificate directory.
func (s *Store) Dir() string { return s.dir }

// LoadErrors reports how many stored directories could not be loaded at
// startup. They are skipped instead of stopping the service, but an operator
// should still see them.
func (s *Store) LoadErrors() int { return s.loadErrors }

func (s *Store) load(id string) error {
	dir := filepath.Join(s.dir, id)
	var info Info
	if err := store.ReadJSON(filepath.Join(dir, "meta.json"), &info); err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"))
	if err != nil {
		return err
	}
	if cert.Leaf == nil && len(cert.Certificate) > 0 {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
			cert.Leaf = leaf
		}
	}
	info.ID = id
	s.mu.Lock()
	s.items[id] = &entry{info: info, cert: &cert}
	s.mu.Unlock()
	return nil
}

// IDFor derives the directory name of a certificate.
func IDFor(domains []string) string {
	if len(domains) == 0 {
		return "unnamed"
	}
	id := strings.ToLower(domains[0])
	id = strings.ReplaceAll(id, "*.", "_wildcard.")
	id = strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_").Replace(id)
	if len(id) > 100 {
		id = id[:100]
	}
	return id
}

// Add stores a certificate (chain + key) and returns its metadata.
func (s *Store) Add(domains []string, certPEM, keyPEM []byte, source, jobID, remark string, autoRenew bool) (Info, error) {
	if len(certPEM) == 0 || len(keyPEM) == 0 {
		return Info{}, fmt.Errorf("certificate and key are required")
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return Info{}, fmt.Errorf("parse key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return Info{}, fmt.Errorf("parse certificate: %w", err)
	}
	cert.Leaf = leaf

	if len(domains) == 0 {
		domains = leaf.DNSNames
		if len(domains) == 0 && leaf.Subject.CommonName != "" {
			domains = []string{leaf.Subject.CommonName}
		}
	}
	id := IDFor(domains)
	info := Info{
		ID:        id,
		Domains:   domains,
		Issuer:    leaf.Issuer.CommonName,
		NotBefore: leaf.NotBefore,
		NotAfter:  leaf.NotAfter,
		Source:    source,
		JobID:     jobID,
		Remark:    remark,
		AutoRenew: autoRenew,
		UpdatedAt: time.Now(),
		KeyType:   keyTypeOf(leaf),
	}
	dir := filepath.Join(s.dir, id)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Build the new certificate in a temporary directory and swap it in with
	// renames. A crash therefore leaves either the old pair or the new pair,
	// never a certificate next to the key of another one.
	tmp, err := os.MkdirTemp(s.dir, ".tmp-")
	if err != nil {
		return Info{}, err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	if err := store.WriteFileAtomic(filepath.Join(tmp, "cert.pem"), certPEM, 0o600); err != nil {
		return Info{}, err
	}
	if err := store.WriteFileAtomic(filepath.Join(tmp, "key.pem"), keyPEM, 0o600); err != nil {
		return Info{}, err
	}
	if err := store.WriteJSONAtomic(filepath.Join(tmp, "meta.json"), info, 0o600); err != nil {
		return Info{}, err
	}
	syncDir(tmp)

	backup := ""
	if _, statErr := os.Stat(dir); statErr == nil {
		backup = filepath.Join(s.dir, ".old-"+id)
		if err := os.RemoveAll(backup); err != nil {
			return Info{}, err
		}
		if err := os.Rename(dir, backup); err != nil {
			return Info{}, err
		}
	}
	if err := os.Rename(tmp, dir); err != nil {
		if backup != "" {
			_ = os.Rename(backup, dir)
		}
		return Info{}, err
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}
	syncDir(s.dir)

	s.mu.Lock()
	s.items[id] = &entry{info: info, cert: &cert}
	s.mu.Unlock()
	return info, nil
}

func keyTypeOf(leaf *x509.Certificate) string {
	switch leaf.PublicKeyAlgorithm {
	case x509.RSA:
		return "rsa"
	case x509.ECDSA:
		return "ecdsa"
	case x509.Ed25519:
		return "ed25519"
	default:
		return "unknown"
	}
}

// List returns every certificate, newest first.
func (s *Store) List() []Info {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Info, 0, len(s.items))
	for _, e := range s.items {
		out = append(out, e.info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NotAfter.Before(out[j].NotAfter) })
	return out
}

// Get returns the metadata of one certificate.
func (s *Store) Get(id string) (Info, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.items[id]
	if !ok {
		return Info{}, false
	}
	return e.info, true
}

// validID rejects ids that could escape the certificate directory.
func validID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	if strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") {
		return false
	}
	return true
}

// Delete removes a certificate from disk and memory.
func (s *Store) Delete(id string) error {
	if !validID(id) {
		return fmt.Errorf("invalid certificate id")
	}
	s.mu.Lock()
	delete(s.items, id)
	s.mu.Unlock()
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return os.RemoveAll(filepath.Join(s.dir, id))
}

// Has reports whether a usable certificate exists for a domain.
func (s *Store) Has(domain string) bool {
	_, ok := s.lookup(domain)
	return ok
}

func (s *Store) lookup(domain string) (*entry, bool) {
	domain = netutil.HostOnly(domain)
	if domain == "" {
		return nil, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now()
	for _, e := range s.items {
		if now.After(e.info.NotAfter) {
			continue
		}
		for _, d := range e.info.Domains {
			if strings.EqualFold(d, domain) {
				return e, true
			}
		}
	}
	// wildcard match
	parts := strings.Split(domain, ".")
	for i := 1; i < len(parts)-1; i++ {
		wild := "*." + strings.Join(parts[i:], ".")
		for _, e := range s.items {
			if now.After(e.info.NotAfter) {
				continue
			}
			for _, d := range e.info.Domains {
				if strings.EqualFold(d, wild) {
					return e, true
				}
			}
		}
	}
	return nil, false
}

// GetCertificate implements tls.Config.GetCertificate.
func (s *Store) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if hello == nil {
		return nil, fmt.Errorf("no client hello")
	}
	if e, ok := s.lookup(hello.ServerName); ok {
		return e.cert, nil
	}
	// Fall back to any valid certificate so monitoring probes that connect by
	// IP address still complete the handshake.
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now()
	for _, e := range s.items {
		if now.Before(e.info.NotAfter) {
			return e.cert, nil
		}
	}
	return nil, fmt.Errorf("no certificate available for %q", hello.ServerName)
}

// TLSConfig returns a hardened configuration backed by this store.
func (s *Store) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: s.GetCertificate,
		NextProtos:     []string{"h2", "http/1.1"},
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		},
	}
}

// DueForRenew returns certificates expiring within d.
func (s *Store) DueForRenew(d time.Duration) []Info {
	limit := time.Now().Add(d)
	var out []Info
	for _, info := range s.List() {
		if info.AutoRenew && info.NotAfter.Before(limit) {
			out = append(out, info)
		}
	}
	return out
}

// PEMBundle returns the stored chain and key of a certificate.
func (s *Store) PEMBundle(id string) (certPEM, keyPEM []byte, err error) {
	if !validID(id) {
		return nil, nil, fmt.Errorf("invalid certificate id")
	}
	dir := filepath.Join(s.dir, id)
	certPEM, err = os.ReadFile(filepath.Join(dir, "cert.pem"))
	if err != nil {
		return nil, nil, err
	}
	keyPEM, err = os.ReadFile(filepath.Join(dir, "key.pem"))
	if err != nil {
		return nil, nil, err
	}
	return certPEM, keyPEM, nil
}

// EncodePEM is a helper for callers that build PEM blocks themselves.
func EncodePEM(typ string, der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der})
}
