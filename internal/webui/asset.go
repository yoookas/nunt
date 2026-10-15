package webui

import (
	"bytes"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

// assetHandler 提供后台前端：命中嵌入资源就返回它（文本资源按 Accept-Encoding
// 预压缩），没命中就当客户端路由，回退到 index.html。
type assetHandler struct {
	fsys  fs.FS
	cache *encodeCache
	// modTime 是所有资源的「修改时间」。
	//
	// embed.FS 不保存时间戳（ModTime 是零值），而条件请求需要它：同一个进程
	// 生命周期内嵌入资源不会变，所以用进程启动时间当修改时间既安全（重启后
	// 一定比客户端手上的时间新，返回完整内容）又能让 If-Modified-Since 生效。
	modTime time.Time
}

func newAssetHandler(fsys fs.FS) *assetHandler {
	return &assetHandler{fsys: fsys, cache: newEncodeCache(), modTime: time.Now()}
}

func (h *assetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if strings.HasPrefix(p, "api/") || strings.HasPrefix(p, "healthz") {
		http.NotFound(w, r)
		return
	}
	info, err := fs.Stat(h.fsys, p)
	if err != nil || info.IsDir() {
		// 客户端路由（或目录请求）：返回外壳。目录不再列目录，前端是 SPA，
		// 目录清单没有任何入口指向它。
		h.serveAsset(w, r, "index.html", true)
		return
	}
	h.serveAsset(w, r, p, false)
}

// serveAsset 写出一个嵌入资源。shell 表示这是 SPA 外壳（index.html）。
func (h *assetHandler) serveAsset(w http.ResponseWriter, r *http.Request, name string, shell bool) {
	data, err := fs.ReadFile(h.fsys, name)
	if err != nil {
		http.Error(w, "admin interface is unavailable", http.StatusInternalServerError)
		return
	}
	contentType := contentTypeFor(name, data)
	w.Header().Set("Content-Type", contentType)
	if shell || strings.HasSuffix(strings.ToLower(name), ".html") {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=600")
	}

	if !compressibleType(contentType) {
		w.Header().Set("ETag", h.cache.identityETag(name, data))
		http.ServeContent(w, r, name, h.modTime, bytes.NewReader(data))
		return
	}

	// 同一个 URL 会按 Accept-Encoding 返回不同的表示，缓存必须知道这一点。
	w.Header().Add("Vary", "Accept-Encoding")

	encoding := negotiateEncoding(r.Header.Get("Accept-Encoding"))
	if encoding == encodingIdentity {
		w.Header().Set("ETag", h.cache.identityETag(name, data))
		http.ServeContent(w, r, name, h.modTime, bytes.NewReader(data))
		return
	}
	asset, err := h.cache.encoded(name, encoding, data)
	if err != nil {
		// 压缩失败不该让页面打不开：退回未压缩表示。
		w.Header().Set("ETag", h.cache.identityETag(name, data))
		http.ServeContent(w, r, name, h.modTime, bytes.NewReader(data))
		return
	}
	w.Header().Set("Content-Encoding", encoding)
	w.Header().Set("ETag", asset.etag)
	// net/http 只在没有 Content-Encoding 时才自己写 Content-Length（它无法
	// 假设调用方压缩后的长度）。这里长度是已知的，直接给出来，浏览器才有进度
	// 可显示、中间代理也不用猜。Range 请求交给 ServeContent 处理，它会按区间重写。
	if r.Header.Get("Range") == "" {
		w.Header().Set("Content-Length", strconv.Itoa(len(asset.body)))
	}
	http.ServeContent(w, r, name, h.modTime, bytes.NewReader(asset.body))
}

// assetContentTypes 是嵌入资源的扩展名到 Content-Type 的显式映射。
//
// 为什么不直接用 mime.TypeByExtension：它在 Windows 上会先读注册表，同一个
// .js 在不同机器上可能拿到 text/plain 之类的结果，而 <script type="module">
// 会因为 MIME 不对被浏览器直接拒绝。嵌入资源是固定的一小撮类型，写死更可预期。
var assetContentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".map":         "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".txt":         "text/plain; charset=utf-8",
	".ico":         "image/x-icon",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".avif":        "image/avif",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".gz":          "application/gzip",
	".br":          "application/brotli",
	".zip":         "application/zip",
	".wasm":        "application/wasm",
}

// incompressibleTypes 是「已经是压缩格式，再压一次没有意义」的媒体类型。
var incompressibleTypes = map[string]bool{
	"image/png":          true,
	"image/jpeg":         true,
	"image/gif":          true,
	"image/webp":         true,
	"image/avif":         true,
	"image/x-icon":       true,
	"font/woff":          true,
	"font/woff2":         true,
	"font/ttf":           true,
	"font/otf":           true,
	"application/gzip":   true,
	"application/zip":    true,
	"application/brotli": true,
	"application/wasm":   true,
	"application/pdf":    true,
	"video/mp4":          true,
	"audio/mpeg":         true,
}

// compressibleType 判断一个 Content-Type 是不是文本类、值得压缩。
//
// 先看「已压缩格式」黑名单，再看文本白名单：text/* 全部、JSON、XML、JS、
// SVG。二进制（图片里只有未压缩的位图）与压缩格式一律跳过。
func compressibleType(contentType string) bool {
	media, _, _ := strings.Cut(contentType, ";")
	media = strings.ToLower(strings.TrimSpace(media))
	if incompressibleTypes[media] {
		return false
	}
	if strings.HasPrefix(media, "text/") {
		return true
	}
	switch media {
	case "application/json",
		"application/manifest+json",
		"application/javascript",
		"application/xml",
		"application/xhtml+xml",
		"image/svg+xml":
		return true
	}
	return false
}

// contentTypeFor 决定一个资源的 Content-Type。
func contentTypeFor(name string, data []byte) string {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := assetContentTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return http.DetectContentType(data)
}
