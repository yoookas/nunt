package webdav

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/mounts"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/vfs"
)

func newAdapter(t *testing.T, readOnly bool) (*adapter, string) {
	t.Helper()
	dir := t.TempDir()
	fsys, err := vfs.OpenLocal(dir, "test", readOnly)
	if err != nil {
		t.Fatalf("open local storage: %v", err)
	}
	t.Cleanup(func() { _ = fsys.Close() })
	return &adapter{fs: fsys, readOnly: readOnly, log: slog.New(slog.DiscardHandler)}, dir
}

func seedFile(t *testing.T, dir, name, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterStatAndReaddir(t *testing.T) {
	a, dir := newAdapter(t, false)
	seedFile(t, dir, "a.txt", "hello")
	seedFile(t, dir, "sub/b.txt", "world")
	ctx := context.Background()

	root, err := a.Stat(ctx, "/")
	if err != nil || !root.IsDir() {
		t.Fatalf("stat root: %+v %v", root, err)
	}
	info, err := a.Stat(ctx, "/a.txt")
	if err != nil || info.Size() != 5 || info.IsDir() {
		t.Fatalf("stat file: %+v %v", info, err)
	}
	if _, err := a.Stat(ctx, "/missing.txt"); !os.IsNotExist(err) {
		t.Fatalf("stat missing: %v", err)
	}

	f, err := a.OpenFile(ctx, "/", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("open dir: %v", err)
	}
	defer f.Close()
	entries, err := f.Readdir(-1)
	if err != nil || len(entries) != 2 {
		t.Fatalf("readdir all: %d %v", len(entries), err)
	}
	if _, err := f.Read(make([]byte, 4)); err == nil {
		t.Fatalf("reading a directory must fail")
	}
}

func TestAdapterReaddirPaging(t *testing.T) {
	a, dir := newAdapter(t, false)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		seedFile(t, dir, name, name)
	}
	ctx := context.Background()
	f, err := a.OpenFile(ctx, "/", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	first, err := f.Readdir(2)
	if err != nil || len(first) != 2 {
		t.Fatalf("first page: %d %v", len(first), err)
	}
	second, err := f.Readdir(2)
	if err != nil || len(second) != 1 {
		t.Fatalf("second page: %d %v", len(second), err)
	}
	if _, err := f.Readdir(2); err != io.EOF {
		t.Fatalf("want io.EOF at the end, got %v", err)
	}
}

func TestAdapterReadSeek(t *testing.T) {
	a, dir := newAdapter(t, false)
	seedFile(t, dir, "a.txt", "0123456789")
	ctx := context.Background()
	f, err := a.OpenFile(ctx, "/a.txt", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	head := make([]byte, 4)
	if _, err := io.ReadFull(f, head); err != nil || string(head) != "0123" {
		t.Fatalf("read head: %q %v", head, err)
	}
	if pos, err := f.Seek(2, io.SeekStart); err != nil || pos != 2 {
		t.Fatalf("seek start: %d %v", pos, err)
	}
	rest, err := io.ReadAll(f)
	if err != nil || string(rest) != "23456789" {
		t.Fatalf("read after seek: %q %v", rest, err)
	}
	if pos, err := f.Seek(-2, io.SeekEnd); err != nil || pos != 8 {
		t.Fatalf("seek end: %d %v", pos, err)
	}
	tail, err := io.ReadAll(f)
	if err != nil || string(tail) != "89" {
		t.Fatalf("read tail: %q %v", tail, err)
	}
	if _, err := f.Seek(-1, io.SeekStart); err == nil {
		t.Fatalf("negative seek must fail")
	}
}

func TestAdapterWriteMkdirRenameRemove(t *testing.T) {
	a, dir := newAdapter(t, false)
	ctx := context.Background()

	f, err := a.OpenFile(ctx, "/new/file.txt", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		t.Fatalf("open for write: %v", err)
	}
	if _, err := f.Write([]byte("payload")); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := f.Stat()
	if err != nil || info.Size() != 7 {
		t.Fatalf("stat while writing: %+v %v", info, err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "new", "file.txt"))
	if err != nil || string(got) != "payload" {
		t.Fatalf("file on disk: %q %v", got, err)
	}

	if err := a.Mkdir(ctx, "/created", 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := a.Rename(ctx, "/new/file.txt", "/created/moved.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "created", "moved.txt")); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
	if err := a.RemoveAll(ctx, "/created"); err != nil {
		t.Fatalf("remove all: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "created")); !os.IsNotExist(err) {
		t.Fatalf("directory still present: %v", err)
	}
}

func TestAdapterReadOnly(t *testing.T) {
	a, _ := newAdapter(t, true)
	ctx := context.Background()
	if err := a.Mkdir(ctx, "/x", 0o755); err != os.ErrPermission {
		t.Fatalf("mkdir: %v", err)
	}
	if err := a.RemoveAll(ctx, "/x"); err != os.ErrPermission {
		t.Fatalf("remove: %v", err)
	}
	if err := a.Rename(ctx, "/x", "/y"); err != os.ErrPermission {
		t.Fatalf("rename: %v", err)
	}
	if _, err := a.OpenFile(ctx, "/x", os.O_RDWR|os.O_CREATE, 0o644); err != os.ErrPermission {
		t.Fatalf("open for write: %v", err)
	}
}

func TestAdapterPathSafety(t *testing.T) {
	a, dir := newAdapter(t, false)
	seedFile(t, dir, "inside.txt", "safe")
	ctx := context.Background()

	if _, err := a.Stat(ctx, "/../../inside.txt"); err != nil {
		t.Fatalf("traversal must be re-rooted, not rejected: %v", err)
	}
	if _, err := a.Stat(ctx, "/a..b"); !os.IsNotExist(err) {
		t.Fatalf("suspicious name: %v", err)
	}
	if _, err := a.Stat(ctx, "/with"+string(rune(0))+"nul"); !os.IsNotExist(err) {
		t.Fatalf("nul byte name: %v", err)
	}
	// Removing the virtual root must never delete the storage directory.
	if err := a.RemoveAll(ctx, "/"); err == nil {
		t.Fatalf("removing the root must fail")
	}
	if err := a.Rename(ctx, "/", "/moved"); err == nil {
		t.Fatalf("renaming the root must fail")
	}
	if _, err := os.Stat(filepath.Join(dir, "inside.txt")); err != nil {
		t.Fatalf("storage directory was damaged: %v", err)
	}
}

// ---------------------------------------------------------------------------
// HTTP level
// ---------------------------------------------------------------------------

func newTestDeps(t *testing.T) *module.Deps {
	t.Helper()
	dir := t.TempDir()
	cfg, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	box, err := secret.Open(filepath.Join(dir, "secret.key"))
	if err != nil {
		t.Fatalf("open secret box: %v", err)
	}
	log := slog.New(slog.DiscardHandler)
	return &module.Deps{
		Cfg:      cfg,
		Mounts:   mounts.New(cfg, box, log),
		DataDir:  dir,
		Registry: module.NewRegistry(),
	}
}

// mountedRoot registers root as a local mount and returns its identifier. The
// cached file system is released when the test ends, which matters on Windows
// where an open directory handle blocks the temporary directory cleanup.
func mountedRoot(t *testing.T, deps *module.Deps, root string) string {
	t.Helper()
	const id = "mount-test"
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Storage.Mounts = append(c.Storage.Mounts, model.Mount{ID: id, Name: "storage", Type: model.MountLocal, Root: root, Enable: true})
		return nil
	}); err != nil {
		t.Fatalf("register mount: %v", err)
	}
	t.Cleanup(deps.Mounts.Invalidate)
	return id
}

func testRule(mountID string, mutate func(*model.FilesTgt)) *model.WebRule {
	files := &model.FilesTgt{
		MountID:     mountID,
		AllowUpload: true,
		AllowDelete: true,
		AllowMkdir:  true,
		AllowRename: true,
	}
	if mutate != nil {
		mutate(files)
	}
	return &model.WebRule{ID: "rule-dav", Name: "dav", Type: model.WebTypeWebDAV, Path: "/dav", Files: files}
}

func request(t *testing.T, h http.Handler, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSiteWebDAVLifecycle(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "hello.txt", "hello world")
	deps := newTestDeps(t)
	svc := New(deps)
	h, err := svc.Site(testRule(mountedRoot(t, deps, root), nil))
	if err != nil {
		t.Fatalf("site: %v", err)
	}

	if rec := request(t, h, "PROPFIND", "/dav/", "", map[string]string{"Depth": "1"}); rec.Code != http.StatusMultiStatus {
		t.Fatalf("propfind: %d %s", rec.Code, rec.Body.String())
	} else if !strings.Contains(rec.Body.String(), "hello.txt") {
		t.Fatalf("propfind body misses the file: %s", rec.Body.String())
	}
	if rec := request(t, h, http.MethodGet, "/dav/hello.txt", "", nil); rec.Code != http.StatusOK || rec.Body.String() != "hello world" {
		t.Fatalf("get: %d %q", rec.Code, rec.Body.String())
	}
	if rec := request(t, h, http.MethodPut, "/dav/uploaded.txt", "fresh", nil); rec.Code != http.StatusCreated {
		t.Fatalf("put: %d %s", rec.Code, rec.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(root, "uploaded.txt")); err != nil || string(got) != "fresh" {
		t.Fatalf("uploaded file: %q %v", got, err)
	}
	if rec := request(t, h, "MKCOL", "/dav/coll", "", nil); rec.Code != http.StatusCreated {
		t.Fatalf("mkcol: %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(t, h, "MOVE", "/dav/uploaded.txt", "", map[string]string{"Destination": "/dav/coll/moved.txt", "Overwrite": "T"}); rec.Code != http.StatusCreated && rec.Code != http.StatusNoContent {
		t.Fatalf("move: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "coll", "moved.txt")); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
	if rec := request(t, h, "COPY", "/dav/coll/moved.txt", "", map[string]string{"Destination": "/dav/coll/copy.txt"}); rec.Code != http.StatusCreated && rec.Code != http.StatusNoContent {
		t.Fatalf("copy: %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(t, h, "DELETE", "/dav/coll", "", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "coll")); !os.IsNotExist(err) {
		t.Fatalf("collection still present: %v", err)
	}
	if rec := request(t, h, "PROPPATCH", "/dav/hello.txt", "", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("proppatch must be forbidden: %d", rec.Code)
	}
	if rec := request(t, h, "OPTIONS", "/dav/", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("options: %d", rec.Code)
	}
	// A caller that already stripped the rule prefix must work as well.
	if rec := request(t, h, http.MethodGet, "/hello.txt", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("stripped path get: %d", rec.Code)
	}
}

func TestSitePermissions(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "data")
	deps := newTestDeps(t)
	svc := New(deps)

	readOnly, err := svc.Site(testRule(mountedRoot(t, deps, root), func(f *model.FilesTgt) { f.ReadOnly = true }))
	if err != nil {
		t.Fatalf("site: %v", err)
	}
	if rec := request(t, readOnly, http.MethodGet, "/dav/a.txt", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("read only get: %d", rec.Code)
	}
	for _, tc := range []struct {
		method string
		target string
		header map[string]string
	}{
		{http.MethodPut, "/dav/b.txt", nil},
		{"MKCOL", "/dav/new", nil},
		{http.MethodDelete, "/dav/a.txt", nil},
		{"MOVE", "/dav/a.txt", map[string]string{"Destination": "/dav/c.txt"}},
	} {
		if rec := request(t, readOnly, tc.method, tc.target, "", tc.header); rec.Code != http.StatusForbidden {
			t.Fatalf("read only %s: want 403, got %d", tc.method, rec.Code)
		}
	}

	noUpload, err := svc.Site(testRule(mountedRoot(t, deps, root), func(f *model.FilesTgt) { f.AllowUpload = false }))
	if err != nil {
		t.Fatalf("site: %v", err)
	}
	if rec := request(t, noUpload, http.MethodPut, "/dav/b.txt", "x", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("upload disabled: %d", rec.Code)
	}
	if rec := request(t, noUpload, http.MethodGet, "/dav/a.txt", "", nil); rec.Code != http.StatusOK {
		t.Fatalf("get with upload disabled: %d", rec.Code)
	}
}

func TestSiteRejectsUnsupportedStorage(t *testing.T) {
	deps := newTestDeps(t)
	svc := New(deps)
	if _, err := svc.Site(&model.WebRule{ID: "x", Name: "x", Path: "/dav"}); err == nil {
		t.Fatalf("a rule without storage must fail")
	}
	if _, err := svc.Site(nil); err == nil {
		t.Fatalf("a nil rule must fail")
	}
	if _, err := svc.Site(testRule("", nil)); err == nil {
		t.Fatalf("an empty root must fail")
	}
}
