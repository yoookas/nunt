package mounts

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/net/webdav"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/vfs"
)

// newDavServer serves dir over HTTP with the reference WebDAV handler so the
// remote backend can be exercised end to end.
func newDavServer(t *testing.T, dir string, auth bool) *httptest.Server {
	t.Helper()
	h := &webdav.Handler{
		Prefix:     "/dav",
		FileSystem: webdav.Dir(dir),
		LockSystem: webdav.NewMemLS(),
	}
	var handler http.Handler = h
	if auth {
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, pass, ok := r.BasicAuth()
			if !ok || user != "alice" || pass != "s3cret" {
				w.Header().Set("WWW-Authenticate", `Basic realm="dav"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			h.ServeHTTP(w, r)
		})
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func openTestMount(t *testing.T, srv *httptest.Server, readOnly bool) vfs.FS {
	t.Helper()
	mnt := model.Mount{
		ID:       "m1",
		Name:     "remote",
		Type:     model.MountWebDAV,
		URL:      srv.URL + "/dav/",
		Username: "alice",
		ReadOnly: readOnly,
	}
	fsys, closer, err := openWebDAV(mnt, "s3cret", slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("openWebDAV: %v", err)
	}
	t.Cleanup(func() { _ = closer() })
	return fsys
}

func TestWebDAVMountLifecycle(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello world"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "nested.txt"), []byte("nested"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "中文 名字.txt"), []byte("unicode"), 0o640); err != nil {
		t.Fatal(err)
	}
	srv := newDavServer(t, dir, true)
	fsys := openTestMount(t, srv, false)

	if fsys.Name() != "remote" || fsys.ReadOnly() {
		t.Fatalf("unexpected name/readonly: %q %t", fsys.Name(), fsys.ReadOnly())
	}

	ctx := context.Background()
	entries, err := fsys.List(ctx, "/", false)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	names := map[string]vfs.Entry{}
	for _, e := range entries {
		names[e.Name] = e
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 entries, got %d (%v)", len(entries), entries)
	}
	if e, ok := names["sub"]; !ok || !e.Dir {
		t.Fatalf("sub directory missing: %+v", entries)
	}
	if e, ok := names["hello.txt"]; !ok || e.Dir || e.Size != 11 || e.Path != "/hello.txt" {
		t.Fatalf("hello.txt entry wrong: %+v", e)
	}
	if e, ok := names["中文 名字.txt"]; !ok || e.Size != 7 {
		t.Fatalf("unicode entry wrong: %+v", e)
	}
	if _, ok := names["hello.txt"]; ok && names["hello.txt"].ModTime.IsZero() {
		t.Fatalf("mod time was not parsed")
	}

	stat, err := fsys.Stat(ctx, "/sub/nested.txt")
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if stat.Size != 6 || stat.Dir {
		t.Fatalf("stat mismatch: %+v", stat)
	}

	// Whole file and a byte range.
	rc, entry, err := fsys.Open(ctx, "/hello.txt", 0, 0)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	all, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil || string(all) != "hello world" || entry.Size != 11 {
		t.Fatalf("open full: %q %+v %v", all, entry, err)
	}
	rc, _, err = fsys.Open(ctx, "/hello.txt", 6, 5)
	if err != nil {
		t.Fatalf("open range: %v", err)
	}
	part, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil || string(part) != "world" {
		t.Fatalf("range read: %q %v", part, err)
	}

	// Write path: create (with implicit parent), mkdir, rename, remove.
	if n, err := fsys.Create(ctx, "/deep/tree/new.txt", strings.NewReader("payload")); err != nil || n != 7 {
		t.Fatalf("create: n=%d err=%v", n, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "deep", "tree", "new.txt")); err != nil {
		t.Fatalf("created file missing on server: %v", err)
	}
	if err := fsys.Mkdir(ctx, "/empty/dir"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := fsys.Rename(ctx, "/deep/tree/new.txt", "/deep/tree/renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "deep", "tree", "renamed.txt")); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if err := fsys.Remove(ctx, "/deep/tree/renamed.txt", false); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := fsys.Stat(ctx, "/deep/tree/renamed.txt"); !errors.Is(err, vfs.ErrNotExist) {
		t.Fatalf("want ErrNotExist after remove, got %v", err)
	}
	// Non recursive removal of a non empty directory must be refused.
	if err := fsys.Remove(ctx, "/sub", false); !errors.Is(err, vfs.ErrNotEmpty) {
		t.Fatalf("want ErrNotEmpty, got %v", err)
	}
	if err := fsys.Remove(ctx, "/sub", true); err != nil {
		t.Fatalf("recursive remove: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub")); !os.IsNotExist(err) {
		t.Fatalf("directory still present: %v", err)
	}
}

func TestWebDAVMountErrors(t *testing.T) {
	dir := t.TempDir()
	srv := newDavServer(t, dir, false)
	ctx := context.Background()

	fsys := openTestMount(t, srv, false)
	if _, err := fsys.Stat(ctx, "/missing.txt"); !errors.Is(err, vfs.ErrNotExist) {
		t.Fatalf("stat missing: %v", err)
	}
	if _, _, err := fsys.Open(ctx, "/missing.txt", 0, 0); !errors.Is(err, vfs.ErrNotExist) {
		t.Fatalf("open missing: %v", err)
	}
	if err := fsys.Mkdir(ctx, "/d"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, _, err := fsys.Open(ctx, "/d", 0, 0); !errors.Is(err, vfs.ErrIsDir) {
		t.Fatalf("open directory: %v", err)
	}
	// Traversal is neutralised by vfs.Clean before any request is sent: the
	// path is re-rooted instead of escaping the collection.
	if _, err := fsys.List(ctx, "/../../etc", false); !errors.Is(err, vfs.ErrNotExist) {
		t.Fatalf("traversal listing: %v", err)
	}
	if _, err := fsys.Create(ctx, "/..\\..\\escape.txt", strings.NewReader("x")); err != nil {
		t.Fatalf("create with traversal segments: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatalf("file was not re-rooted inside the collection: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.txt")); err == nil {
		t.Fatalf("file escaped the remote root")
	}
	if _, err := fsys.List(ctx, "/a..b", false); !errors.Is(err, vfs.ErrInvalidPath) {
		t.Fatalf("invalid path was accepted: %v", err)
	}

	ro := openTestMount(t, srv, true)
	if ro.ReadOnly() != true {
		t.Fatalf("read only flag lost")
	}
	if _, err := ro.Create(ctx, "/nope.txt", strings.NewReader("x")); !errors.Is(err, vfs.ErrReadOnly) {
		t.Fatalf("create on read only mount: %v", err)
	}
	if err := ro.Mkdir(ctx, "/nope"); !errors.Is(err, vfs.ErrReadOnly) {
		t.Fatalf("mkdir on read only mount: %v", err)
	}
	if err := ro.Remove(ctx, "/x", false); !errors.Is(err, vfs.ErrReadOnly) {
		t.Fatalf("remove on read only mount: %v", err)
	}
	if err := ro.Rename(ctx, "/a", "/b"); !errors.Is(err, vfs.ErrReadOnly) {
		t.Fatalf("rename on read only mount: %v", err)
	}
}

func TestWebDAVMountAuthAndBadURL(t *testing.T) {
	dir := t.TempDir()
	srv := newDavServer(t, dir, true)

	// Wrong password: opening the mount must fail with a permission error.
	_, closer, err := openWebDAV(model.Mount{Name: "x", Type: model.MountWebDAV, URL: srv.URL + "/dav/", Username: "alice"}, "wrong", nil)
	if err == nil {
		if closer != nil {
			_ = closer()
		}
		t.Fatalf("expected authentication failure")
	}

	for _, tc := range []struct {
		name string
		url  string
	}{
		{"empty", ""},
		{"scheme", "ftp://example.com/dav"},
		{"garbage", "http://[::1"},
	} {
		if _, _, err := openWebDAV(model.Mount{Name: tc.name, Type: model.MountWebDAV, URL: tc.url}, "", nil); err == nil {
			t.Fatalf("%s: expected an error", tc.name)
		}
	}
}

func TestReaderLength(t *testing.T) {
	if got := readerLength(strings.NewReader("abcd")); got != 4 {
		t.Fatalf("string reader length = %d", got)
	}
	if got := readerLength(io.LimitReader(strings.NewReader("abcd"), 2)); got != -1 {
		t.Fatalf("unknown length = %d", got)
	}
}

func TestContentRangeStart(t *testing.T) {
	cases := map[string]int64{
		"bytes 10-19/100": 10,
		"bytes 0-4/5":     0,
		"":                0,
		"garbage":         0,
	}
	for in, want := range cases {
		if got := contentRangeStart(in); got != want {
			t.Fatalf("contentRangeStart(%q) = %d, want %d", in, got, want)
		}
	}
}
