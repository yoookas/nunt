package web

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/vfs"
)

// defaultIndexFiles is used when a static rule does not list index files.
var defaultIndexFiles = []string{"index.html", "index.htm"}

// defaultCacheSeconds applies to static assets when the rule does not set a
// cache lifetime.
const defaultCacheSeconds = 3600

// siteFingerprint identifies a rule definition. Two rules with the same
// fingerprint may share their handler, which matters for the modules that open
// their storage inside Site: an unchanged rule is never rebuilt.
func siteFingerprint(r *model.WebRule) string {
	data, err := json.Marshal(r)
	if err != nil {
		// A rule that cannot be encoded is always treated as changed.
		return fmt.Sprintf("unencodable:%v", time.Now().UnixNano())
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

// reuseSite attaches the cached handler of an identical rule definition.
func (w *Web) reuseSite(r *rule) {
	if r.site != nil {
		return
	}
	cached, ok := w.siteCache[r.id]
	if !ok || cached.key != r.siteKey {
		return
	}
	r.site = cached.site
}

// storeSite remembers the handler of a rule for the next reconfiguration.
func (w *Web) storeSite(r *rule) {
	if r.site == nil {
		return
	}
	w.siteCache[r.id] = cachedSite{key: r.siteKey, site: r.site}
}

// forgetSites drops the cached handlers of rules that are gone and returns
// them so the caller can release them outside the lock.
func (w *Web) forgetSites(keep map[string]bool) []*webSite {
	var dropped []*webSite
	for id, cached := range w.siteCache {
		if keep[id] {
			continue
		}
		dropped = append(dropped, cached.site)
		delete(w.siteCache, id)
	}
	return dropped
}

// cachedSite is one entry of the handler cache.
type cachedSite struct {
	key  string
	site *webSite
}

// webSite bundles the handler of a rule with the resources that have to be
// released when the service stops. The storage of a static rule stays open
// after the rule is replaced because a request that is already running may
// still read from it.
type webSite struct {
	handler   http.Handler
	upstreams []string
	// static holds the lazily opened file system of a static rule.
	static *staticFS
}

// close releases the resources of a site.
func (s *webSite) close() {
	if s == nil || s.static == nil {
		return
	}
	s.static.close()
}

// buildSite creates the business handler of a rule.
func (w *Web) buildSite(r *rule, cfg *model.Config) (*webSite, error) {
	switch r.spec.Type {
	case model.WebTypeProxy:
		return w.proxySite(r, cfg)
	case model.WebTypeRedirect:
		return w.redirectSite(r)
	case model.WebTypeStatic:
		return w.staticSite(r)
	default:
		return nil, fmt.Errorf("rule %q: unsupported type %q", r.name, r.spec.Type)
	}
}

// ---------------------------------------------------------------------------
// redirect
// ---------------------------------------------------------------------------

func (w *Web) redirectSite(r *rule) (*webSite, error) {
	target := strings.TrimSpace(r.spec.Redirect.To)
	if target == "" {
		return nil, fmt.Errorf("rule %q: redirect target is required", r.name)
	}
	status := r.spec.Redirect.Status
	switch status {
	case 0:
		status = http.StatusFound
	case 301, 302, 307, 308:
	default:
		return nil, fmt.Errorf("rule %q: unsupported redirect status %d", r.name, status)
	}
	if strings.ContainsAny(target, "\r\n") {
		return nil, fmt.Errorf("rule %q: redirect target must not contain line breaks", r.name)
	}
	keepPath := r.spec.Redirect.KeepPath
	handler := http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		location := expandRedirect(target, req)
		if keepPath {
			location = joinURLPath(location, req.URL.EscapedPath())
			if req.URL.RawQuery != "" {
				if strings.Contains(location, "?") {
					location += "&" + req.URL.RawQuery
				} else {
					location += "?" + req.URL.RawQuery
				}
			}
		}
		if !safeRedirect(location) {
			http.Error(rw, "invalid redirect target", http.StatusInternalServerError)
			return
		}
		http.Redirect(rw, req, location, status)
	})
	return &webSite{handler: handler}, nil
}

// expandRedirect substitutes the documented variables of a redirect target.
func expandRedirect(target string, req *http.Request) string {
	replacer := strings.NewReplacer(
		"$path", req.URL.Path,
		"$uri", req.URL.RequestURI(),
		"$query", req.URL.RawQuery,
		"$host", req.Host,
	)
	return replacer.Replace(target)
}

// safeRedirect rejects targets that could be abused for header injection or
// script execution.
func safeRedirect(location string) bool {
	location = strings.TrimSpace(location)
	if location == "" || strings.ContainsAny(location, "\r\n\x00") {
		return false
	}
	lower := strings.ToLower(location)
	for _, bad := range []string{"javascript:", "data:", "vbscript:"} {
		if strings.HasPrefix(lower, bad) {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

// staticFS lazily opens the file system of a static rule. Opening is deferred
// to the first request so that a broken rule only affects its own traffic and
// never blocks a listener rebuild.
type staticFS struct {
	once     sync.Once
	fs       vfs.FS
	err      error
	label    string
	readOnly bool
	open     func() (vfs.FS, func(), error)
	release  func()
}

func (s *staticFS) get() (vfs.FS, error) {
	s.once.Do(func() {
		if s.open == nil {
			s.err = fmt.Errorf("storage %q is not configured", s.label)
			return
		}
		s.fs, s.release, s.err = s.open()
		if s.err != nil {
			s.err = fmt.Errorf("open storage %q: %w", s.label, s.err)
		}
	})
	return s.fs, s.err
}

// close releases the file system when it was opened.
func (s *staticFS) close() {
	if s == nil {
		return
	}
	if s.release != nil {
		s.release()
		s.release = nil
	}
}

func (w *Web) staticSite(r *rule) (*webSite, error) {
	target := r.spec.Static
	if target == nil {
		return nil, fmt.Errorf("rule %q: static settings are required", r.name)
	}
	root := strings.TrimSpace(target.Root)
	if root == "" {
		return nil, fmt.Errorf("rule %q: a root directory is required", r.name)
	}
	store := &staticFS{label: root}
	store.open = func() (vfs.FS, func(), error) {
		fsys, err := vfs.OpenLocal(root, r.name, true)
		if err != nil {
			return nil, nil, err
		}
		return fsys, func() { _ = fsys.Close() }, nil
	}

	index := target.Index
	if len(index) == 0 {
		index = defaultIndexFiles
	}
	cacheSeconds := target.CacheSeconds
	if cacheSeconds < 0 {
		cacheSeconds = 0
	}
	handler := http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		w.serveStatic(r, store, target, index, cacheSeconds, rw, req)
	})
	return &webSite{handler: handler, static: store}, nil
}

func (w *Web) serveStatic(r *rule, store *staticFS, target *model.StaticTgt, index []string, cacheSeconds int, rw http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		rw.Header().Set("Allow", "GET, HEAD")
		http.Error(rw, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	fsys, err := store.get()
	if err != nil {
		w.logger().Error("web: static storage unavailable", "rule", r.name, "error", err)
		http.Error(rw, "storage unavailable", http.StatusInternalServerError)
		return
	}

	upstream, err := vfs.Clean(req.URL.Path)
	if err != nil {
		http.Error(rw, "invalid path", http.StatusBadRequest)
		return
	}
	if hiddenPath(upstream) {
		http.NotFound(rw, req)
		return
	}

	entry, err := fsys.Stat(req.Context(), upstream)
	if err != nil {
		// Try the index files for directory style paths such as "/docs".
		if serveIndex(w, r, fsys, index, cacheSeconds, rw, req, upstream) {
			return
		}
		// A single page application answers unknown routes with its entry
		// document, but never for asset like requests.
		if target.SPA && spaCandidate(upstream) && serveIndex(w, r, fsys, index, cacheSeconds, rw, req, "/") {
			return
		}
		notFound(w, rw, req, upstream, err)
		return
	}
	if entry.Dir {
		if !strings.HasSuffix(req.URL.Path, "/") {
			redirectDir(rw, req)
			return
		}
		if serveIndex(w, r, fsys, index, cacheSeconds, rw, req, upstream) {
			return
		}
		if target.Listing {
			if err := w.serveListing(r, fsys, rw, req, upstream); err != nil {
				w.logger().Warn("web: cannot list directory", "rule", r.name, "path", upstream, "error", err)
				http.Error(rw, "cannot list directory", http.StatusInternalServerError)
			}
			return
		}
		http.Error(rw, "directory listing is disabled", http.StatusForbidden)
		return
	}
	w.serveFile(r, fsys, store.label, cacheSeconds, rw, req, upstream)
}

// serveIndex serves the first existing index file of a directory and reports
// whether a response was written.
func serveIndex(w *Web, r *rule, fsys vfs.FS, index []string, cacheSeconds int, rw http.ResponseWriter, req *http.Request, dir string) bool {
	for _, name := range index {
		name = strings.TrimSpace(name)
		if name == "" || strings.ContainsAny(name, "/\\") {
			continue
		}
		p := path.Join(dir, name)
		entry, err := fsys.Stat(req.Context(), p)
		if err != nil || entry.Dir {
			continue
		}
		w.serveFile(r, fsys, fsys.Name(), cacheSeconds, rw, req, p)
		return true
	}
	return false
}

func notFound(w *Web, rw http.ResponseWriter, req *http.Request, p string, err error) {
	if isNotExist(err) {
		http.NotFound(rw, req)
		return
	}
	w.logger().Warn("web: cannot open static path", "path", p, "error", err)
	http.Error(rw, "cannot read file", http.StatusInternalServerError)
}

func isNotExist(err error) bool {
	return errors.Is(err, vfs.ErrNotExist) || errors.Is(err, vfs.ErrInvalidPath)
}

// redirectDir sends the canonical redirect for a directory without a trailing
// slash so that relative links keep working.
func redirectDir(rw http.ResponseWriter, req *http.Request) {
	target := req.URL.Path + "/"
	if req.URL.RawQuery != "" {
		target += "?" + req.URL.RawQuery
	}
	http.Redirect(rw, req, target, http.StatusMovedPermanently)
}

// serveListing renders a minimal directory index.
func (w *Web) serveListing(r *rule, fsys vfs.FS, rw http.ResponseWriter, req *http.Request, dir string) error {
	entries, err := fsys.List(req.Context(), dir, false)
	if err != nil {
		return err
	}
	// Distinguish files from directories for the trailing slash of the links.
	cleaned, _ := vfs.Clean(dir)
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
	b.WriteString("<title>Index of " + html.EscapeString(cleaned) + "</title>")
	b.WriteString("<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.6}")
	b.WriteString("table{border-collapse:collapse;width:100%}td,th{padding:.25rem .5rem;text-align:left;border-bottom:1px solid #ddd}")
	b.WriteString("td.size{text-align:right;white-space:nowrap}</style></head><body>")
	b.WriteString("<h1>Index of " + html.EscapeString(cleaned) + "</h1><table><thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody>")
	if cleaned != "/" {
		b.WriteString("<tr><td><a href=\"../\">../</a></td><td class=\"size\"></td><td></td></tr>")
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	for _, e := range entries {
		name := e.Name
		link := url.PathEscape(name)
		size := ""
		if e.Dir {
			name += "/"
			link += "/"
		} else {
			size = humanSize(e.Size)
		}
		b.WriteString("<tr><td><a href=\"" + link + "\">" + html.EscapeString(name) + "</a></td><td class=\"size\">" +
			size + "</td><td>" + e.ModTime.Format("2006-01-02 15:04") + "</td></tr>")
	}
	b.WriteString("</tbody></table></body></html>\n")

	rw.Header().Set("Content-Type", "text/html; charset=utf-8")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("X-Content-Type-Options", "nosniff")
	if req.Method == http.MethodHead {
		rw.Header().Set("Content-Length", fmt.Sprint(b.Len()))
		rw.WriteHeader(http.StatusOK)
		return nil
	}
	_, _ = io.WriteString(rw, b.String())
	return nil
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value := float64(n)
	units := []string{"KB", "MB", "GB", "TB", "PB"}
	i := -1
	for value >= unit && i < len(units)-1 {
		value /= unit
		i++
	}
	return fmt.Sprintf("%.1f %s", value, units[i])
}

// serveFile writes one file honouring conditional and range requests.
func (w *Web) serveFile(r *rule, fsys vfs.FS, label string, cacheSeconds int, rw http.ResponseWriter, req *http.Request, p string) {
	entry, err := fsys.Stat(req.Context(), p)
	if err != nil {
		notFound(w, rw, req, p, err)
		return
	}
	rw.Header().Set("Content-Type", contentTypeOf(p))
	if cacheSeconds > 0 {
		rw.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", cacheSeconds))
	} else {
		rw.Header().Set("Cache-Control", "no-cache")
	}
	rw.Header().Set("X-Content-Type-Options", "nosniff")
	rw.Header().Set("Last-Modified", entry.ModTime.UTC().Format(http.TimeFormat))
	etag := fmt.Sprintf("\"%x-%x\"", entry.ModTime.UnixNano(), entry.Size)
	rw.Header().Set("ETag", etag)

	if match := req.Header.Get("If-None-Match"); match != "" && etagMatch(match, etag) {
		rw.WriteHeader(http.StatusNotModified)
		return
	}
	if since := req.Header.Get("If-Modified-Since"); since != "" && req.Header.Get("If-None-Match") == "" {
		if t, perr := http.ParseTime(since); perr == nil && !entry.ModTime.Truncate(time.Second).After(t) {
			rw.WriteHeader(http.StatusNotModified)
			return
		}
	}

	start, length, partial, err := parseRange(req.Header.Get("Range"), entry.Size)
	if err != nil {
		switch err {
		case errRangeNotSatisfiable:
			rw.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", entry.Size))
			http.Error(rw, "requested range not satisfiable", http.StatusRequestedRangeNotSatisfiable)
		default:
			http.Error(rw, "invalid range header", http.StatusBadRequest)
		}
		return
	}

	reader, _, err := fsys.Open(req.Context(), p, start, length)
	if err != nil {
		notFound(w, rw, req, p, err)
		return
	}
	defer func() { _ = reader.Close() }()

	if partial {
		rw.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, entry.Size))
		rw.Header().Set("Content-Length", fmt.Sprint(length))
		rw.WriteHeader(http.StatusPartialContent)
	} else {
		rw.Header().Set("Content-Length", fmt.Sprint(entry.Size))
	}
	if req.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(rw, reader); err != nil {
		w.logger().Debug("web: static transfer interrupted", "rule", r.name, "storage", label, "path", p, "error", err)
	}
}

// etagMatch implements the weak comparison of an If-None-Match header.
func etagMatch(header, etag string) bool {
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		part = strings.TrimPrefix(part, "W/")
		if part == etag {
			return true
		}
	}
	return false
}

// contentTypeOf guesses a mime type from the file extension.
func contentTypeOf(p string) string {
	ext := strings.ToLower(path.Ext(p))
	// Small corrections for types the system table often gets wrong.
	switch ext {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".txt", ".md":
		return "text/plain; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json"
	case ".wasm":
		return "application/wasm"
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}
