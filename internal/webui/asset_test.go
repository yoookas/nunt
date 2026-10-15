package webui

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/andybalholm/brotli"
)

// testAssets 是一棵最小的资源树：一个文本 JS、一个 HTML 外壳、一个二进制图片。
func testAssets() fstest.MapFS {
	return fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><html><body>" + strings.Repeat("shell ", 400) + "</body></html>")},
		"app.js":     {Data: []byte("export const version = '1';\n" + strings.Repeat("console.log('nunt');\n", 400))},
		"style.css":  {Data: []byte("body{margin:0}\n" + strings.Repeat(".card{padding:8px}\n", 200))},
		"logo.png":   {Data: []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d}},
		"font.woff2": {Data: []byte("wOF2" + strings.Repeat("\x00", 64))},
	}
}

func newTestHandler(t *testing.T) *assetHandler {
	t.Helper()
	return newAssetHandler(testAssets())
}

// get 发一个请求并返回响应。
func get(t *testing.T, h http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeGzip(t *testing.T, body []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer zr.Close()
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	return out
}

func decodeBrotli(t *testing.T, body []byte) []byte {
	t.Helper()
	out, err := io.ReadAll(brotli.NewReader(bytes.NewReader(body)))
	if err != nil {
		t.Fatalf("brotli read: %v", err)
	}
	return out
}

func rawAsset(t *testing.T, name string) []byte {
	t.Helper()
	data, err := fs.ReadFile(testAssets(), name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return data
}

func TestGzipResponseMatchesSource(t *testing.T) {
	h := newTestHandler(t)
	rec := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != encodingGzip {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary = %q, want it to contain Accept-Encoding", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Fatalf("Content-Type = %q, want text/javascript", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=600" {
		t.Fatalf("Cache-Control = %q", got)
	}
	// 压缩响应的长度是已知的，必须显式写 Content-Length：net/http 在有
	// Content-Encoding 时不会自己写，否则会退化成 chunked。
	if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
		t.Fatalf("Content-Length = %q, want %d", got, rec.Body.Len())
	}
	want := rawAsset(t, "app.js")
	if bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatal("response body is not compressed")
	}
	if got := decodeGzip(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
		t.Fatalf("decompressed body differs from source (%d vs %d bytes)", len(got), len(want))
	}
}

func TestBrotliPreferredOverGzip(t *testing.T) {
	h := newTestHandler(t)
	for _, header := range []string{"gzip, br", "br, gzip", "gzip;q=0.5, br;q=1", "*"} {
		rec := get(t, h, "/app.js", map[string]string{"Accept-Encoding": header})
		if got := rec.Header().Get("Content-Encoding"); got != encodingBrotli {
			t.Fatalf("Accept-Encoding %q: Content-Encoding = %q, want br", header, got)
		}
		want := rawAsset(t, "app.js")
		if got := decodeBrotli(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
			t.Fatalf("Accept-Encoding %q: decompressed body differs from source", header)
		}
	}
}

func TestGzipWinsWhenBrotliIsNotAcceptable(t *testing.T) {
	h := newTestHandler(t)
	rec := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip, br;q=0"})
	if got := rec.Header().Get("Content-Encoding"); got != encodingGzip {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
}

func TestNoCompressionWhenUnsupported(t *testing.T) {
	h := newTestHandler(t)
	for _, header := range []string{"", "identity", "deflate", "zstd", "gzip;q=0, br;q=0"} {
		rec := get(t, h, "/app.js", map[string]string{"Accept-Encoding": header})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("Accept-Encoding %q: Content-Encoding = %q, want none", header, got)
		}
		want := rawAsset(t, "app.js")
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Fatalf("Accept-Encoding %q: body is not the source", header)
		}
	}
}

func TestBinaryAssetsAreNotCompressed(t *testing.T) {
	h := newTestHandler(t)
	for _, name := range []string{"/logo.png", "/font.woff2"} {
		rec := get(t, h, name, map[string]string{"Accept-Encoding": "gzip, br"})
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: Content-Encoding = %q, want none", name, got)
		}
		if got := rec.Header().Get("Vary"); got != "" {
			t.Fatalf("%s: Vary = %q, want empty for a non-compressible asset", name, got)
		}
		if !bytes.Equal(rec.Body.Bytes(), rawAsset(t, strings.TrimPrefix(name, "/"))) {
			t.Fatalf("%s: body is not the source", name)
		}
	}
}

func TestConditionalRequestWithETag(t *testing.T) {
	h := newTestHandler(t)
	first := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on the first response")
	}
	// 同一个编码：304。
	second := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": etag})
	if second.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Fatalf("304 response carried %d bytes", second.Body.Len())
	}
	if got := second.Header().Get("ETag"); got != etag {
		t.Fatalf("304 ETag = %q, want %q", got, etag)
	}
	// 换了编码：ETag 必须不同，不能拿 gzip 的表示冒充 identity。
	identity := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "identity"})
	if identity.Header().Get("ETag") == etag {
		t.Fatal("the identity representation reuses the gzip ETag")
	}
	stale := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "identity", "If-None-Match": etag})
	if stale.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 when the ETag belongs to another encoding", stale.Code)
	}
	// brotli 的 ETag 又是另一个。
	br := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "br"})
	if br.Header().Get("ETag") == etag || br.Header().Get("ETag") == identity.Header().Get("ETag") {
		t.Fatal("the brotli representation shares an ETag with another encoding")
	}
}

func TestIfModifiedSinceReturnsNotModified(t *testing.T) {
	h := newTestHandler(t)
	first := get(t, h, "/style.css", map[string]string{"Accept-Encoding": "gzip"})
	lastModified := first.Header().Get("Last-Modified")
	if lastModified == "" {
		t.Fatal("no Last-Modified header")
	}
	second := get(t, h, "/style.css", map[string]string{
		"Accept-Encoding":   "gzip",
		"If-Modified-Since": lastModified,
	})
	if second.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", second.Code)
	}
}

func TestEncodeCacheIsReused(t *testing.T) {
	h := newTestHandler(t)
	for i := 0; i < 3; i++ {
		rec := get(t, h, "/app.js", map[string]string{"Accept-Encoding": "gzip"})
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d", i, rec.Code)
		}
	}
	if got := h.cache.compressions.Load(); got != 1 {
		t.Fatalf("compressions after 3 identical requests = %d, want 1", got)
	}
	// 换一种编码才会有第二次压缩。
	get(t, h, "/app.js", map[string]string{"Accept-Encoding": "br"})
	if got := h.cache.compressions.Load(); got != 2 {
		t.Fatalf("compressions after a brotli request = %d, want 2", got)
	}
	// 另一个资源会再压一次。
	get(t, h, "/style.css", map[string]string{"Accept-Encoding": "gzip"})
	if got := h.cache.compressions.Load(); got != 3 {
		t.Fatalf("compressions after another asset = %d, want 3", got)
	}
}

func TestSpaFallbackServesShell(t *testing.T) {
	h := newTestHandler(t)
	for _, target := range []string{"/settings", "/pages/", "/does-not-exist.js"} {
		rec := get(t, h, target, map[string]string{"Accept-Encoding": "gzip"})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", target, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
			t.Fatalf("%s: Content-Type = %q, want text/html", target, got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s: Cache-Control = %q, want no-cache", target, got)
		}
		if got := decodeGzip(t, rec.Body.Bytes()); !bytes.Equal(got, rawAsset(t, "index.html")) {
			t.Fatalf("%s: shell body differs", target)
		}
	}
}

func TestAPIPathsAreNotServedByTheShell(t *testing.T) {
	h := newTestHandler(t)
	for _, target := range []string{"/api/v1/system/info", "/healthz"} {
		rec := get(t, h, target, nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", target, rec.Code)
		}
	}
}

func TestHeadRequestHasNoBody(t *testing.T) {
	h := newTestHandler(t)
	req := httptest.NewRequest(http.MethodHead, "/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD response carried %d bytes", rec.Body.Len())
	}
	if got := rec.Header().Get("Content-Encoding"); got != encodingGzip {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
}

func TestNegotiateEncoding(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"", encodingIdentity},
		{"gzip", encodingGzip},
		{"br", encodingBrotli},
		{"gzip, br", encodingBrotli},
		{"br, gzip", encodingBrotli},
		{"gzip;q=1, br;q=0.9", encodingGzip},
		{"gzip;q=0", encodingIdentity},
		{"deflate", encodingIdentity},
		{"*", encodingBrotli},
		{"*;q=0", encodingIdentity},
		{"gzip;q=0.5, *;q=0.1", encodingGzip},
	}
	for _, tc := range cases {
		if got := negotiateEncoding(tc.header); got != tc.want {
			t.Fatalf("negotiateEncoding(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

func TestCompressibleType(t *testing.T) {
	compressible := []string{
		"text/html; charset=utf-8",
		"text/css; charset=utf-8",
		"text/javascript; charset=utf-8",
		"application/json; charset=utf-8",
		"application/manifest+json",
		"image/svg+xml",
		"text/plain",
	}
	for _, ct := range compressible {
		if !compressibleType(ct) {
			t.Fatalf("compressibleType(%q) = false, want true", ct)
		}
	}
	skip := []string{
		"image/png", "image/jpeg", "image/webp", "image/x-icon",
		"font/woff", "font/woff2", "application/gzip", "application/zip",
		"application/wasm", "video/mp4", "application/octet-stream",
	}
	for _, ct := range skip {
		if compressibleType(ct) {
			t.Fatalf("compressibleType(%q) = true, want false", ct)
		}
	}
}

// TestEmbeddedAssetsRoundTrip 用真实嵌入资源跑一遍：任何一个前端文件都必须
// 能原样解压回来，否则就是「压缩坏了页面」这种最难查的事故。
func TestEmbeddedAssetsRoundTrip(t *testing.T) {
	handler := Handler()
	sub, err := FS()
	if err != nil {
		t.Fatalf("FS: %v", err)
	}
	names := []string{"index.html", "app.js", "style.css", "pages/waf.js", "pages/dashboard.js", "vendor/shoelace/nunt-shoelace.js"}
	for _, name := range names {
		want, err := fs.ReadFile(sub, name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, encoding := range []string{"gzip", "br"} {
			rec := get(t, handler, "/"+name, map[string]string{"Accept-Encoding": encoding})
			if rec.Code != http.StatusOK {
				t.Fatalf("%s: status = %d", name, rec.Code)
			}
			if got := rec.Header().Get("Content-Encoding"); got != encoding {
				t.Fatalf("%s: Content-Encoding = %q, want %q", name, got, encoding)
			}
			var got []byte
			if encoding == "gzip" {
				got = decodeGzip(t, rec.Body.Bytes())
			} else {
				got = decodeBrotli(t, rec.Body.Bytes())
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("%s (%s): round trip mismatch", name, encoding)
			}
			if len(rec.Body.Bytes()) >= len(want) {
				t.Fatalf("%s (%s): compressed size %d is not smaller than %d", name, encoding, rec.Body.Len(), len(want))
			}
		}
	}
}
