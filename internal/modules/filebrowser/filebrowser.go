// Package filebrowser implements the built-in file manager served by a web
// rule of type "filebrowser".
//
// A site is a single self contained HTML page plus a small JSON API below the
// "_api/" prefix of the rule path. Every path is normalised with vfs.Clean and
// resolved through the storage backend, so a client can never escape the
// configured directory, and the permissions of model.FilesTgt are enforced on
// every write.
package filebrowser

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/vfs"
)

// Service serves file browser sites and their management API.
type Service struct {
	deps *module.Deps
}

// New creates the service.
func New(deps *module.Deps) *Service { return &Service{deps: deps} }

// Site returns the HTTP handler serving one rule.
//
// The handler understands both the full request path (including rule.Path) and
// a path the caller has already stripped, so the web module may mount it
// either way.
func (s *Service) Site(rule *model.WebRule) (http.Handler, error) {
	return newSite(s.deps, rule)
}

// RegisterAPI mounts the management endpoints below /api/v1/files.
func (s *Service) RegisterAPI(mux *rest.Mux) { RegisterFilesAPI(mux, s.deps) }

// openTarget resolves the storage configured by a rule into a file system,
// the effective read-only flag and a label for logs.
func openTarget(deps *module.Deps, rule *model.WebRule) (vfs.FS, bool, string, error) {
	if rule == nil {
		return nil, false, "", errors.New("filebrowser: rule is nil")
	}
	if rule.Files == nil {
		return nil, false, "", fmt.Errorf("filebrowser rule %q: no storage is configured", rule.Name)
	}
	if deps == nil || deps.Mounts == nil {
		return nil, false, "", errors.New("filebrowser: storage manager is not available")
	}
	files := rule.Files
	if files.MountID != "" {
		fsys, mnt, err := deps.Mounts.Get(files.MountID)
		if err != nil {
			return nil, false, "", fmt.Errorf("filebrowser rule %q: %w", rule.Name, err)
		}
		return fsys, files.ReadOnly || mnt.ReadOnly || fsys.ReadOnly(), mnt.Name, nil
	}
	if strings.TrimSpace(files.Root) == "" {
		return nil, false, "", fmt.Errorf("filebrowser rule %q: either a mount or a directory is required", rule.Name)
	}
	fsys, err := deps.Mounts.Local(files.Root, rule.Name, files.ReadOnly)
	if err != nil {
		return nil, false, "", fmt.Errorf("filebrowser rule %q: %w", rule.Name, err)
	}
	return fsys, files.ReadOnly || fsys.ReadOnly(), fsys.Name(), nil
}

// logger returns a logger tagged for this package.
func (s *Service) logger() *slog.Logger {
	if s == nil || s.deps == nil {
		return nil
	}
	return s.deps.Logger("filebrowser")
}
