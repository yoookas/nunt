// Package mounts turns the configured storage backends into vfs file systems
// that the static server and the WebDAV mount backend can share.
package mounts

import (
	"fmt"
	"log/slog"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/vfs"
)

// Manager resolves mount ids to file systems.
type Manager struct {
	cfg *config.Store
	box *secret.Box
	log *slog.Logger
}

// New creates a manager bound to the configuration store.
func New(cfg *config.Store, box *secret.Box, log *slog.Logger) *Manager {
	return &Manager{cfg: cfg, box: box, log: log}
}

// Invalidate is kept for the callers that used to drop a shared cache. Backends
// are no longer shared between sites: every Get returns a handle owned by the
// caller, so a configuration change can never close a file system that a
// running site is still using.
func (m *Manager) Invalidate() {}

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

// Get opens the file system of a mount. The caller owns the returned handle and
// releases it with release when the site that uses it goes away.
func (m *Manager) Get(id string) (vfs.FS, model.Mount, func(), error) {
	mnt, ok := m.Find(id)
	if !ok {
		return nil, model.Mount{}, nil, fmt.Errorf("mount %q does not exist", id)
	}
	if !mnt.Enable {
		return nil, mnt, nil, fmt.Errorf("mount %q is disabled", mnt.Name)
	}
	fsys, closer, err := m.open(mnt)
	if err != nil {
		return nil, mnt, nil, err
	}
	release := func() {}
	if closer != nil {
		release = func() { _ = closer() }
	}
	return fsys, mnt, release, nil
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
