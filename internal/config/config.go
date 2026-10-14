// Package config owns the runtime configuration document.
//
// Modules never write the file directly: they mutate a snapshot through
// Store.Update, which validates, persists atomically and notifies every
// subscriber so long running listeners can reload themselves.
package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"
)

// CurrentVersion is the configuration schema version.
const CurrentVersion = 1

// Store is a concurrency safe holder of the configuration.
type Store struct {
	mu   sync.RWMutex
	cfg  *model.Config
	path string
	subs []func(*model.Config)
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
			Username:           "admin",
			PasswordHash:       hash,
			Role:               "admin",
			Enabled:            true,
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

// Path returns the configuration file path.
func (s *Store) Path() string { return s.path }

// Dir returns the directory holding the configuration file.
func (s *Store) Dir() string { return filepath.Dir(s.path) }

// File returns the base name of the configuration file.
func (s *Store) File() string { return filepath.Base(s.path) }

// Snapshot returns a deep copy of the configuration. Callers may keep and
// modify it freely; changes only become visible through Update.
func (s *Store) Snapshot() *model.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clone(s.cfg)
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
	s.mu.Lock()
	next := clone(s.cfg)
	if err := fn(next); err != nil {
		s.mu.Unlock()
		return err
	}
	next.Version = CurrentVersion
	Normalize(next)
	if err := Validate(next); err != nil {
		s.mu.Unlock()
		return err
	}
	if err := store.WriteJSONAtomic(s.path, next, 0o600); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cfg = next
	subs := make([]func(*model.Config), len(s.subs))
	copy(subs, s.subs)
	s.mu.Unlock()

	snapshot := clone(next)
	for _, fn := range subs {
		fn(snapshot)
	}
	return nil
}

// Subscribe registers a callback invoked (outside the lock) after every
// successful update.
func (s *Store) Subscribe(fn func(*model.Config)) {
	s.mu.Lock()
	s.subs = append(s.subs, fn)
	s.mu.Unlock()
}

// FindUser returns the enabled user with the given name.
func (s *Store) FindUser(name string) (*model.User, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for i := range s.cfg.Users {
		if strings.EqualFold(s.cfg.Users[i].Username, name) {
			u := s.cfg.Users[i]
			return &u, true
		}
	}
	return nil, false
}

// Default returns a configuration with sane defaults.
func Default() *model.Config {
	return &model.Config{
		Version: CurrentVersion,
		System: model.SystemConfig{
			AdminListen:     ":16601",
			LogLevel:        "info",
			SessionTTLHours: 12,
			LoginMaxFail:    5,
			LoginLockMin:    10,
			Theme:           "dark",
			CheckUpdate:     false,
		},
		Web: model.WebConfig{
			AccessLog: true,
			LogKeep:   200,
			RealIP:    true,
		},
		Forward: model.ForwardConfig{AccessLog: true},
		ACME: model.ACMEConfig{
			CA:      "letsencrypt",
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
	}
}
