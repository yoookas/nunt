package acme

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"

	"github.com/nunt/nunt/internal/httpc"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/store"
	"github.com/nunt/nunt/internal/version"
)

// accountManager owns the ACME account key and its Let's Encrypt registration.
// One account is shared by every job because an ACME account is not tied to a
// domain.
type accountManager struct {
	deps *module.Deps
	log  *slog.Logger

	mu      sync.Mutex
	client  *acme.Client
	account *acme.Account
	// directory is the CA directory the current client and registration belong
	// to. It is set by clientFor and used when the registration is persisted.
	directory string
}

// storedAccount is the on disk representation of a registration.
type storedAccount struct {
	Directory string   `json:"directory"`
	URI       string   `json:"uri"`
	Status    string   `json:"status"`
	Contact   []string `json:"contact,omitempty"`
	CreatedAt string   `json:"createdAt,omitempty"`
}

// newAccountManager creates the manager. Nothing touches the disk until the
// first issuance, so the module stays cheap to construct.
func newAccountManager(deps *module.Deps, log *slog.Logger) *accountManager {
	return &accountManager{deps: deps, log: log}
}

// dir returns <DataDir>/acme.
func (m *accountManager) dir() string { return filepath.Join(m.deps.DataDir, "acme") }

// keyPath returns the account key path.
func (m *accountManager) keyPath() string { return filepath.Join(m.dir(), "account.key") }

// accountPath returns the account metadata path.
func (m *accountManager) accountPath() string { return filepath.Join(m.dir(), "account.json") }

// clientFor returns a ready to use ACME client, creating and registering the
// account on first use.
func (m *accountManager) clientFor(ctx context.Context, cfg *model.ACMEConfig) (*acme.Client, error) {
	email := ""
	if cfg != nil {
		email = strings.TrimSpace(cfg.Email)
	}
	if email != "" {
		if _, err := mail.ParseAddress(email); err != nil {
			return nil, fmt.Errorf("invalid contact email %q: %w", email, err)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	directory := directoryURL(cfg != nil && cfg.Staging)
	if m.client != nil && m.directory == directory {
		if err := m.syncContact(ctx, email); err != nil {
			return nil, err
		}
		return m.client, nil
	}
	// The directory changed (staging toggled): drop the client, the account key
	// is shared but the registration belongs to one directory.
	m.client = nil
	m.account = nil
	m.directory = directory

	key, err := m.loadOrCreateKey()
	if err != nil {
		return nil, err
	}
	client := &acme.Client{
		Key:          key,
		DirectoryURL: directory,
		HTTPClient:   httpc.New(60*time.Second, false),
		UserAgent:    version.Name + "/" + version.Version + " (acme)",
	}

	stored, err := m.loadAccount()
	if err != nil {
		return nil, err
	}
	var registered *acme.Account
	if stored != nil && stored.URI != "" && stored.Directory == directory {
		client.KID = acme.KeyID(stored.URI)
		registered, err = client.GetReg(ctx, stored.URI)
		if err != nil {
			// The stored registration may belong to another key or may have
			// been deactivated: register again with the current key.
			m.log.Warn("acme: stored account is unusable, registering again", "error", err)
			client.KID = ""
			registered, err = m.register(ctx, client, email)
			if err != nil {
				return nil, err
			}
		}
	} else {
		registered, err = m.register(ctx, client, email)
		if err != nil {
			return nil, err
		}
	}

	if err := m.saveAccount(registered); err != nil {
		return nil, err
	}
	m.client = client
	m.account = registered
	if err := m.syncContact(ctx, email); err != nil {
		return nil, err
	}
	m.log.Info("acme account ready", "directory", directory, "account", registered.URI)
	return m.client, nil
}

// register creates the account, accepting the terms of service.
func (m *accountManager) register(ctx context.Context, client *acme.Client, email string) (*acme.Account, error) {
	acct := &acme.Account{}
	if email != "" {
		acct.Contact = []string{"mailto:" + email}
	}
	registered, err := client.Register(ctx, acct, acme.AcceptTOS)
	if err != nil {
		return nil, fmt.Errorf("register acme account on %s: %w", client.DirectoryURL, err)
	}
	return registered, nil
}

// syncContact keeps the registration in sync with the configured address.
func (m *accountManager) syncContact(ctx context.Context, email string) error {
	if m.account == nil || m.client == nil {
		return nil
	}
	want := ""
	if email != "" {
		want = "mailto:" + email
	}
	if want == "" || (len(m.account.Contact) == 1 && m.account.Contact[0] == want) {
		return nil
	}
	updated := *m.account
	updated.Contact = []string{want}
	res, err := m.client.UpdateReg(ctx, &updated)
	if err != nil {
		return fmt.Errorf("update acme account contact: %w", err)
	}
	m.account = res
	return m.saveAccount(res)
}

// loadOrCreateKey reads the account key, generating an ECDSA P-256 key on
// first use. The key never leaves the data directory.
func (m *accountManager) loadOrCreateKey() (*ecdsa.PrivateKey, error) {
	path := m.keyPath()
	data, err := os.ReadFile(path)
	if err == nil {
		key, err := parseAccountKey(data)
		if err != nil {
			return nil, fmt.Errorf("parse account key %s: %w", path, err)
		}
		return key, nil
	}
	if !store.IsNotExist(err) {
		return nil, fmt.Errorf("read account key %s: %w", path, err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate account key: %w", err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode account key: %w", err)
	}
	block := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if err := store.WriteFileAtomic(path, block, 0o600); err != nil {
		return nil, fmt.Errorf("persist account key: %w", err)
	}
	m.log.Info("acme account key created", "path", path)
	return key, nil
}

// parseAccountKey decodes a PEM encoded ECDSA private key.
func parseAccountKey(data []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("no pem block found")
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("account key is %T, expected an ecdsa key", parsed)
	}
	return key, nil
}

// loadAccount reads the stored registration; a missing file is not an error.
func (m *accountManager) loadAccount() (*storedAccount, error) {
	path := m.accountPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if store.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read account file %s: %w", path, err)
	}
	var acct storedAccount
	if err := json.Unmarshal(data, &acct); err != nil {
		return nil, fmt.Errorf("decode account file %s: %w", path, err)
	}
	return &acct, nil
}

// saveAccount persists the registration atomically with 0600 permissions.
func (m *accountManager) saveAccount(acct *acme.Account) error {
	if acct == nil {
		return nil
	}
	directory := m.directory
	if directory == "" {
		directory = letsencryptDirectory
	}
	rec := storedAccount{
		Directory: directory,
		URI:       acct.URI,
		Status:    acct.Status,
		Contact:   acct.Contact,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if prev, err := m.loadAccount(); err == nil && prev != nil && prev.CreatedAt != "" {
		rec.CreatedAt = prev.CreatedAt
	}
	if err := store.WriteJSONAtomic(m.accountPath(), rec, 0o600); err != nil {
		return fmt.Errorf("persist acme account: %w", err)
	}
	return nil
}
