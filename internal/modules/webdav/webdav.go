// Package webdav implements the WebDAV endpoint served by a web rule of type
// "webdav".
//
// golang.org/x/net/webdav does the protocol work; this package adapts the
// project wide internal/vfs file system to its FileSystem/File interfaces (see
// fs.go) and enforces the permissions of a model.FilesTgt.
package webdav

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	xwebdav "golang.org/x/net/webdav"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/vfs"
)

// Service serves WebDAV sites.
type Service struct {
	deps *module.Deps
}

// New creates the service.
func New(deps *module.Deps) *Service { return &Service{deps: deps} }

// Site returns the HTTP handler serving one rule.
//
// The handler accepts both the full request path (including rule.Path) and a
// path that the caller has already stripped, so the web module may mount it
// either way.
func (s *Service) Site(rule *model.WebRule) (http.Handler, error) {
	if rule == nil {
		return nil, errors.New("webdav: rule is nil")
	}
	if rule.Files == nil {
		return nil, fmt.Errorf("webdav rule %q: no storage is configured", rule.Name)
	}
	fsys, readOnly, label, release, err := s.open(rule)
	if err != nil {
		return nil, err
	}
	log := s.logger()
	prefix := model.NormalizePath(rule.Path)
	if prefix == "/" {
		prefix = ""
	}

	inner := &xwebdav.Handler{
		Prefix:     prefix,
		FileSystem: &adapter{fs: fsys, readOnly: readOnly, log: log},
		LockSystem: xwebdav.NewMemLS(),
		Logger: func(r *http.Request, err error) {
			if err != nil && log != nil {
				log.Debug("webdav request failed", "rule", rule.ID, "method", r.Method, "path", r.URL.Path, "error", err)
			}
		},
	}
	handler := &siteHandler{prefix: prefix, inner: permissionGuard(rule.Files, readOnly, inner)}
	if log != nil {
		log.Info("webdav site ready", "rule", rule.ID, "path", model.NormalizePath(rule.Path), "storage", label, "readOnly", readOnly)
	}
	return &closingHandler{Handler: handler, release: release}, nil
}

// closingHandler keeps the storage handle of a WebDAV site and releases it when
// the web module replaces the rule.
type closingHandler struct {
	http.Handler
	release func()
}

// Close releases the storage handle owned by the site.
func (h *closingHandler) Close() error {
	if h.release != nil {
		h.release()
		h.release = nil
	}
	return nil
}

func (s *Service) logger() *slog.Logger {
	if s == nil || s.deps == nil {
		return nil
	}
	return s.deps.Logger("webdav")
}

// open resolves the rule target into a file system, the effective read-only
// flag and a label for the logs.
func (s *Service) open(rule *model.WebRule) (vfs.FS, bool, string, func(), error) {
	files := rule.Files
	if s.deps == nil || s.deps.Mounts == nil {
		return nil, false, "", nil, errors.New("webdav: storage manager is not available")
	}
	if strings.TrimSpace(files.MountID) != "" {
		fsys, mnt, release, err := s.deps.Mounts.Get(files.MountID)
		if err != nil {
			return nil, false, "", nil, fmt.Errorf("webdav rule %q: %w", rule.Name, err)
		}
		return fsys, files.ReadOnly || mnt.ReadOnly || fsys.ReadOnly(), mnt.Name, release, nil
	}
	if strings.TrimSpace(files.Root) == "" {
		return nil, false, "", nil, fmt.Errorf("webdav rule %q: either a mount or a directory is required", rule.Name)
	}
	fsys, err := s.deps.Mounts.Local(files.Root, rule.Name, files.ReadOnly)
	if err != nil {
		return nil, false, "", nil, fmt.Errorf("webdav rule %q: %w", rule.Name, err)
	}
	release := func() {}
	if c, ok := fsys.(interface{ Close() error }); ok {
		release = func() { _ = c.Close() }
	}
	return fsys, files.ReadOnly || fsys.ReadOnly(), fsys.Name(), release, nil
}

// ---------------------------------------------------------------------------
// request routing
// ---------------------------------------------------------------------------

// siteHandler normalises the request path so the embedded webdav.Handler always
// sees the prefixed form it expects.
type siteHandler struct {
	prefix string
	inner  http.Handler
}

func (h *siteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rel := relativePath(r.URL.Path, h.prefix)
	full := joinPrefix(h.prefix, rel)

	origPath, origRaw := r.URL.Path, r.URL.RawPath
	r.URL.Path, r.URL.RawPath = full, ""
	defer func() { r.URL.Path, r.URL.RawPath = origPath, origRaw }()
	h.inner.ServeHTTP(w, r)
}

// relativePath removes the rule prefix when present; otherwise the caller has
// already stripped it and the path is used unchanged.
func relativePath(p, prefix string) string {
	if prefix == "" || prefix == "/" {
		return p
	}
	if p == prefix {
		return "/"
	}
	if strings.HasPrefix(p, prefix+"/") {
		return p[len(prefix):]
	}
	return p
}

func joinPrefix(prefix, rel string) string {
	if rel == "" {
		rel = "/"
	}
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	if prefix == "" || prefix == "/" {
		return rel
	}
	return prefix + rel
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

// permissionGuard rejects the write methods a rule does not allow. The status
// code is decided here because x/net/webdav maps file system errors to 404 or
// 405, which would hide the real reason.
func permissionGuard(files *model.FilesTgt, readOnly bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed, reason := true, ""
		switch r.Method {
		case http.MethodPut:
			allowed, reason = !readOnly && files.AllowUpload, "upload is disabled for this rule"
		case "MKCOL":
			allowed, reason = !readOnly && files.AllowMkdir, "creating collections is disabled for this rule"
		case http.MethodDelete:
			allowed, reason = !readOnly && files.AllowDelete, "deleting is disabled for this rule"
		case "MOVE":
			allowed, reason = !readOnly && files.AllowRename, "moving is disabled for this rule"
		case "COPY":
			allowed, reason = !readOnly && files.AllowUpload, "copying is disabled for this rule"
		case "PROPPATCH":
			allowed, reason = false, "dead properties are not supported"
		}
		if !allowed {
			w.Header().Set("Allow", "OPTIONS, GET, HEAD, PROPFIND, LOCK, UNLOCK")
			http.Error(w, "403 Forbidden: "+reason, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
