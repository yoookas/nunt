// Package mounts turns the configured storage backends into vfs file systems
// that the static server, the file browser and the WebDAV server can share.
package mounts

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/vfs"
)

type cacheItem struct {
	fs          vfs.FS
	closer      func() error
	fingerprint string
}

// Manager resolves mount ids to file systems and caches them.
type Manager struct {
	cfg *config.Store
	box *secret.Box
	log *slog.Logger

	mu    sync.Mutex
	cache map[string]cacheItem
}

// New creates a manager bound to the configuration store.
func New(cfg *config.Store, box *secret.Box, log *slog.Logger) *Manager {
	m := &Manager{cfg: cfg, box: box, log: log, cache: map[string]cacheItem{}}
	cfg.Subscribe(func(*model.Config) { m.Invalidate() })
	return m
}

// Invalidate drops every cached backend (called on configuration changes).
func (m *Manager) Invalidate() {
	m.mu.Lock()
	items := m.cache
	m.cache = map[string]cacheItem{}
	m.mu.Unlock()
	for _, item := range items {
		if item.closer != nil {
			_ = item.closer()
		}
	}
}

// List returns the configured mounts.
func (m *Manager) List() []model.Mount {
	return m.cfg.Snapshot().Storage.Mounts
}

// Find returns a mount definition by id.
func (m *Manager) Find(id string) (model.Mount, bool) {
	for _, mnt := range m.List() {
		if mnt.ID == id {
			return mnt, true
		}
	}
	return model.Mount{}, false
}

// Get returns the file system of a mount.
func (m *Manager) Get(id string) (vfs.FS, model.Mount, error) {
	mnt, ok := m.Find(id)
	if !ok {
		return nil, model.Mount{}, fmt.Errorf("mount %q does not exist", id)
	}
	if !mnt.Enable {
		return nil, mnt, fmt.Errorf("mount %q is disabled", mnt.Name)
	}
	fp := fingerprint(mnt)
	m.mu.Lock()
	if item, ok := m.cache[id]; ok && item.fingerprint == fp {
		m.mu.Unlock()
		return item.fs, mnt, nil
	}
	if old, ok := m.cache[id]; ok {
		if old.closer != nil {
			_ = old.closer()
		}
		delete(m.cache, id)
	}
	m.mu.Unlock()

	fsys, closer, err := m.open(mnt)
	if err != nil {
		return nil, mnt, err
	}
	m.mu.Lock()
	m.cache[id] = cacheItem{fs: fsys, closer: closer, fingerprint: fp}
	m.mu.Unlock()
	return fsys, mnt, nil
}

func (m *Manager) open(mnt model.Mount) (vfs.FS, func() error, error) {
	switch mnt.Type {
	case model.MountLocal:
		local, err := vfs.OpenLocal(mnt.Root, mnt.Name, mnt.ReadOnly)
		if err != nil {
			return nil, nil, err
		}
		return local, local.Close, nil
	case model.MountWebDAV:
		password := mnt.Password
		if m.box != nil {
			plain, err := m.box.Open(mnt.Password)
			if err != nil {
				return nil, nil, fmt.Errorf("decrypt mount password: %w", err)
			}
			password = plain
		}
		return openWebDAV(mnt, password, m.log)
	default:
		return nil, nil, fmt.Errorf("unsupported mount type %q", mnt.Type)
	}
}

// Local returns a file system for an arbitrary directory (static rules with a
// plain path instead of a mount).
func (m *Manager) Local(root, label string, readOnly bool) (vfs.FS, error) {
	return vfs.OpenLocal(root, label, readOnly)
}

// Test checks that a mount definition can be opened.
func (m *Manager) Test(mnt model.Mount) error {
	fsys, closer, err := m.open(mnt)
	if err != nil {
		return err
	}
	if closer != nil {
		defer func() { _ = closer() }()
	}
	_, err = fsys.List(nil, "/", false) //nolint:staticcheck // nil ctx is fine for local listing
	return err
}

func fingerprint(m model.Mount) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%t|%t", m.Type, m.Root, m.URL, m.Username, m.Password, m.ReadOnly, m.InsecureTLS)
}
