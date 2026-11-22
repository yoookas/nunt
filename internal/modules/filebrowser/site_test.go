package filebrowser

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/mounts"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/secret"
)

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
	hub := logging.New("error", filepath.Join(dir, "test.log"))
	t.Cleanup(hub.Close)
	return &module.Deps{
		Cfg:      cfg,
		Log:      hub,
		Mounts:   mounts.New(cfg, box, hub.Logger()),
		DataDir:  dir,
		Registry: module.NewRegistry(),
	}
}

// mountedRoot registers root as a local mount and returns its id. The cached
// file system is released when the test ends: on Windows an open directory
// handle would block the temporary directory cleanup.
func mountedRoot(t *testing.T, deps *module.Deps, root string) string {
	t.Helper()
	const id = "mount-fb"
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
		ShareLinks:  true,
		ShareTTLMin: 60,
	}
	if mutate != nil {
		mutate(files)
	}
	// A file service must be protected before it can be stored in the
	// configuration (see config.Validate); authentication is enforced by the
	// web module, so this fixture only has to declare it.
	return &model.WebRule{
		ID:     "rule-fb",
		Name:   "文件",
		Type:   model.WebTypeFiles,
		Path:   "/files",
		Files:  files,
		Access: model.Access{Mode: model.AccessAllow, IPs: []string{"127.0.0.1", "::1"}},
	}
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

func do(t *testing.T, h http.Handler, method, target string, body io.Reader, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func jsonBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return out
}

func errorMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	body := jsonBody(t, rec)
	envelope, _ := body["error"].(map[string]any)
	msg, _ := envelope["message"].(string)
	return msg
}

// newSite builds a site handler for a storage directory.
func newTestSite(t *testing.T, deps *module.Deps, root string, mutate func(*model.FilesTgt)) http.Handler {
	t.Helper()
	svc := New(deps)
	h, err := svc.Site(testRule(mountedRoot(t, deps, root), mutate))
	if err != nil {
		t.Fatalf("site: %v", err)
	}
	if closer, ok := h.(io.Closer); ok {
		t.Cleanup(func() { _ = closer.Close() })
	}
	return h
}

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

func TestSiteListSortSearchAndPaging(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "b.txt", "b")
	seedFile(t, root, "a.txt", "a")
	seedFile(t, root, "dir/c.txt", "c")
	seedFile(t, root, ".hidden", "h")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	rec := do(t, h, http.MethodGet, "/files/_api/list?path=/", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	body := jsonBody(t, rec)
	entries, _ := body["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("want 3 visible entries, got %d (%s)", len(entries), rec.Body.String())
	}
	first, _ := entries[0].(map[string]any)
	if first["name"] != "dir" || first["dir"] != true || first["kind"] != "dir" {
		t.Fatalf("directories come first: %v", first)
	}
	if body["path"] != "/" || body["page"] != float64(1) {
		t.Fatalf("unexpected envelope: %v", body)
	}
	can, _ := body["can"].(map[string]any)
	if can["upload"] != true || can["share"] != true {
		t.Fatalf("capabilities missing: %v", can)
	}

	// Hidden files only show up when the rule asks for them.
	rec = do(t, h, http.MethodGet, "/files/_api/list?path=/&q=hidden", nil, "")
	body = jsonBody(t, rec)
	if entries, _ := body["entries"].([]any); len(entries) != 0 {
		t.Fatalf("hidden file leaked: %s", rec.Body.String())
	}

	// Search, sorting and paging.
	rec = do(t, h, http.MethodGet, "/files/_api/list?path=/&q=.txt&sort=name&order=desc&size=1", nil, "")
	body = jsonBody(t, rec)
	entries, _ = body["entries"].([]any)
	if len(entries) != 1 || body["total"] != float64(2) || body["pages"] != float64(2) {
		t.Fatalf("paging envelope wrong: %s", rec.Body.String())
	}
	page1, _ := entries[0].(map[string]any)
	rec = do(t, h, http.MethodGet, "/files/_api/list?path=/&q=.txt&sort=name&order=desc&size=1&page=2", nil, "")
	entries, _ = jsonBody(t, rec)["entries"].([]any)
	page2, _ := entries[0].(map[string]any)
	if page1["name"] != "b.txt" || page2["name"] != "a.txt" {
		t.Fatalf("descending order broken: %v %v", page1["name"], page2["name"])
	}

	// A file cannot be listed as a directory.
	if rec := do(t, h, http.MethodGet, "/files/_api/list?path=/a.txt", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("listing a file: %d", rec.Code)
	}
}

func TestSiteListRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "a")
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(outside) }()

	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	// Traversal is re-rooted before it reaches the storage, so a file outside
	// the storage root can never be listed or downloaded.
	for _, target := range []string{
		"/files/_api/list?path=/../../",
		"/files/_api/list?path=/../../..",
		"/files/_api/list?path=" + url.QueryEscape(filepath.ToSlash(filepath.Dir(root))),
		"/files/_api/download?path=/../outside.txt",
	} {
		rec := do(t, h, http.MethodGet, target, nil, "")
		if strings.Contains(rec.Body.String(), "outside.txt") {
			t.Fatalf("%s leaked the parent directory: %s", target, rec.Body.String())
		}
		if strings.Contains(target, "outside.txt") && rec.Code == http.StatusOK {
			t.Fatalf("%s downloaded a file outside the storage root", target)
		}
	}
	// Names that keep a literal ".." are rejected outright.
	if rec := do(t, h, http.MethodGet, "/files/_api/list?path=/a..b", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid path: %d %s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

func TestSitePermissions(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "data")
	deps := newTestDeps(t)
	ro := newTestSite(t, deps, root, func(f *model.FilesTgt) { f.ReadOnly = true })

	if rec := do(t, ro, http.MethodGet, "/files/_api/list?path=/", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("read only list: %d", rec.Code)
	}
	if rec := do(t, ro, http.MethodGet, "/files/_api/download?path=/a.txt", nil, ""); rec.Code != http.StatusOK {
		t.Fatalf("read only download: %d", rec.Code)
	}
	for _, tc := range []struct {
		name   string
		target string
		body   string
	}{
		{"mkdir", "/files/_api/mkdir", `{"path":"/","name":"x"}`},
		{"rename", "/files/_api/rename", `{"path":"/a.txt","name":"b.txt"}`},
		{"delete", "/files/_api/delete", `{"paths":["/a.txt"]}`},
	} {
		rec := do(t, ro, http.MethodPost, tc.target, strings.NewReader(tc.body), "application/json")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("read only %s: want 403, got %d (%s)", tc.name, rec.Code, rec.Body.String())
		}
	}
	rec := do(t, ro, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "u.txt", "x"), multipartType(t))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("read only upload: %d", rec.Code)
	}

	// A rule that only allows reading through the mount but not writing.
	limited := newTestSite(t, deps, root, func(f *model.FilesTgt) { f.AllowUpload = false; f.AllowDelete = false })
	if rec := do(t, limited, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "u.txt", "x"), multipartType(t)); rec.Code != http.StatusForbidden {
		t.Fatalf("upload disabled: %d", rec.Code)
	}
	if rec := do(t, limited, http.MethodPost, "/files/_api/delete", strings.NewReader(`{"paths":["/a.txt"]}`), "application/json"); rec.Code != http.StatusForbidden {
		t.Fatalf("delete disabled: %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// write operations
// ---------------------------------------------------------------------------

// multipartUpload builds an upload body with a fixed boundary so that the body
// and its content type can be produced by two separate calls.
func multipartUpload(t *testing.T, name, content string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if err := w.SetBoundary("nunttestboundary"); err != nil {
		t.Fatal(err)
	}
	if name != "" {
		part, err := w.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(part, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, w.FormDataContentType()
}

func multipartBody(t *testing.T, name, content string) *bytes.Buffer {
	t.Helper()
	body, _ := multipartUpload(t, name, content)
	return body
}

func multipartType(t *testing.T) string {
	t.Helper()
	_, contentType := multipartUpload(t, "", "")
	return contentType
}

// downloadURL builds an encoded download target for a file name.
func downloadURL(name string) string {
	return "/files/_api/download?path=" + url.QueryEscape("/"+name)
}

func TestSiteUpload(t *testing.T) {
	root := t.TempDir()
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	rec := do(t, h, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "中文 名字.txt", "hello"), multipartType(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "中文 名字.txt")); err != nil {
		t.Fatalf("uploaded file missing: %v", err)
	}

	// A second upload needs the confirm flag, otherwise it is a conflict.
	rec = do(t, h, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "中文 名字.txt", "again"), multipartType(t))
	if rec.Code != http.StatusConflict {
		t.Fatalf("existing file: want 409, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := jsonBody(t, rec)
	failed, _ := body["failed"].([]any)
	item, _ := failed[0].(map[string]any)
	if item["code"] != "exists" {
		t.Fatalf("missing exists code: %s", rec.Body.String())
	}
	rec = do(t, h, http.MethodPost, "/files/_api/upload?path=/&confirm=1", multipartBody(t, "中文 名字.txt", "again"), multipartType(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("confirmed upload: %d %s", rec.Code, rec.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(root, "中文 名字.txt")); err != nil || string(got) != "again" {
		t.Fatalf("overwritten content: %q %v", got, err)
	}

	// A file name that tries to escape is cleaned instead.
	rec = do(t, h, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "../../evil.txt", "x"), multipartType(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("upload with traversal name: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "evil.txt")); err != nil {
		t.Fatalf("sanitised file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "evil.txt")); err == nil {
		t.Fatalf("upload escaped the storage root")
	}

	// A directory with the same name blocks the upload.
	if err := os.Mkdir(filepath.Join(root, "blocked.txt"), 0o750); err != nil {
		t.Fatal(err)
	}
	rec = do(t, h, http.MethodPost, "/files/_api/upload?path=/", multipartBody(t, "blocked.txt", "x"), multipartType(t))
	if rec.Code != http.StatusConflict {
		t.Fatalf("directory conflict: %d %s", rec.Code, rec.Body.String())
	}
}

func TestSiteMkdirRenameDelete(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "data")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	rec := do(t, h, http.MethodPost, "/files/_api/mkdir", strings.NewReader(`{"path":"/","name":"新目录"}`), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("mkdir: %d %s", rec.Code, rec.Body.String())
	}
	if info, err := os.Stat(filepath.Join(root, "新目录")); err != nil || !info.IsDir() {
		t.Fatalf("directory missing: %v", err)
	}
	if rec := do(t, h, http.MethodPost, "/files/_api/mkdir", strings.NewReader(`{"path":"/","name":"新目录"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("duplicate mkdir: %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/files/_api/mkdir", strings.NewReader(`{"path":"/","name":"../escape"}`), "application/json"); rec.Code != http.StatusOK {
		t.Fatalf("mkdir with traversal name: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "escape")); err != nil {
		t.Fatalf("traversal name was not cleaned: %v", err)
	}

	rec = do(t, h, http.MethodPost, "/files/_api/rename", strings.NewReader(`{"path":"/a.txt","name":"renamed.txt"}`), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "renamed.txt")); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if rec := do(t, h, http.MethodPost, "/files/_api/rename", strings.NewReader(`{"path":"/renamed.txt","name":"新目录"}`), "application/json"); rec.Code != http.StatusConflict {
		t.Fatalf("rename onto an existing name: %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/files/_api/rename", strings.NewReader(`{"path":"/","name":"root"}`), "application/json"); rec.Code != http.StatusBadRequest {
		t.Fatalf("renaming the root: %d", rec.Code)
	}

	rec = do(t, h, http.MethodPost, "/files/_api/delete", strings.NewReader(`{"paths":["/renamed.txt","/新目录","/missing.txt","/"]}`), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	body := jsonBody(t, rec)
	removed, _ := body["removed"].([]any)
	failed, _ := body["failed"].([]any)
	if len(removed) != 2 || len(failed) != 2 {
		t.Fatalf("unexpected delete result: %s", rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "renamed.txt")); !os.IsNotExist(err) {
		t.Fatalf("file was not deleted: %v", err)
	}
}

func TestSiteDownloadAndRanges(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "中文 名字.txt", "0123456789")
	seedFile(t, root, "page.html", "<html></html>")
	seedFile(t, root, "logo.svg", "<svg/>")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	rec := do(t, h, http.MethodGet, downloadURL("中文 名字.txt"), nil, "")
	if rec.Code != http.StatusOK || rec.Body.String() != "0123456789" {
		t.Fatalf("download: %d %q", rec.Code, rec.Body.String())
	}
	disposition := rec.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disposition, "attachment;") || !strings.Contains(disposition, "filename*=UTF-8''") {
		t.Fatalf("content disposition: %q", disposition)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("nosniff header missing")
	}

	// Active content must never be inlined.
	rec = do(t, h, http.MethodGet, "/files/_api/download?path=/page.html&inline=1", nil, "")
	if !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatalf("html was inlined: %q", rec.Header().Get("Content-Disposition"))
	}
	rec = do(t, h, http.MethodGet, "/files/_api/download?path=/logo.svg&inline=1", nil, "")
	if !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatalf("svg was inlined: %q", rec.Header().Get("Content-Disposition"))
	}

	// Byte ranges for media players.
	req := httptest.NewRequest(http.MethodGet, downloadURL("中文 名字.txt"), nil)
	req.Header.Set("Range", "bytes=2-5")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "2345" {
		t.Fatalf("range download: %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("content range: %q", got)
	}
	req = httptest.NewRequest(http.MethodGet, downloadURL("中文 名字.txt"), nil)
	req.Header.Set("Range", "bytes=100-200")
	if rec = httptest.NewRecorder(); true {
		h.ServeHTTP(rec, req)
	}
	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("invalid range: %d", rec.Code)
	}

	// Downloading a directory is refused.
	if rec := do(t, h, http.MethodGet, "/files/_api/download?path=/", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("directory download: %d", rec.Code)
	}
	// The zip endpoint streams an archive for a directory.
	rec = do(t, h, http.MethodGet, "/files/_api/zip?path=/", nil, "")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("zip: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("PK")) {
		t.Fatalf("zip body is not an archive")
	}
}

// ---------------------------------------------------------------------------
// share links
// ---------------------------------------------------------------------------

func createShareForTest(t *testing.T, h http.Handler, path string) map[string]any {
	t.Helper()
	rec := do(t, h, http.MethodPost, "/files/_api/share", strings.NewReader(`{"path":"`+path+`","ttlMinutes":60,"allowDownload":true}`), "application/json")
	if rec.Code != http.StatusOK {
		t.Fatalf("create share: %d %s", rec.Code, rec.Body.String())
	}
	return jsonBody(t, rec)
}

func TestShareLifecycle(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "public/a.txt", "shared")
	seedFile(t, root, "private.txt", "secret")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	share := createShareForTest(t, h, "/public")
	token, _ := share["token"].(string)
	if len(token) < 16 {
		t.Fatalf("share token looks weak: %q", token)
	}
	if url, _ := share["url"].(string); url != "http://example.com/files/_share/"+token {
		t.Fatalf("share url: %q", url)
	}

	// The share page and its read only API work without any credentials.
	rec := do(t, h, http.MethodGet, "/files/_share/"+token, nil, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "window.__FB") {
		t.Fatalf("share page: %d", rec.Code)
	}
	rec = do(t, h, http.MethodGet, "/files/_share/"+token+"/list?path=/public", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("share list: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "a.txt") {
		t.Fatalf("share list misses the file: %s", rec.Body.String())
	}
	rec = do(t, h, http.MethodGet, "/files/_share/"+token+"/download?path=/public/a.txt", nil, "")
	if rec.Code != http.StatusOK || rec.Body.String() != "shared" {
		t.Fatalf("share download: %d %q", rec.Code, rec.Body.String())
	}

	// Escaping the shared subtree is forbidden.
	rec = do(t, h, http.MethodGet, "/files/_share/"+token+"/download?path=/private.txt", nil, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("share escape download: %d", rec.Code)
	}
	rec = do(t, h, http.MethodGet, "/files/_share/"+token+"/list?path=/", nil, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("share escape list: %d", rec.Code)
	}
	// Write operations are not exposed by a share link at all.
	if rec := do(t, h, http.MethodPost, "/files/_share/"+token+"/upload?path=/public", multipartBody(t, "x.txt", "x"), multipartType(t)); rec.Code == http.StatusOK {
		t.Fatalf("share link allowed an upload")
	}
	// An unknown token is not found.
	if rec := do(t, h, http.MethodGet, "/files/_share/deadbeef", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token: %d", rec.Code)
	}

	// Expiry is enforced and pruned.
	store := storeFor(deps.DataDir, "rule-fb")
	shares, err := store.list()
	if err != nil || len(shares) != 1 {
		t.Fatalf("stored shares: %v %v", shares, err)
	}
	shares[0].ExpiresAt = time.Now().Add(-time.Minute)
	if err := store.save(shares); err != nil {
		t.Fatalf("save expired share: %v", err)
	}
	if rec := do(t, h, http.MethodGet, "/files/_share/"+token, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("expired share: %d", rec.Code)
	}
	remaining, err := store.list()
	if err != nil || len(remaining) != 0 {
		t.Fatalf("expired share was not pruned: %v %v", remaining, err)
	}
}

func TestShareRevokeAndPermissions(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "data")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)
	token, _ := createShareForTest(t, h, "/a.txt")["token"].(string)

	rec := do(t, h, http.MethodDelete, "/files/_api/shares?token="+token, nil, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, h, http.MethodGet, "/files/_share/"+token, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("revoked share: %d", rec.Code)
	}

	// A rule without share links refuses to create one.
	plain := newTestSite(t, deps, root, func(f *model.FilesTgt) { f.ShareLinks = false })
	rec = do(t, plain, http.MethodPost, "/files/_api/share", strings.NewReader(`{"path":"/a.txt"}`), "application/json")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("share disabled: %d", rec.Code)
	}
}

func TestSharesAdminAPI(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "a.txt", "data")
	deps := newTestDeps(t)
	// The admin API resolves the rule from the configuration.
	rule := testRule(mountedRoot(t, deps, root), nil)
	rule.Listen = []string{":18080"}
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, *rule)
		return nil
	}); err != nil {
		t.Fatalf("register rule: %v", err)
	}
	svc := New(deps)
	if _, err := svc.Site(rule); err != nil {
		t.Fatalf("site: %v", err)
	}
	mux := rest.NewMux(slog.New(slog.DiscardHandler))
	svc.RegisterAPI(mux)
	svc.RegisterAPI(mux) // registering twice must not panic

	create := do(t, mux, http.MethodPost, "/api/v1/files/shares", strings.NewReader(`{"rule":"rule-fb","path":"/a.txt","ttlMinutes":30,"allowDownload":true}`), "application/json")
	if create.Code != http.StatusOK {
		t.Fatalf("admin create: %d %s", create.Code, create.Body.String())
	}
	share := jsonBody(t, create)
	token, _ := share["token"].(string)
	if token == "" {
		t.Fatalf("admin create returned no token: %s", create.Body.String())
	}
	if fullURL, _ := share["url"].(string); !strings.HasPrefix(fullURL, "http://example.com/files/_share/") {
		t.Fatalf("the created share must carry an absolute url, got %q", fullURL)
	}

	list := do(t, mux, http.MethodGet, "/api/v1/files/shares?rule=rule-fb", nil, "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), token) {
		t.Fatalf("admin list: %d %s", list.Code, list.Body.String())
	}
	if rec := do(t, mux, http.MethodPost, "/api/v1/files/shares", strings.NewReader(`{"rule":"nope","path":"/a.txt"}`), "application/json"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown rule: %d", rec.Code)
	}
	if rec := do(t, mux, http.MethodDelete, "/api/v1/files/shares/"+token, nil, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("admin delete: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(t, mux, http.MethodDelete, "/api/v1/files/shares/"+token, nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("admin delete twice: %d", rec.Code)
	}

	// The direct mount download used by the storage page.
	rec := do(t, mux, http.MethodGet, "/api/v1/files/download?mount=mount-fb&path=/a.txt", nil, "")
	if rec.Code != http.StatusOK || rec.Body.String() != "data" {
		t.Fatalf("mount download: %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment; ") || !strings.Contains(got, "filename*=UTF-8''") {
		t.Fatalf("mount download disposition: %q", got)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("mount download is missing nosniff")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/files/download?mount=mount-fb&path=/a.txt", nil)
	req.Header.Set("Range", "bytes=1-2")
	rangeRec := httptest.NewRecorder()
	mux.ServeHTTP(rangeRec, req)
	if rangeRec.Code != http.StatusPartialContent || rangeRec.Body.String() != "at" {
		t.Fatalf("mount download range: %d %q", rangeRec.Code, rangeRec.Body.String())
	}
	if got := rangeRec.Header().Get("Content-Range"); got != "bytes 1-2/4" {
		t.Fatalf("mount download content range: %q", got)
	}
	if rec := do(t, mux, http.MethodGet, "/api/v1/files/download?mount=nope&path=/a.txt", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown mount: %d", rec.Code)
	}
	if rec := do(t, mux, http.MethodGet, "/api/v1/files/download?mount=mount-fb&path=/missing.txt", nil, ""); rec.Code != http.StatusNotFound {
		t.Fatalf("missing file: %d", rec.Code)
	}
	if rec := do(t, mux, http.MethodGet, "/api/v1/files/download?mount=mount-fb&path=/", nil, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("directory download: %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func TestSiteRejectsBrokenRules(t *testing.T) {
	deps := newTestDeps(t)
	svc := New(deps)
	if _, err := svc.Site(nil); err == nil {
		t.Fatalf("nil rule must fail")
	}
	if _, err := svc.Site(&model.WebRule{ID: "x", Name: "x", Path: "/x"}); err == nil {
		t.Fatalf("a rule without storage must fail")
	}
	if _, err := svc.Site(testRule("missing-mount", nil)); err == nil {
		t.Fatalf("an unknown mount must fail")
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"a.txt":         "a.txt",
		"../escape.txt": "escape.txt",
		"..":            "",
		"dir/file.txt":  "file.txt",
		"bad:name?.txt": "bad_name_.txt",
		"trailing. ":    "trailing",
		"a\x00b":        "ab",
		"中文 名字.txt":     "中文 名字.txt",
	}
	for in, want := range cases {
		got, err := sanitizeName(in)
		if want == "" {
			if err == nil {
				t.Fatalf("sanitizeName(%q) should fail, got %q", in, got)
			}
			continue
		}
		if err != nil || got != want {
			t.Fatalf("sanitizeName(%q) = %q, %v (want %q)", in, got, err, want)
		}
	}
	if got, err := sanitizeName("CON"); err != nil || got != "_CON" {
		t.Fatalf("reserved name: %q %v", got, err)
	}
}

func TestParseRangeHeader(t *testing.T) {
	start, length, partial, err := parseRange("", 10)
	if err != nil || partial || start != 0 || length != 0 {
		t.Fatalf("empty range: %d %d %t %v", start, length, partial, err)
	}
	start, length, partial, err = parseRange("bytes=0-3", 10)
	if err != nil || !partial || start != 0 || length != 4 {
		t.Fatalf("prefix range: %d %d %t %v", start, length, partial, err)
	}
	start, length, partial, err = parseRange("bytes=5-", 10)
	if err != nil || !partial || start != 5 || length != 5 {
		t.Fatalf("open range: %d %d %t %v", start, length, partial, err)
	}
	start, length, partial, err = parseRange("bytes=-3", 10)
	if err != nil || !partial || start != 7 || length != 3 {
		t.Fatalf("suffix range: %d %d %t %v", start, length, partial, err)
	}
	if _, _, _, err = parseRange("bytes=20-30", 10); err == nil {
		t.Fatalf("out of range start must fail")
	}
	if _, _, _, err = parseRange("bytes=5-2", 10); err == nil {
		t.Fatalf("inverted range must fail")
	}
	// Multi ranges are ignored on purpose.
	if _, _, partial, err = parseRange("bytes=0-1,4-5", 10); err != nil || partial {
		t.Fatalf("multi range must be ignored")
	}
}

func TestContentDisposition(t *testing.T) {
	got := contentDisposition("中文 名字.txt", false)
	if !strings.HasPrefix(got, "attachment; ") || !strings.Contains(got, "filename*=UTF-8''") {
		t.Fatalf("disposition: %q", got)
	}
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("header injection: %q", got)
	}
	inline := contentDisposition("a.txt", true)
	if !strings.HasPrefix(inline, "inline; ") {
		t.Fatalf("inline disposition: %q", inline)
	}
}

// zipEntryNames returns the names stored in a zip archive.
func zipEntryNames(t *testing.T, data []byte) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	return names
}

// A share link scoped to one directory must never archive the whole storage
// root. The missing path parameter used to be re-read inside the zip handler and
// resolved to "/", which turned "download the shared folder as a zip" into
// "download everything on the mount".
func TestShareZipStaysInsideTheShare(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "public/inside.txt", "inside")
	seedFile(t, root, "private.txt", "secret")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	token, _ := createShareForTest(t, h, "/public")["token"].(string)
	base := "/files/_share/" + token

	for _, target := range []string{base + "/download?zip=1", base + "/zip"} {
		rec := do(t, h, http.MethodGet, target, nil, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", target, rec.Code, rec.Body.String())
		}
		names := zipEntryNames(t, rec.Body.Bytes())
		for _, name := range names {
			if name == "private.txt" || strings.HasPrefix(name, "../") {
				t.Fatalf("%s archived data outside the share: %v", target, names)
			}
		}
		found := false
		for _, name := range names {
			if name == "inside.txt" {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s missed the shared file: %v", target, names)
		}
	}
}

// pageConfigFromBody extracts the JSON the page hands to its own script.
func pageConfigFromBody(t *testing.T, body []byte) map[string]any {
	t.Helper()
	const marker = "window.__FB = "
	text := string(body)
	start := strings.Index(text, marker)
	if start < 0 {
		t.Fatalf("page does not carry its configuration: %s", text)
	}
	rest := text[start+len(marker):]
	end := strings.Index(rest, ";</script>")
	if end < 0 {
		t.Fatalf("page configuration is not terminated")
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(rest[:end]), &cfg); err != nil {
		t.Fatalf("decode page configuration %q: %v", rest[:end], err)
	}
	return cfg
}

// The share page talks to the endpoints that exist below the share token. It
// used to point its own script at .../_share/<token>/_api, a prefix the server
// never routes, so every share page opened with an empty file list.
func TestSharePageAPIRoutesResolve(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "public/a.txt", "shared")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	token, _ := createShareForTest(t, h, "/public")["token"].(string)
	rec := do(t, h, http.MethodGet, "/files/_share/"+token, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("share page: %d", rec.Code)
	}
	api, _ := pageConfigFromBody(t, rec.Body.Bytes())["api"].(string)
	if api != "/files/_share/"+token {
		t.Fatalf("share page api = %q, want %q", api, "/files/_share/"+token)
	}

	// Every endpoint the page calls must answer on that base.
	for _, endpoint := range []string{"/list?path=/public", "/download?path=/public/a.txt"} {
		if got := do(t, h, http.MethodGet, api+endpoint, nil, ""); got.Code != http.StatusOK {
			t.Fatalf("share page endpoint %s: %d %s", api+endpoint, got.Code, got.Body.String())
		}
	}
}

// A failed upload must not destroy the file it was going to replace: the bytes
// go to a hidden temporary file and are renamed only after a complete write.
func TestUploadFailureKeepsTheExistingFile(t *testing.T) {
	root := t.TempDir()
	seedFile(t, root, "keep.txt", "original")
	deps := newTestDeps(t)
	h := newTestSite(t, deps, root, nil)

	// A multipart body whose file part is truncated: reading it fails halfway.
	body := strings.Join([]string{
		"--BOUNDARY",
		`Content-Disposition: form-data; name="file"; filename="keep.txt"`,
		"Content-Type: text/plain",
		"",
		"partial data",
	}, "\r\n") // no closing boundary, so the part ends with an error

	req := httptest.NewRequest(http.MethodPost, "/files/_api/upload?path=/&confirm=1", strings.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=BOUNDARY")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a truncated upload", rec.Code)
	}
	got, err := os.ReadFile(filepath.Join(root, "keep.txt"))
	if err != nil {
		t.Fatalf("read the existing file: %v", err)
	}
	if string(got) != "original" {
		t.Fatalf("the failed upload replaced the file: %q", got)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".part-") {
			t.Fatalf("temporary upload file left behind: %s", e.Name())
		}
	}
}
