// Package webdav implements the WebDAV endpoint served by a web rule of type
// "webdav".
//
// The heavy lifting is done by golang.org/x/net/webdav; this file only adapts
// the project wide internal/vfs file system to the webdav.FileSystem and
// webdav.File interfaces. The HTTP entry point lives in webdav.go.
package webdav

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	xwebdav "golang.org/x/net/webdav"

	"github.com/nunt/nunt/internal/vfs"
)

// ---------------------------------------------------------------------------
// vfs.FS -> webdav.FileSystem adapter
// ---------------------------------------------------------------------------

// adapter exposes a vfs.FS to golang.org/x/net/webdav.
type adapter struct {
	fs       vfs.FS
	readOnly bool
	log      *slog.Logger
}

// Mkdir implements webdav.FileSystem.
func (a *adapter) Mkdir(ctx context.Context, name string, _ os.FileMode) error {
	if a.readOnly {
		return os.ErrPermission
	}
	p, err := cleanPath(name)
	if err != nil {
		return err
	}
	if p == "/" {
		return os.ErrExist
	}
	return wrapErr("mkdir", name, a.fs.Mkdir(ctx, p))
}

// RemoveAll implements webdav.FileSystem. WebDAV DELETE on a collection is
// always recursive, which matches the recursive flag of vfs.FS.
func (a *adapter) RemoveAll(ctx context.Context, name string) error {
	if a.readOnly {
		return os.ErrPermission
	}
	p, err := cleanPath(name)
	if err != nil {
		return err
	}
	if p == "/" {
		return os.ErrInvalid
	}
	return wrapErr("remove", name, a.fs.Remove(ctx, p, true))
}

// Rename implements webdav.FileSystem.
func (a *adapter) Rename(ctx context.Context, oldName, newName string) error {
	if a.readOnly {
		return os.ErrPermission
	}
	src, err := cleanPath(oldName)
	if err != nil {
		return err
	}
	dst, err := cleanPath(newName)
	if err != nil {
		return err
	}
	if src == "/" || dst == "/" {
		return os.ErrInvalid
	}
	return wrapErr("rename", oldName, a.fs.Rename(ctx, src, dst))
}

// Stat implements webdav.FileSystem.
func (a *adapter) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	p, err := cleanPath(name)
	if err != nil {
		return nil, err
	}
	entry, err := a.fs.Stat(ctx, p)
	if err != nil {
		return nil, wrapErr("stat", name, err)
	}
	return fileInfo{entry: entry}, nil
}

// OpenFile implements webdav.FileSystem. Write access is streamed straight into
// vfs.FS.Create so a large PUT never has to be buffered in memory.
func (a *adapter) OpenFile(ctx context.Context, name string, flag int, _ os.FileMode) (xwebdav.File, error) {
	p, err := cleanPath(name)
	if err != nil {
		return nil, err
	}
	writable := flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0
	if writable {
		if a.readOnly {
			return nil, os.ErrPermission
		}
		if p == "/" {
			return nil, os.ErrInvalid
		}
		if flag&os.O_EXCL != 0 {
			if _, err := a.fs.Stat(ctx, p); err == nil {
				return nil, os.ErrExist
			}
		}
		return newWriteFile(ctx, a, p, name), nil
	}

	entry, err := a.fs.Stat(ctx, p)
	if err != nil {
		return nil, wrapErr("open", name, err)
	}
	if entry.Dir {
		return &dirFile{ctx: ctx, fs: a.fs, path: p, entry: entry}, nil
	}
	if flag&os.O_TRUNC != 0 && flag&(os.O_WRONLY|os.O_RDWR) == 0 {
		return nil, os.ErrInvalid
	}
	return &readFile{ctx: ctx, fs: a.fs, path: p, entry: entry}, nil
}

// ---------------------------------------------------------------------------
// os.FileInfo
// ---------------------------------------------------------------------------

type fileInfo struct{ entry vfs.Entry }

func (i fileInfo) Name() string { return i.entry.Name }
func (i fileInfo) Size() int64  { return i.entry.Size }
func (i fileInfo) Mode() os.FileMode {
	if i.entry.Dir {
		return os.ModeDir | 0o755
	}
	return 0o644
}
func (i fileInfo) ModTime() time.Time { return i.entry.ModTime }
func (i fileInfo) IsDir() bool        { return i.entry.Dir }
func (i fileInfo) Sys() any           { return nil }

// ---------------------------------------------------------------------------
// read side
// ---------------------------------------------------------------------------

// readFile adapts vfs.Open to io.ReadSeeker by re-opening the file at the new
// offset; that keeps the remote backends happy because they translate the
// offset into a Range request.
type readFile struct {
	mu    sync.Mutex
	ctx   context.Context
	fs    vfs.FS
	path  string
	entry vfs.Entry
	rc    interface {
		Read([]byte) (int, error)
		Close() error
	}
	pos int64
}

func (f *readFile) Stat() (os.FileInfo, error) { return fileInfo{entry: f.entry}, nil }

func (f *readFile) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rc == nil {
		if err := f.reopen(f.pos); err != nil {
			return 0, err
		}
	}
	n, err := f.rc.Read(p)
	f.pos += int64(n)
	return n, err
}

func (f *readFile) Seek(offset int64, whence int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = f.pos + offset
	case io.SeekEnd:
		abs = f.entry.Size + offset
	default:
		return 0, errors.New("webdav: invalid seek whence")
	}
	if abs < 0 {
		return 0, errors.New("webdav: negative seek position")
	}
	if err := f.reopen(abs); err != nil {
		return 0, err
	}
	return abs, nil
}

func (f *readFile) reopen(pos int64) error {
	if f.rc != nil {
		_ = f.rc.Close()
		f.rc = nil
	}
	f.pos = pos
	if f.entry.Size > 0 && pos >= f.entry.Size {
		f.rc = nopReadCloser{}
		return nil
	}
	remaining := int64(0)
	if f.entry.Size > pos {
		remaining = f.entry.Size - pos
	}
	rc, _, err := f.fs.Open(f.ctx, f.path, pos, remaining)
	if err != nil {
		return wrapErr("read", f.path, err)
	}
	f.rc = rc
	return nil
}

func (f *readFile) Readdir(int) ([]os.FileInfo, error) {
	return nil, errors.New("webdav: not a directory")
}

func (f *readFile) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rc == nil {
		return nil
	}
	err := f.rc.Close()
	f.rc = nil
	return err
}

// nopReadCloser is an immediately exhausted reader, used for offsets at or past
// the end of a file where no range request is needed.
type nopReadCloser struct{}

func (nopReadCloser) Read([]byte) (int, error) { return 0, io.EOF }
func (nopReadCloser) Close() error             { return nil }

// dirFile serves the directory listing.
type dirFile struct {
	mu     sync.Mutex
	ctx    context.Context
	fs     vfs.FS
	path   string
	entry  vfs.Entry
	infos  []os.FileInfo
	offset int
}

func (f *dirFile) Stat() (os.FileInfo, error) { return fileInfo{entry: f.entry}, nil }

func (f *dirFile) Read([]byte) (int, error) {
	return 0, errors.New("webdav: is a directory")
}

func (f *dirFile) Seek(int64, int) (int64, error) {
	return 0, errors.New("webdav: is a directory")
}

func (f *dirFile) Close() error { return nil }

func (f *dirFile) Readdir(count int) ([]os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.infos == nil {
		entries, err := f.fs.List(f.ctx, f.path, true)
		if err != nil {
			return nil, wrapErr("readdir", f.path, err)
		}
		infos := make([]os.FileInfo, 0, len(entries))
		for _, e := range entries {
			infos = append(infos, fileInfo{entry: e})
		}
		f.infos = infos
	}
	if count <= 0 {
		out := f.infos[f.offset:]
		f.offset = len(f.infos)
		return out, nil
	}
	if f.offset >= len(f.infos) {
		return nil, io.EOF
	}
	end := f.offset + count
	if end > len(f.infos) {
		end = len(f.infos)
	}
	out := f.infos[f.offset:end]
	f.offset = end
	return out, nil
}

// ---------------------------------------------------------------------------
// write side
// ---------------------------------------------------------------------------

type putResult struct {
	written int64
	err     error
}

// writeFile streams Write calls into vfs.FS.Create through a pipe and reports
// the upload result from Close.
type writeFile struct {
	mu     sync.Mutex
	name   string
	pw     *io.PipeWriter
	result chan putResult
	size   int64
	err    error
	closed bool

	fs     vfs.FS
	ctx    context.Context
	temp   string
	target string
}

// tempPathFor returns a hidden sibling path used while a PUT is in flight.
func tempPathFor(p string) string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return path.Join(path.Dir(p), "."+path.Base(p)+".part-"+hex.EncodeToString(b[:]))
}

func newWriteFile(ctx context.Context, a *adapter, p, name string) *writeFile {
	// A PUT writes to a hidden temporary file and is renamed into place when it
	// completes, so a failed or interrupted upload neither leaves a partial file
	// nor destroys the file it was going to replace.
	temp := tempPathFor(p)
	pr, pw := io.Pipe()
	result := make(chan putResult, 1)
	go func() {
		n, err := a.fs.Create(ctx, temp, pr)
		// Closing the reader with the upload error unblocks a pending Write.
		_ = pr.CloseWithError(err)
		result <- putResult{written: n, err: err}
	}()
	return &writeFile{name: name, pw: pw, result: result, fs: a.fs, ctx: ctx, temp: temp, target: p}
}

func (f *writeFile) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, errors.New("webdav: write on closed file")
	}
	n, err := f.pw.Write(p)
	f.size += int64(n)
	return n, err
}

// Stat reports the bytes written so far; x/net/webdav calls it before Close to
// build the ETag of the created resource.
func (f *writeFile) Stat() (os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return writeInfo{name: path.Base(f.name), size: f.size, mod: time.Now()}, nil
}

func (f *writeFile) Read([]byte) (int, error) {
	return 0, errors.New("webdav: file is write only")
}

func (f *writeFile) Seek(int64, int) (int64, error) {
	return 0, errors.New("webdav: file is write only")
}

func (f *writeFile) Readdir(int) ([]os.FileInfo, error) {
	return nil, errors.New("webdav: not a directory")
}

// Close finishes the upload and returns the error of vfs.FS.Create.
func (f *writeFile) Close() error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return f.err
	}
	f.closed = true
	f.mu.Unlock()

	_ = f.pw.Close()
	res := <-f.result
	if res.err == nil {
		if err := f.fs.Rename(f.ctx, f.temp, f.target); err != nil {
			_ = f.fs.Remove(context.WithoutCancel(f.ctx), f.temp, true)
			res.err = err
		}
	} else {
		_ = f.fs.Remove(context.WithoutCancel(f.ctx), f.temp, true)
	}

	f.mu.Lock()
	f.err = res.err
	f.size = res.written
	f.mu.Unlock()
	if res.err != nil {
		return wrapErr("write", f.name, res.err)
	}
	return nil
}

type writeInfo struct {
	name string
	size int64
	mod  time.Time
}

func (i writeInfo) Name() string       { return i.name }
func (i writeInfo) Size() int64        { return i.size }
func (i writeInfo) Mode() os.FileMode  { return 0o644 }
func (i writeInfo) ModTime() time.Time { return i.mod }
func (i writeInfo) IsDir() bool        { return false }
func (i writeInfo) Sys() any           { return nil }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func cleanPath(name string) (string, error) {
	if strings.ContainsRune(name, 0) {
		return "", os.ErrNotExist
	}
	p, err := vfs.Clean(name)
	if err != nil {
		// A rejected path must look like "not found" to the caller.
		return "", os.ErrNotExist
	}
	return p, nil
}

// wrapErr translates a vfs error into the equivalent os error so that the
// webdav handler can pick the right status code.
func wrapErr(op, name string, err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, vfs.ErrNotExist):
		return &os.PathError{Op: op, Path: name, Err: os.ErrNotExist}
	case errors.Is(err, vfs.ErrReadOnly):
		return &os.PathError{Op: op, Path: name, Err: os.ErrPermission}
	case errors.Is(err, vfs.ErrInvalidPath):
		return &os.PathError{Op: op, Path: name, Err: os.ErrNotExist}
	case errors.Is(err, vfs.ErrIsDir):
		return &os.PathError{Op: op, Path: name, Err: os.ErrInvalid}
	case errors.Is(err, vfs.ErrNotEmpty):
		return &os.PathError{Op: op, Path: name, Err: errDirNotEmpty}
	default:
		return &os.PathError{Op: op, Path: name, Err: err}
	}
}

var errDirNotEmpty = errors.New("directory not empty")

// Write implements webdav.File; the read side of the adapter is not writable.
// A client that wants to store data opens the file with a write flag instead.
func (f *readFile) Write([]byte) (int, error) {
	return 0, errors.New("webdav: file is read only")
}

// Write implements webdav.File; a collection cannot be written to.
func (f *dirFile) Write([]byte) (int, error) {
	return 0, errors.New("webdav: is a directory")
}
