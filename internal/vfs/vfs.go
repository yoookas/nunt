// Package vfs is the small file system abstraction shared by the static file
// server, the file browser and the WebDAV server.
//
// Every implementation must reject path traversal and must never escape its
// configured root, which is why the local backend is built on os.Root.
package vfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Common errors.
var (
	ErrNotExist    = errors.New("not found")
	ErrReadOnly    = errors.New("read only storage")
	ErrInvalidPath = errors.New("invalid path")
	ErrIsDir       = errors.New("is a directory")
	ErrNotEmpty    = errors.New("directory is not empty")
)

// Entry describes one file or directory.
type Entry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Mode    string    `json:"mode,omitempty"`
}

// FS is the minimal file system contract used by the storage backed modules.
type FS interface {
	// Name is a human readable label of the backend.
	Name() string
	// ReadOnly reports whether write operations are rejected.
	ReadOnly() bool
	// List returns the entries of a directory (not recursive).
	List(ctx context.Context, p string, showHidden bool) ([]Entry, error)
	// Stat returns the entry of a path.
	Stat(ctx context.Context, p string) (Entry, error)
	// Open reads a file, optionally a byte range (size <= 0 means to the end).
	Open(ctx context.Context, p string, offset, size int64) (io.ReadCloser, Entry, error)
	// Create writes a new file, replacing an existing one.
	Create(ctx context.Context, p string, r io.Reader) (int64, error)
	// Mkdir creates a directory (parents included).
	Mkdir(ctx context.Context, p string) error
	// Remove deletes a file or, when recursive is true, a directory tree.
	Remove(ctx context.Context, p string, recursive bool) error
	// Rename moves a file or directory.
	Rename(ctx context.Context, oldPath, newPath string) error
}

// Clean normalises a client supplied path into an absolute, rooted slash
// path and rejects traversal attempts.
func Clean(p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", ErrInvalidPath
	}
	p = strings.ReplaceAll(p, "\\", "/")
	cleaned := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if cleaned == "." {
		cleaned = "/"
	}
	if strings.Contains(cleaned, "..") {
		return "", ErrInvalidPath
	}
	return cleaned, nil
}

// Rel converts a rooted slash path into a relative OS path.
func Rel(p string) string {
	cleaned, err := Clean(p)
	if err != nil {
		return "."
	}
	rel := strings.TrimPrefix(cleaned, "/")
	if rel == "" {
		return "."
	}
	return filepath.FromSlash(rel)
}

// ---------------------------------------------------------------------------
// local backend
// ---------------------------------------------------------------------------

// Local serves files below a directory using os.Root, which makes symlink and
// traversal escapes impossible even for concurrent writers.
type Local struct {
	label    string
	base     string
	root     *os.Root
	readOnly bool
}

// OpenLocal opens a directory as a read/write file system.
func OpenLocal(dir, label string, readOnly bool) (*Local, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", dir, err)
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("create %s: %w", abs, err)
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return nil, fmt.Errorf("open root %s: %w", abs, err)
	}
	if label == "" {
		label = filepath.Base(abs)
	}
	return &Local{label: label, base: abs, root: root, readOnly: readOnly}, nil
}

// Close releases the directory handle.
func (l *Local) Close() error { return l.root.Close() }

// Name implements FS.
func (l *Local) Name() string { return l.label }

// Base returns the absolute directory.
func (l *Local) Base() string { return l.base }

// ReadOnly implements FS.
func (l *Local) ReadOnly() bool { return l.readOnly }

func (l *Local) guard() error {
	if l.readOnly {
		return ErrReadOnly
	}
	return nil
}

// List implements FS.
func (l *Local) List(_ context.Context, p string, showHidden bool) ([]Entry, error) {
	rel := Rel(p)
	dir, err := l.root.Open(rel)
	if err != nil {
		return nil, wrapErr(err)
	}
	defer func() { _ = dir.Close() }()
	info, err := dir.Stat()
	if err != nil {
		return nil, wrapErr(err)
	}
	if !info.IsDir() {
		return nil, ErrIsDir
	}
	items, err := dir.ReadDir(-1)
	if err != nil {
		return nil, wrapErr(err)
	}
	out := make([]Entry, 0, len(items))
	cleaned, _ := Clean(p)
	for _, item := range items {
		name := item.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		fi, err := item.Info()
		if err != nil {
			continue
		}
		out = append(out, entryOf(name, path.Join(cleaned, name), fi))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// Stat implements FS.
func (l *Local) Stat(_ context.Context, p string) (Entry, error) {
	rel := Rel(p)
	info, err := l.root.Stat(rel)
	if err != nil {
		return Entry{}, wrapErr(err)
	}
	cleaned, _ := Clean(p)
	name := path.Base(cleaned)
	if cleaned == "/" {
		name = l.label
	}
	return entryOf(name, cleaned, info), nil
}

// Open implements FS with optional range support.
func (l *Local) Open(_ context.Context, p string, offset, size int64) (io.ReadCloser, Entry, error) {
	rel := Rel(p)
	f, err := l.root.Open(rel)
	if err != nil {
		return nil, Entry{}, wrapErr(err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, Entry{}, wrapErr(err)
	}
	if info.IsDir() {
		_ = f.Close()
		return nil, Entry{}, ErrIsDir
	}
	cleaned, _ := Clean(p)
	entry := entryOf(path.Base(cleaned), cleaned, info)
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			_ = f.Close()
			return nil, Entry{}, wrapErr(err)
		}
	}
	var rc io.ReadCloser = f
	if size > 0 {
		rc = &limitedReadCloser{r: io.LimitReader(f, size), c: f}
	}
	return rc, entry, nil
}

// Create implements FS.
func (l *Local) Create(_ context.Context, p string, r io.Reader) (int64, error) {
	if err := l.guard(); err != nil {
		return 0, err
	}
	rel := Rel(p)
	if err := l.mkdirParents(rel); err != nil {
		return 0, err
	}
	f, err := l.root.OpenFile(rel, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return 0, wrapErr(err)
	}
	defer func() { _ = f.Close() }()
	n, err := io.Copy(f, r)
	if err != nil {
		return n, fmt.Errorf("write %s: %w", p, err)
	}
	return n, f.Sync()
}

// Mkdir implements FS.
func (l *Local) Mkdir(_ context.Context, p string) error {
	if err := l.guard(); err != nil {
		return err
	}
	rel := Rel(p)
	if rel == "." {
		return nil
	}
	if err := l.root.Mkdir(rel, 0o750); err == nil {
		return nil
	} else if errors.Is(err, fs.ErrExist) {
		if info, statErr := l.root.Stat(rel); statErr == nil && !info.IsDir() {
			return wrapErr(err)
		}
		return nil
	}
	// The parent may be missing: create the chain and retry the leaf.
	if err := l.mkdirParents(rel); err != nil {
		return err
	}
	if err := l.root.Mkdir(rel, 0o750); err != nil && !errors.Is(err, fs.ErrExist) {
		return wrapErr(err)
	}
	return nil
}

func (l *Local) mkdirParents(rel string) error {
	if rel == "." || rel == "" {
		return nil
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	cur := ""
	for _, part := range parts[:len(parts)-1] {
		if part == "" || part == "." {
			continue
		}
		if cur == "" {
			cur = part
		} else {
			cur = cur + "/" + part
		}
		if err := l.root.Mkdir(cur, 0o750); err != nil && !errors.Is(err, fs.ErrExist) {
			return wrapErr(err)
		}
	}
	return nil
}

// Remove implements FS.
func (l *Local) Remove(_ context.Context, p string, recursive bool) error {
	if err := l.guard(); err != nil {
		return err
	}
	rel := Rel(p)
	if rel == "." {
		return ErrInvalidPath
	}
	info, err := l.root.Stat(rel)
	if err != nil {
		return wrapErr(err)
	}
	if info.IsDir() {
		if !recursive {
			dir, err := l.root.Open(rel)
			if err != nil {
				return wrapErr(err)
			}
			names, err := dir.Readdirnames(1)
			_ = dir.Close()
			if err != nil && !errors.Is(err, io.EOF) {
				return wrapErr(err)
			}
			if len(names) > 0 {
				return ErrNotEmpty
			}
			return wrapErr(l.root.Remove(rel))
		}
		return wrapErr(l.root.RemoveAll(rel))
	}
	return wrapErr(l.root.Remove(rel))
}

// Rename implements FS.
func (l *Local) Rename(_ context.Context, oldPath, newPath string) error {
	if err := l.guard(); err != nil {
		return err
	}
	oldRel, newRel := Rel(oldPath), Rel(newPath)
	if oldRel == "." || newRel == "." {
		return ErrInvalidPath
	}
	if err := l.mkdirParents(newRel); err != nil {
		return err
	}
	return wrapErr(l.root.Rename(oldRel, newRel))
}

type limitedReadCloser struct {
	r io.Reader
	c io.Closer
}

func (l *limitedReadCloser) Read(p []byte) (int, error) { return l.r.Read(p) }
func (l *limitedReadCloser) Close() error               { return l.c.Close() }

func entryOf(name, p string, info fs.FileInfo) Entry {
	mode := ""
	if info.Mode()&os.ModeSymlink != 0 {
		mode = "symlink"
	} else if info.IsDir() {
		mode = "dir"
	} else {
		mode = "file"
	}
	return Entry{
		Name:    name,
		Path:    p,
		Dir:     info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime(),
		Mode:    mode,
	}
}

func wrapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, fs.ErrNotExist):
		return ErrNotExist
	case errors.Is(err, fs.ErrPermission):
		return err
	default:
		return err
	}
}
