package web

import (
	"github.com/nunt/nunt/internal/model"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestStaticServesIndexAndRange(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>hello</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("abcdefghij", 10) // 100 bytes
	if err := os.WriteFile(filepath.Join(root, "data.txt"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".secret"), []byte("hidden"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "index.html"), []byte("sub"), 0o600); err != nil {
		t.Fatal(err)
	}

	store := newStaticStore(t, root)
	raw := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	raw.Static = &model.StaticTgt{Root: root, Listing: true, CacheSeconds: 60}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	site, err := bareWeb().staticSite(compiled)
	if err != nil {
		t.Fatalf("staticSite: %v", err)
	}
	site.static = store

	handler := bareWeb()
	if _, gerr := store.get(); gerr != nil {
		t.Fatalf("test store: %v", gerr)
	}
	serve := func(method, target string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rw := httptest.NewRecorder()
		handler.serveStatic(compiled, store, raw.Static, defaultIndexFiles, 60, rw, req)
		return rw
	}

	// index file
	rw := serve(http.MethodGet, "http://example.com/", nil)
	if rw.Code != http.StatusOK || !strings.Contains(rw.Body.String(), "hello") {
		t.Fatalf("index: status %d body %q", rw.Code, rw.Body.String())
	}
	if ct := rw.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("index content type = %q", ct)
	}
	if cc := rw.Header().Get("Cache-Control"); cc != "public, max-age=60" {
		t.Fatalf("cache control = %q", cc)
	}

	// Range request
	rw = serve(http.MethodGet, "http://example.com/data.txt", map[string]string{"Range": "bytes=10-19"})
	if rw.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d", rw.Code)
	}
	if got := rw.Body.String(); got != body[10:20] {
		t.Fatalf("range body = %q, want %q", got, body[10:20])
	}
	if cr := rw.Header().Get("Content-Range"); cr != "bytes 10-19/100" {
		t.Fatalf("content range = %q", cr)
	}

	// Unsatisfiable range
	rw = serve(http.MethodGet, "http://example.com/data.txt", map[string]string{"Range": "bytes=500-600"})
	if rw.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("bad range status = %d", rw.Code)
	}

	// Hidden files stay hidden.
	rw = serve(http.MethodGet, "http://example.com/.secret", nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("hidden file status = %d", rw.Code)
	}

	// Traversal attempts never escape the root.
	rw = serve(http.MethodGet, "http://example.com/../config.json", nil)
	if rw.Code == http.StatusOK && strings.Contains(rw.Body.String(), "users") {
		t.Fatalf("path traversal was served: %d %q", rw.Code, rw.Body.String())
	}

	// Directory listing.
	rw = serve(http.MethodGet, "http://example.com/sub2/", nil)
	if rw.Code != http.StatusNotFound {
		t.Fatalf("unknown directory status = %d", rw.Code)
	}
	rw = serve(http.MethodGet, "http://example.com/sub", nil)
	if rw.Code != http.StatusMovedPermanently {
		t.Fatalf("directory without slash status = %d", rw.Code)
	}
	if loc := rw.Header().Get("Location"); loc != "/sub/" {
		t.Fatalf("directory redirect location = %q", loc)
	}
	rw = serve(http.MethodGet, "http://example.com/sub/", nil)
	if rw.Code != http.StatusOK || !strings.Contains(rw.Body.String(), "sub") {
		t.Fatalf("sub index: %d %q", rw.Code, rw.Body.String())
	}

	// Methods other than GET and HEAD are rejected.
	rw = serve(http.MethodPost, "http://example.com/", nil)
	if rw.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post status = %d", rw.Code)
	}
}

func TestStaticListing(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "dir"), 0o750); err != nil {
		t.Fatal(err)
	}
	store := newStaticStore(t, root)
	raw := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	raw.Static = &model.StaticTgt{Root: root, Listing: true}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	rw := httptest.NewRecorder()
	bareWeb().serveStatic(compiled, store, raw.Static, defaultIndexFiles, 0, rw, req)
	if rw.Code != http.StatusOK {
		t.Fatalf("listing status = %d", rw.Code)
	}
	body := rw.Body.String()
	for _, want := range []string{"Index of /", "a.txt", "dir/"} {
		if !strings.Contains(body, want) {
			t.Errorf("listing does not contain %q: %s", want, body)
		}
	}
	if cc := rw.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("listing cache control = %q", cc)
	}
	if strings.Contains(body, "../") {
		t.Errorf("the root listing must not link to a parent directory: %s", body)
	}

	// A sub directory listing links back to its parent.
	req = httptest.NewRequest(http.MethodGet, "http://example.com/dir/", nil)
	rw = httptest.NewRecorder()
	bareWeb().serveStatic(compiled, store, raw.Static, defaultIndexFiles, 0, rw, req)
	if rw.Code != http.StatusOK {
		t.Fatalf("sub listing status = %d", rw.Code)
	}
	if body := rw.Body.String(); !strings.Contains(body, "Index of /dir") || !strings.Contains(body, "href=\"../\"") {
		t.Fatalf("sub listing is incomplete: %s", body)
	}
}

func TestStaticSPAFallback(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("spa"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newStaticStore(t, root)
	raw := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	raw.Static = &model.StaticTgt{Root: root, SPA: true}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	query := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rw := httptest.NewRecorder()
		bareWeb().serveStatic(compiled, store, raw.Static, defaultIndexFiles, 0, rw, req)
		return rw
	}
	if rw := query("http://example.com/some/route"); rw.Code != http.StatusOK || rw.Body.String() != "spa" {
		t.Fatalf("spa route: %d %q", rw.Code, rw.Body.String())
	}
	if rw := query("http://example.com/missing.js"); rw.Code != http.StatusNotFound {
		t.Fatalf("spa asset fallback should not happen: %d", rw.Code)
	}
}

func TestStaticHiddenAndTraversal(t *testing.T) {
	if !hiddenPath("/.git/config") || !hiddenPath("/a/.env") {
		t.Fatal("hidden path not detected")
	}
	if hiddenPath("/a/b.txt") || hiddenPath("/") {
		t.Fatal("visible path reported as hidden")
	}
}

func TestRedirectHandler(t *testing.T) {
	raw := mkRule(t, "redir", "example.com", "/", 0, model.WebTypeRedirect)
	raw.Redirect = &model.RedirectTgt{To: "https://target.example/base", Status: 301, KeepPath: true}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	site, err := bareWeb().redirectSite(compiled)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.com/docs/page?a=1", nil)
	rw := httptest.NewRecorder()
	site.handler.ServeHTTP(rw, req)
	if rw.Code != http.StatusMovedPermanently {
		t.Fatalf("status = %d", rw.Code)
	}
	if loc := rw.Header().Get("Location"); loc != "https://target.example/base/docs/page?a=1" {
		t.Fatalf("location = %q", loc)
	}

	raw.Redirect = &model.RedirectTgt{To: "https://target.example$uri", Status: 308}
	compiled, _ = compileRule(raw, 0)
	site, _ = bareWeb().redirectSite(compiled)
	rw = httptest.NewRecorder()
	site.handler.ServeHTTP(rw, httptest.NewRequest(http.MethodGet, "http://example.com/a/b?x=2", nil))
	if loc := rw.Header().Get("Location"); loc != "https://target.example/a/b?x=2" {
		t.Fatalf("variable location = %q", loc)
	}

	if safeRedirect("javascript:alert(1)") {
		t.Fatal("javascript target must be rejected")
	}
	if safeRedirect("https://ok.example\r\nX-Evil: 1") {
		t.Fatal("header injection must be rejected")
	}
	if !safeRedirect("https://ok.example/x") {
		t.Fatal("a plain https target must be accepted")
	}
}

func TestProxyForwardedHeadersFollowTrust(t *testing.T) {
	var xff, proto, host string
	backend := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		xff = req.Header.Get("X-Forwarded-For")
		proto = req.Header.Get("X-Forwarded-Proto")
		host = req.Header.Get("X-Forwarded-Host")
		_, _ = io.WriteString(rw, "ok")
	}))
	defer backend.Close()

	call := func(name string, cfg *model.Config) {
		t.Helper()
		// A fresh rule per call: the reverse proxy cache is keyed by rule, and
		// a cached handler would keep the previous test's configuration.
		raw := mkRule(t, name, "example.com", "/", 0, model.WebTypeProxy)
		raw.Proxy = &model.ProxyTarget{Targets: []string{backend.URL}}
		compiled, err := compileRule(raw, 0)
		if err != nil {
			t.Fatalf("compile: %v", err)
		}
		w := bareWeb()
		w.cfg = cfg
		w.storeTrust(cfg)
		site, err := w.proxySite(compiled, cfg)
		if err != nil {
			t.Fatalf("proxySite: %v", err)
		}
		ctl := httptest.NewServer(site.handler)
		defer ctl.Close()
		req, err := http.NewRequest(http.MethodGet, ctl.URL+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "example.com"
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Forwarded-Host", "made-up.example")
		resp, err := ctl.Client().Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		_ = resp.Body.Close()
	}

	call("forwarded-untrusted", &model.Config{})
	if strings.Contains(xff, "203.0.113.9") {
		t.Fatalf("an untrusted proxy must not keep the client chain: %q", xff)
	}
	if !strings.HasPrefix(xff, "127.0.0.1") {
		t.Fatalf("X-Forwarded-For = %q, want the connection address", xff)
	}
	if proto != "http" || host != "example.com" {
		t.Fatalf("proto/host = %q/%q, want the observed values", proto, host)
	}

	call("forwarded-trusted", &model.Config{System: model.SystemConfig{TrustProxy: true, TrustedProxies: []string{"127.0.0.1"}}})
	if !strings.HasPrefix(xff, "203.0.113.9, ") {
		t.Fatalf("a trusted proxy must keep the chain: %q", xff)
	}
	if proto != "https" || host != "made-up.example" {
		t.Fatalf("a trusted proxy must keep proto/host, got %q/%q", proto, host)
	}

	// trustProxy without a proxy list trusts nobody: the chain is rebuilt from
	// the connection like an untrusted request.
	call("forwarded-flag-without-list", &model.Config{System: model.SystemConfig{TrustProxy: true}})
	if strings.Contains(xff, "203.0.113.9") {
		t.Fatalf("trustProxy without trusted proxies must not keep the chain: %q", xff)
	}
	if !strings.HasPrefix(xff, "127.0.0.1") {
		t.Fatalf("X-Forwarded-For = %q, want the connection address", xff)
	}
}

func TestProxyRoundTrip(t *testing.T) {
	var gotPath, gotHost, gotXFF, gotProto, gotHeader string
	var hits int
	backend := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		hits++
		gotPath = req.URL.Path + "?" + req.URL.RawQuery
		gotHost = req.Host
		gotXFF = req.Header.Get("X-Forwarded-For")
		gotProto = req.Header.Get("X-Forwarded-Proto")
		gotHeader = req.Header.Get("X-Rule")
		rw.Header().Set("X-Upstream", "one")
		rw.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(rw, "backend")
	}))
	defer backend.Close()

	raw := mkRule(t, "proxy", "example.com", "/app", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{
		Targets:     []string{backend.URL},
		Balance:     "roundrobin",
		HostHeader:  "upstream.internal",
		Headers:     map[string]string{"X-Rule": "value"},
		RespHeaders: map[string]string{"X-Added": "yes"},
		PathPrefix:  "/app",
		PathReplace: "/backend",
	}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	site, err := bareWeb().proxySite(compiled, &model.Config{})
	if err != nil {
		t.Fatalf("proxySite: %v", err)
	}

	ctl := httptest.NewServer(site.handler)
	defer ctl.Close()
	req, err := http.NewRequest(http.MethodGet, ctl.URL+"/app/users?page=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	resp, err := ctl.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusTeapot {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if string(body) != "backend" {
		t.Fatalf("body = %q", body)
	}
	if gotPath != "/backend/users?page=2" {
		t.Fatalf("upstream path = %q, want /backend/users?page=2", gotPath)
	}
	if gotHost != "upstream.internal" {
		t.Fatalf("upstream host = %q", gotHost)
	}
	if gotXFF == "" {
		t.Fatal("X-Forwarded-For was not set")
	}
	if gotProto != "http" {
		t.Fatalf("X-Forwarded-Proto = %q", gotProto)
	}
	if gotHeader != "value" {
		t.Fatalf("custom request header = %q", gotHeader)
	}
	if resp.Header.Get("X-Added") != "yes" {
		t.Fatalf("custom response header = %q", resp.Header.Get("X-Added"))
	}
	if hits != 1 {
		t.Fatalf("backend hits = %d", hits)
	}
}

func TestProxyRoundRobin(t *testing.T) {
	var mu sync.Mutex
	seen := []string{}
	newBackend := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			seen = append(seen, name)
			mu.Unlock()
			_, _ = io.WriteString(rw, name)
		}))
	}
	first := newBackend("one")
	defer first.Close()
	second := newBackend("two")
	defer second.Close()

	raw := mkRule(t, "proxy", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: []string{first.URL, second.URL}, Balance: "roundrobin"}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	site, err := bareWeb().proxySite(compiled, &model.Config{})
	if err != nil {
		t.Fatal(err)
	}
	ctl := httptest.NewServer(site.handler)
	defer ctl.Close()

	for i := 0; i < 4; i++ {
		resp, err := ctl.Client().Get(ctl.URL + "/")
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 4 {
		t.Fatalf("backend hits = %d", len(seen))
	}
	counts := map[string]int{}
	for _, name := range seen {
		counts[name]++
	}
	if counts["one"] != 2 || counts["two"] != 2 {
		t.Fatalf("round robin distribution = %v", counts)
	}
}

func TestProxyUpstreamFailure(t *testing.T) {
	// Bind and close a port so the upstream refuses the connection.
	dead, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := dead.Addr().String()
	_ = dead.Close()

	raw := mkRule(t, "proxy", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: []string{"http://" + addr}, TimeoutSec: 2}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	site, err := bareWeb().proxySite(compiled, &model.Config{})
	if err != nil {
		t.Fatal(err)
	}
	ctl := httptest.NewServer(site.handler)
	defer ctl.Close()
	resp, err := ctl.Client().Get(ctl.URL + "/")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
}

func TestStaticConditionalRequest(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "app.js"), []byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newStaticStore(t, root)
	raw := mkRule(t, "static", "example.com", "/", 0, model.WebTypeStatic)
	raw.Static = &model.StaticTgt{Root: root}
	compiled, err := compileRule(raw, 0)
	if err != nil {
		t.Fatal(err)
	}
	get := func(headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://example.com/app.js", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rw := httptest.NewRecorder()
		bareWeb().serveStatic(compiled, store, raw.Static, defaultIndexFiles, 0, rw, req)
		return rw
	}
	first := get(nil)
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d", first.Code)
	}
	if ct := first.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("content type = %q", ct)
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no etag")
	}
	second := get(map[string]string{"If-None-Match": etag})
	if second.Code != http.StatusNotModified {
		t.Fatalf("conditional status = %d", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Fatalf("conditional body = %q", second.Body.String())
	}
}
