package acme

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
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

// accountManager owns the ACME account key and one registration per directory.
// An ACME account is not tied to a domain, but it does belong to one CA, so a
// job may pick a different CA and get its own registration while sharing the
// account key.
type accountManager struct {
	deps *module.Deps
	log  *slog.Logger

	mu       sync.Mutex
	clients  map[string]*acme.Client
	accounts map[string]*acme.Account
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
	return &accountManager{
		deps:     deps,
		log:      log,
		clients:  map[string]*acme.Client{},
		accounts: map[string]*acme.Account{},
	}
}

// dir returns <DataDir>/acme.
func (m *accountManager) dir() string { return filepath.Join(m.deps.DataDir, "acme") }

// keyPath returns the account key path.
func (m *accountManager) keyPath() string { return filepath.Join(m.dir(), "account.key") }

// accountPath returns the account metadata path of one directory. The
// directory URL is hashed so several CAs never share a registration file.
func (m *accountManager) accountPath(directory string) string {
	sum := sha256.Sum256([]byte(directory))
	return filepath.Join(m.dir(), "account-"+hex.EncodeToString(sum[:8])+".json")
}

// clientFor returns a ready to use ACME client for the job level CA (an empty
// ca follows the instance default), creating and registering the account on
// first use.
func (m *accountManager) clientFor(ctx context.Context, cfg *model.ACMEConfig, ca string) (*acme.Client, error) {
	effective := model.ACMEConfig{}
	if cfg != nil {
		effective = *cfg
	}
	if strings.TrimSpace(ca) != "" {
		effective.CA = ca
	}
	dir, err := directoryURL(&effective)
	if err != nil {
		return nil, err
	}
	email := strings.TrimSpace(effective.Email)
	if email != "" {
		if _, err := mail.ParseAddress(email); err != nil {
			return nil, fmt.Errorf("invalid contact email %q: %w", email, err)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if client := m.clients[dir]; client != nil {
		if err := m.syncContact(ctx, client, m.accounts[dir], email, dir); err != nil {
			return nil, err
		}
		return client, nil
	}

	key, err := m.loadOrCreateKey()
	if err != nil {
		return nil, err
	}
	client := &acme.Client{
		Key:          key,
		DirectoryURL: dir,
		HTTPClient:   httpc.New(60*time.Second, false),
		UserAgent:    version.Name + "/" + version.Version + " (acme)",
	}

	stored, err := m.loadAccount(dir)
	if err != nil {
		return nil, err
	}
	var registered *acme.Account
	if stored != nil && stored.URI != "" {
		client.KID = acme.KeyID(stored.URI)
		registered, err = client.GetReg(ctx, stored.URI)
		if err != nil {
			// The stored registration may belong to another key or may have
			// been deactivated: register again with the current key.
			m.log.Warn("acme: stored account is unusable, registering again", "directory", dir, "error", err)
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

	if err := m.saveAccount(registered, dir); err != nil {
		return nil, err
	}
	m.clients[dir] = client
	m.accounts[dir] = registered
	if err := m.syncContact(ctx, client, registered, email, dir); err != nil {
		return nil, err
	}
	m.log.Info("acme account ready", "directory", dir, "account", registered.URI)
	return client, nil
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

// syncContact keeps the registration of one directory in sync with the
// configured address.
func (m *accountManager) syncContact(ctx context.Context, client *acme.Client, acct *acme.Account, email, directory string) error {
	if acct == nil || client == nil {
		return nil
	}
	want := ""
	if email != "" {
		want = "mailto:" + email
	}
	if want == "" || (len(acct.Contact) == 1 && acct.Contact[0] == want) {
		return nil
	}
	updated := *acct
	updated.Contact = []string{want}
	res, err := client.UpdateReg(ctx, &updated)
	if err != nil {
		return fmt.Errorf("update acme account contact: %w", err)
	}
	m.accounts[directory] = res
	return m.saveAccount(res, directory)
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

// loadAccount reads the stored registration of one directory; a missing file
// is not an error.
func (m *accountManager) loadAccount(directory string) (*storedAccount, error) {
	path := m.accountPath(directory)
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

// saveAccount persists the registration of one directory atomically with 0600
// permissions.
func (m *accountManager) saveAccount(acct *acme.Account, directory string) error {
	if acct == nil {
		return nil
	}
	rec := storedAccount{
		Directory: directory,
		URI:       acct.URI,
		Status:    acct.Status,
		Contact:   acct.Contact,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if prev, err := m.loadAccount(directory); err == nil && prev != nil && prev.CreatedAt != "" {
		rec.CreatedAt = prev.CreatedAt
	}
	if err := store.WriteJSONAtomic(m.accountPath(directory), rec, 0o600); err != nil {
		return fmt.Errorf("persist acme account: %w", err)
	}
	return nil
}
