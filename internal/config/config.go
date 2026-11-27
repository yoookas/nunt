// Package config owns the runtime configuration document.
//
// Modules never write the file directly: they mutate a snapshot through
// Store.Update, which validates, persists atomically and notifies every
// subscriber so long running listeners can reload themselves.
package config

import (
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"
)

// CurrentVersion is the configuration schema version.
//
// Version 2 replaced the single allow/deny access mode with ordered lists. The
// old fields are not migrated: a rule that used to be a whitelist becomes "no
// filtering" on upgrade, which is why Load reports the version it found and the
// application warns about it.
const CurrentVersion = 2

// DefaultAdminListen is the address the admin console listens on until an
// operator changes it. Deployment can override it with NUNT_ADMIN_LISTEN or
// NUNT_ADMIN_PORT (see internal/adminlisten), and the running process can move
// it from the settings page without a restart.
const DefaultAdminListen = ":3113"

// Store is a concurrency safe holder of the configuration.
type Store struct {
	mu sync.RWMutex
	// writeMu serialises writers. Update validates and writes the file outside
	// mu so readers are never blocked by disk I/O; writeMu is what keeps two
	// concurrent updates from losing each other's changes.
	writeMu sync.Mutex
	cfg     *model.Config
	path    string
	subs    []func(*model.Config)
	// loadedVersion is the schema version found on disk (0 when the file did not
	// exist yet). It is kept so a caller can warn about an upgrade that dropped
	// state.
	loadedVersion int
}

// Load reads the configuration from path, creating it with defaults (and a
// freshly generated administrator password) when missing.
func Load(path string) (*Store, string, error) {
	s := &Store{path: path}
	cfg := Default()
	created := false
	var initialPassword string

	if store.Exists(path) {
		if err := store.ReadJSON(path, cfg); err != nil {
			return nil, "", err
		}
		s.loadedVersion = cfg.Version
	} else {
		pw, err := security.RandomPassword(16)
		if err != nil {
			return nil, "", err
		}
		hash, err := security.HashPassword(pw)
		if err != nil {
			return nil, "", err
		}
		cfg.Users = []model.User{{
			ID:                 model.NewID(),
			PasswordHash:       hash,
			MustChangePassword: true,
			CreatedAt:          time.Now(),
		}}
		initialPassword = pw
		created = true
	}

	cfg.Version = CurrentVersion
	Normalize(cfg)
	s.cfg = cfg
	if created {
		if err := store.WriteJSONAtomic(path, cfg, 0o600); err != nil {
			return nil, "", err
		}
	}
	return s, initialPassword, nil
}

// LoadedVersion reports the schema version the loaded file was written with, or
// 0 when the file did not exist yet.
func (s *Store) LoadedVersion() int { return s.loadedVersion }

// Path returns the configuration file path.
func (s *Store) Path() string { return s.path }

// Dir returns the directory holding the configuration file.
func (s *Store) Dir() string { return filepath.Dir(s.path) }

// File returns the base name of the configuration file.
func (s *Store) File() string { return filepath.Base(s.path) }

// Snapshot returns a deep copy of the configuration. Callers may keep and
// modify it freely; changes only become visible through Update.
func (s *Store) Snapshot() *model.Config {
	// The stored pointer is replaced, never mutated in place, so it can be
	// cloned outside the lock: readers are not blocked by the JSON round trip.
	s.mu.RLock()
	cfg := s.cfg
	s.mu.RUnlock()
	return clone(cfg)
}

func clone(c *model.Config) *model.Config {
	out := &model.Config{}
	if err := deepCopy(c, out); err != nil {
		// A JSON round trip can only fail on unsupported values; the model
		// contains plain data, so this is effectively unreachable.
		panic(fmt.Sprintf("config: clone failed: %v", err))
	}
	return out
}

// Update applies fn to the live configuration, persists the result and
// notifies subscribers. When fn returns an error nothing is written.
func (s *Store) Update(fn func(*model.Config) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.mu.RLock()
	next := clone(s.cfg)
	s.mu.RUnlock()

	if err := fn(next); err != nil {
		return err
	}
	next.Version = CurrentVersion
	Normalize(next)
	if err := Validate(next); err != nil {
		return err
	}
	// The file is written without holding mu: readers keep serving the previous
	// configuration until the new one is durable, and they are never stalled by
	// the disk.
	if err := store.WriteJSONAtomic(s.path, next, 0o600); err != nil {
		return err
	}

	s.mu.Lock()
	s.cfg = next
	subs := make([]func(*model.Config), len(s.subs))
	copy(subs, s.subs)
	s.mu.Unlock()

	for _, sub := range subs {
		// Every subscriber gets its own copy: one that keeps or mutates the
		// snapshot cannot influence another.
		sub(clone(next))
	}
	return nil
}

// Subscribe registers a callback invoked after every successful update. The
// callbacks run in registration order and outside mu, but while the writer lock
// is held, so a subscriber must never call Update itself (that would block on
// the same writer) and must not keep the snapshot it receives.
func (s *Store) Subscribe(fn func(*model.Config)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// Admin returns a copy of the administrator account. A configuration without
// an account returns nil; the loader creates the initial one and validation
// refuses to persist an empty list.
func (s *Store) Admin() *model.User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.cfg.Users) == 0 {
		return nil
	}
	u := s.cfg.Users[0]
	return &u
}

// Default returns a configuration with sane defaults.
func Default() *model.Config {
	return &model.Config{
		Version: CurrentVersion,
		System: model.SystemConfig{
			AdminListen:     DefaultAdminListen,
			LogLevel:        "info",
			SessionTTLHours: 12,
			LoginMaxFail:    5,
			LoginLockMin:    10,
			Theme:           "dark",
		},
		Web: model.WebConfig{
			AccessLog: true,
			LogKeep:   200,
		},
		Forward: model.ForwardConfig{AccessLog: true},
		ACME: model.ACMEConfig{
			KeyType: "ec256",
		},
		WAF: model.WAFConfig{
			Mode:              model.WAFModeBlock,
			UseCRS:            true,
			ParanoiaLevel:     1,
			ExecutingLevel:    1,
			InboundThreshold:  5,
			OutboundThreshold: 4,
			BodyLimitKB:       128,
		},
		Logs: model.LogConfig{
			Access: model.AccessLogConfig{
				Persist:   true,
				KeepDays:  7,
				MaxFileMB: 64,
			},
			App: model.AppLogConfig{
				MaxFileMB: 8,
				KeepFiles: 3,
			},
		},
		Backup: model.BackupConfig{
			IntervalHours: 24,
			Keep:          7,
		},
	}
}
