package filebrowser

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/vfs"
)

const (
	// apiPrefix is the JSON API below the rule path.
	apiPrefix = "/_api"
	// sharePrefix serves the public share links.
	sharePrefix = "/_share"

	defaultPageSize = 200
	maxPageSize     = 2000
	maxZipEntries   = 5000
	maxZipFileSize  = 2 << 30
)

// perms mirrors the write permissions of a rule.
type perms struct {
	Upload bool `json:"upload"`
	Delete bool `json:"delete"`
	Mkdir  bool `json:"mkdir"`
	Rename bool `json:"rename"`
	Share  bool `json:"share"`
}

// site serves one filebrowser rule.
type site struct {
	deps       *module.Deps
	rule       *model.WebRule
	fs         vfs.FS
	prefix     string
	title      string
	readOnly   bool
	can        perms
	showHidden bool
	shares     *shareStore
	log        *slog.Logger
	// release closes the storage handle this site owns. The web module calls
	// Close once the rule is replaced and the in flight requests are done.
	release func()
}

// Close releases the storage handle owned by the site.
func (s *site) Close() error {
	if s != nil && s.release != nil {
		s.release()
		s.release = nil
	}
	return nil
}

func newSite(deps *module.Deps, rule *model.WebRule) (*site, error) {
	fsys, readOnly, label, release, err := openTarget(deps, rule)
	if err != nil {
		return nil, err
	}
	files := rule.Files
	title := strings.TrimSpace(files.Title)
	if title == "" {
		title = strings.TrimSpace(rule.Name)
	}
	if title == "" {
		title = label
	}
	s := &site{
		deps:       deps,
		release:    release,
		rule:       rule,
		fs:         fsys,
		prefix:     model.NormalizePath(rule.Path),
		title:      title,
		readOnly:   readOnly,
		showHidden: files.ShowHidden,
		log:        deps.Logger("filebrowser"),
	}
	s.can = perms{
		Upload: !readOnly && files.AllowUpload,
		Delete: !readOnly && files.AllowDelete,
		Mkdir:  !readOnly && files.AllowMkdir,
		Rename: !readOnly && files.AllowRename,
		Share:  files.ShareLinks,
	}
	if deps != nil {
		s.shares = storeFor(deps.DataDir, rule.ID)
	}
	s.log.Info("file browser site ready", "rule", rule.ID, "path", s.prefix, "storage", label, "readOnly", readOnly)
	return s, nil
}

// ServeHTTP implements http.Handler.
func (s *site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")

	rel := relativePath(r.URL.Path, s.prefix)
	switch {
	case rel == apiPrefix || strings.HasPrefix(rel, apiPrefix+"/"):
		s.handleAPI(w, r, strings.TrimPrefix(rel, apiPrefix))
	case rel == sharePrefix || strings.HasPrefix(rel, sharePrefix+"/"):
		s.handleShare(w, r, strings.TrimPrefix(rel, sharePrefix))
	case r.Method == http.MethodGet, r.Method == http.MethodHead:
		s.handlePage(w, r)
	default:
		w.Header().Set("Allow", "GET, HEAD")
		rest.Fail(w, http.StatusMethodNotAllowed, "不支持该请求方法")
	}
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

// sitePath builds a path below the rule prefix.
func (s *site) sitePath(parts ...string) string {
	out := strings.TrimSuffix(s.prefix, "/")
	for _, p := range parts {
		out += "/" + strings.Trim(p, "/")
	}
	if out == "" {
		out = "/"
	}
	return out
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

type pageConfig struct {
	Mode            string `json:"mode"`
	API             string `json:"api"`
	Title           string `json:"title"`
	Root            string `json:"root"`
	Start           string `json:"start"`
	ReadOnly        bool   `json:"readOnly"`
	Can             perms  `json:"can"`
	Share           bool   `json:"shareEnabled"`
	ShareTTLMinutes int    `json:"shareTtlMinutes"`
	ShowHidden      bool   `json:"showHidden"`
	Download        bool   `json:"download"`
}

func (s *site) handlePage(w http.ResponseWriter, r *http.Request) {
	start := strings.TrimSpace(r.URL.Query().Get("path"))
	if start == "" {
		start = "/"
	}
	if clean, err := vfs.Clean(start); err == nil {
		start = clean
	} else {
		start = "/"
	}
	s.renderPage(w, pageConfig{
		Mode:            "browse",
		API:             s.sitePath(apiPrefix),
		Title:           s.title,
		Root:            "/",
		Start:           start,
		ReadOnly:        s.readOnly,
		Can:             s.can,
		Share:           s.can.Share,
		ShareTTLMinutes: shareTTLMinutes(s.rule.Files),
		ShowHidden:      s.showHidden,
		Download:        true,
	})
}

func (s *site) renderPage(w http.ResponseWriter, cfg pageConfig) {
	payload, err := json.Marshal(cfg)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法渲染页面")
		return
	}
	body := strings.Replace(pageHTML, pageConfigPlaceholder, string(payload), 1)
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, body); err != nil && s.log != nil {
		s.log.Debug("write page", "error", err)
	}
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

func (s *site) handleAPI(w http.ResponseWriter, r *http.Request, name string) {
	name = strings.Trim(name, "/")
	switch name {
	case "info":
		s.requireMethod(w, r, http.MethodGet, s.handleInfo)
	case "list":
		s.requireMethod(w, r, http.MethodGet, s.handleList)
	case "download":
		s.requireMethod(w, r, http.MethodGet, s.handleDownload)
	case "zip":
		s.requireMethod(w, r, http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			clean, ok := s.pathParam(w, r, "")
			if !ok {
				return
			}
			s.handleZip(w, r, clean)
		})
	case "upload":
		s.requireMethod(w, r, http.MethodPost, s.handleUpload)
	case "mkdir":
		s.requireMethod(w, r, http.MethodPost, s.handleMkdir)
	case "rename":
		s.requireMethod(w, r, http.MethodPost, s.handleRename)
	case "delete":
		s.requireMethod(w, r, http.MethodPost, s.handleDelete)
	case "share":
		s.requireMethod(w, r, http.MethodPost, s.handleShareCreate)
	case "shares":
		switch r.Method {
		case http.MethodGet:
			s.handleShareList(w, r)
		case http.MethodDelete:
			s.handleShareDelete(w, r)
		default:
			s.methodNotAllowed(w, "GET, DELETE")
		}
	default:
		rest.Fail(w, http.StatusNotFound, "接口不存在")
	}
}

func (s *site) requireMethod(w http.ResponseWriter, r *http.Request, method string, next http.HandlerFunc) {
	if r.Method != method {
		s.methodNotAllowed(w, method)
		return
	}
	next(w, r)
}

func (s *site) methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	rest.Fail(w, http.StatusMethodNotAllowed, "不支持该请求方法")
}

// handleInfo reports the capabilities of the site.
func (s *site) handleInfo(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, map[string]any{
		"title":      s.title,
		"path":       s.prefix,
		"readOnly":   s.readOnly,
		"can":        s.can,
		"showHidden": s.showHidden,
		"storage":    s.fs.Name(),
	})
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

type entryDTO struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Kind    string    `json:"kind"`
}

type listResponse struct {
	Path     string     `json:"path"`
	Name     string     `json:"name"`
	Parent   string     `json:"parent"`
	ReadOnly bool       `json:"readOnly"`
	Can      perms      `json:"can"`
	Entries  []entryDTO `json:"entries"`
	Total    int        `json:"total"`
	Page     int        `json:"page"`
	PageSize int        `json:"pageSize"`
	Pages    int        `json:"pages"`
	Query    string     `json:"query,omitempty"`
	Sort     string     `json:"sort"`
	Order    string     `json:"order"`
}

func (s *site) handleList(w http.ResponseWriter, r *http.Request) {
	clean, ok := s.pathParam(w, r, "/")
	if !ok {
		return
	}
	s.listPath(w, r, clean)
}

// listPath renders one directory; it is shared by the browse and share views.
func (s *site) listPath(w http.ResponseWriter, r *http.Request, clean string) {
	query := r.URL.Query()
	entries, err := s.fs.List(r.Context(), clean, s.showHidden)
	if err != nil {
		s.fail(w, "list", err)
		return
	}
	q := strings.ToLower(strings.TrimSpace(query.Get("q")))
	if q != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.Name), q) {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	sortKey := query.Get("sort")
	order := query.Get("order")
	sortEntries(entries, sortKey, order)

	page, _ := strconv.Atoi(query.Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(query.Get("size"))
	if size <= 0 {
		size = defaultPageSize
	}
	if size > maxPageSize {
		size = maxPageSize
	}
	total := len(entries)
	pages := (total + size - 1) / size
	if pages == 0 {
		pages = 1
	}
	if page > pages {
		page = pages
	}
	startIdx := (page - 1) * size
	endIdx := startIdx + size
	if startIdx > total {
		startIdx = total
	}
	if endIdx > total {
		endIdx = total
	}

	out := make([]entryDTO, 0, endIdx-startIdx)
	for _, e := range entries[startIdx:endIdx] {
		out = append(out, toDTO(e))
	}
	name := path.Base(clean)
	if clean == "/" {
		name = s.title
	}
	parent := path.Dir(clean)
	if clean == "/" {
		parent = "/"
	}
	rest.OK(w, listResponse{
		Path:     clean,
		Name:     name,
		Parent:   parent,
		ReadOnly: s.readOnly,
		Can:      s.can,
		Entries:  out,
		Total:    total,
		Page:     page,
		PageSize: size,
		Pages:    pages,
		Query:    q,
		Sort:     sortKey,
		Order:    order,
	})
}

func toDTO(e vfs.Entry) entryDTO {
	return entryDTO{
		Name:    e.Name,
		Path:    e.Path,
		Dir:     e.Dir,
		Size:    e.Size,
		ModTime: e.ModTime,
		Kind:    kindOf(e),
	}
}

func kindOf(e vfs.Entry) string {
	if e.Dir {
		return "dir"
	}
	ext := strings.ToLower(path.Ext(e.Name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tif", ".tiff":
		return "image"
	case ".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".wmv", ".m4v", ".rmvb":
		return "video"
	case ".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".ape":
		return "audio"
	case ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".zst", ".tgz":
		return "archive"
	case ".pdf":
		return "pdf"
	case ".go", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".php", ".java", ".c", ".h",
		".cpp", ".hpp", ".cs", ".rs", ".sh", ".ps1", ".bat", ".sql", ".html", ".htm", ".css",
		".scss", ".json", ".yaml", ".yml", ".toml", ".ini", ".xml", ".md":
		return "code"
	case ".txt", ".log", ".csv", ".conf", ".env", ".properties":
		return "text"
	case ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp":
		return "doc"
	default:
		return "file"
	}
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

func (s *site) handleDownload(w http.ResponseWriter, r *http.Request) {
	clean, ok := s.pathParam(w, r, "")
	if !ok {
		return
	}
	s.download(w, r, clean, false)
}

// download streams a file honouring a single byte range.
func (s *site) download(w http.ResponseWriter, r *http.Request, clean string, forceAttachment bool) {
	entry, err := s.fs.Stat(r.Context(), clean)
	if err != nil {
		s.fail(w, "stat", err)
		return
	}
	if entry.Dir {
		rest.Fail(w, http.StatusBadRequest, "不能直接下载目录，请使用 zip 打包")
		return
	}
	inline := !forceAttachment && r.URL.Query().Get("inline") == "1" && inlineSafe(entry.Name)
	start, length, partial, err := parseRange(r.Header.Get("Range"), entry.Size)
	if err != nil {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(entry.Size, 10))
		rest.Fail(w, http.StatusRequestedRangeNotSatisfiable, "请求的字节范围无效")
		return
	}
	rc, entry, err := s.fs.Open(r.Context(), clean, start, length)
	if err != nil {
		s.fail(w, "open", err)
		return
	}
	defer func() { _ = rc.Close() }()

	h := w.Header()
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Type", contentTypeOf(entry.Name))
	h.Set("Content-Disposition", contentDisposition(entry.Name, inline))
	h.Set("Last-Modified", entry.ModTime.UTC().Format(http.TimeFormat))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, entry.Size))
		h.Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		h.Set("Content-Length", strconv.FormatInt(entry.Size, 10))
		w.WriteHeader(http.StatusOK)
	}
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, rc); err != nil && s.log != nil {
		s.log.Debug("download aborted", "path", clean, "error", err)
	}
}

// parseRange understands a single "bytes=a-b" range. Multiple ranges are
// deliberately ignored: the whole file is sent instead.
func parseRange(header string, size int64) (start, length int64, partial bool, err error) {
	header = strings.TrimSpace(header)
	if header == "" || !strings.HasPrefix(strings.ToLower(header), "bytes=") {
		return 0, 0, false, nil
	}
	spec := strings.TrimSpace(header[len("bytes="):])
	if strings.ContainsRune(spec, ',') {
		return 0, 0, false, nil
	}
	dash := strings.IndexByte(spec, '-')
	if dash < 0 {
		return 0, 0, false, errors.New("invalid range")
	}
	first, last := strings.TrimSpace(spec[:dash]), strings.TrimSpace(spec[dash+1:])
	switch {
	case first == "" && last == "":
		return 0, 0, false, errors.New("invalid range")
	case first == "":
		n, convErr := strconv.ParseInt(last, 10, 64)
		if convErr != nil || n <= 0 {
			return 0, 0, false, errors.New("invalid range")
		}
		if n > size {
			n = size
		}
		return size - n, n, true, nil
	default:
		from, convErr := strconv.ParseInt(first, 10, 64)
		if convErr != nil || from < 0 {
			return 0, 0, false, errors.New("invalid range")
		}
		if from >= size {
			return 0, 0, false, errors.New("range starts past the end of the file")
		}
		to := size - 1
		if last != "" {
			parsedTo, convErr := strconv.ParseInt(last, 10, 64)
			if convErr != nil || parsedTo < from {
				return 0, 0, false, errors.New("invalid range")
			}
			if parsedTo < to {
				to = parsedTo
			}
		}
		return from, to - from + 1, true, nil
	}
}

// contentTypeOf guesses the type from the extension only.
func contentTypeOf(name string) string {
	if ct := mime.TypeByExtension(strings.ToLower(path.Ext(name))); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// inlineSafe reports whether a file may be rendered by the browser. Active
// content is always downloaded to keep stored XSS out of the site origin.
func inlineSafe(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm", ".xhtml", ".shtml", ".svg", ".svgz", ".xml", ".xsl", ".xslt",
		".js", ".mjs", ".cjs", ".css", ".swf", ".hta", ".jar", ".mht", ".mhtml", ".vbs":
		return false
	default:
		return true
	}
}

// contentDisposition builds an attachment/inline header with an RFC 5987
// filename* for non ASCII names.
func contentDisposition(name string, inline bool) string {
	kind := "attachment"
	if inline {
		kind = "inline"
	}
	return fmt.Sprintf("%s; filename=%q; filename*=UTF-8''%s", kind, asciiFallback(name), url.PathEscape(name))
}

func asciiFallback(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r > 0x7e || r == '"' || r == '\\':
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "download"
	}
	return out
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

// handleZip streams a zip archive of clean. The caller owns the path: the API
// derives it from the query, while a share link passes the path it already
// checked against the share root. Re-reading the query here would let a share
// link archive the whole storage root by omitting the parameter.
// maxZipTotalBytes bounds the uncompressed size of one archive; a variable so
// tests can lower it. maxZipConcurrent bounds how many archives are built at
// once, because every one of them holds a CPU and a storage reader.
const maxZipConcurrent = 2

var (
	maxZipTotalBytes int64 = 4 << 30
	zipSlots               = make(chan struct{}, maxZipConcurrent)
)

func (s *site) handleZip(w http.ResponseWriter, r *http.Request, clean string) {
	select {
	case zipSlots <- struct{}{}:
		defer func() { <-zipSlots }()
	case <-r.Context().Done():
		return
	}
	entry, err := s.fs.Stat(r.Context(), clean)
	if err != nil {
		s.fail(w, "stat", err)
		return
	}
	if !entry.Dir {
		s.download(w, r, clean, true)
		return
	}
	archiveName := entry.Name + ".zip"
	if clean == "/" {
		archiveName = "archive.zip"
	}
	h := w.Header()
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Disposition", contentDisposition(archiveName, false))
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	count := 0
	total := int64(0)
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		items, err := s.fs.List(r.Context(), dir, s.showHidden)
		if err != nil {
			return err
		}
		for _, item := range items {
			if count >= maxZipEntries || total >= maxZipTotalBytes || r.Context().Err() != nil {
				return nil
			}
			name := path.Join(prefix, item.Name)
			if item.Dir {
				if _, err := zw.Create(name + "/"); err != nil {
					return err
				}
				if err := walk(item.Path, name); err != nil {
					return err
				}
				continue
			}
			if item.Size > maxZipFileSize {
				continue
			}
			if item.Size > 0 && total+item.Size > maxZipTotalBytes {
				// The caller asked for a bounded archive: stop instead of
				// streaming an unbounded amount of data.
				return nil
			}
			total += item.Size
			header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: item.ModTime}
			fw, err := zw.CreateHeader(header)
			if err != nil {
				return err
			}
			rc, _, err := s.fs.Open(r.Context(), item.Path, 0, 0)
			if err != nil {
				continue
			}
			_, copyErr := io.Copy(fw, rc)
			_ = rc.Close()
			if copyErr != nil {
				return copyErr
			}
			count++
		}
		return nil
	}
	// The status line is already on the wire, so a failure can only be logged.
	if err := walk(clean, ""); err != nil && s.log != nil {
		s.log.Warn("zip archive incomplete", "path", clean, "error", err)
	}
	if err := zw.Close(); err != nil && s.log != nil {
		s.log.Warn("zip archive close", "path", clean, "error", err)
	}
}

// ---------------------------------------------------------------------------
// public share links
// ---------------------------------------------------------------------------

// handleShare serves "/_share/<token>[/...]" without authentication.
func (s *site) handleShare(w http.ResponseWriter, r *http.Request, suffix string) {
	token, sub := splitFirst(strings.Trim(suffix, "/"), "/")
	if token == "" {
		rest.Fail(w, http.StatusNotFound, "分享链接不存在或已过期")
		return
	}
	if s.shares == nil {
		rest.Fail(w, http.StatusNotFound, "分享链接不可用")
		return
	}
	share, ok, err := s.shares.get(token)
	if err != nil {
		s.log.Error("read share link", "error", err)
		rest.Fail(w, http.StatusInternalServerError, "无法读取分享链接")
		return
	}
	if !ok || share.Expired(time.Now()) {
		rest.Fail(w, http.StatusNotFound, "分享链接不存在或已过期")
		return
	}
	base := s.sitePath(sharePrefix, token)
	switch sub {
	case "":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			s.methodNotAllowed(w, "GET, HEAD")
			return
		}
		start := share.Path
		if q := strings.TrimSpace(r.URL.Query().Get("path")); q != "" {
			if clean, err := vfs.Clean(q); err == nil && withinShare(share.Path, clean) {
				start = clean
			}
		}
		s.renderPage(w, pageConfig{
			Mode: "share",
			// The read only endpoints of a share link live directly below the
			// token (/_share/<token>/list, /download, /zip), so the page must
			// not append the /_api prefix the authenticated pages use.
			API:        base,
			Title:      s.title,
			Root:       share.Path,
			Start:      start,
			ReadOnly:   true,
			Can:        perms{},
			Share:      false,
			ShowHidden: false,
			Download:   share.AllowDownload,
		})
	case "list":
		if r.Method != http.MethodGet {
			s.methodNotAllowed(w, "GET")
			return
		}
		s.shareList(w, r, share, share.Path)
	case "download":
		if !share.AllowDownload {
			rest.Fail(w, http.StatusForbidden, "该分享链接不允许下载")
			return
		}
		clean, ok := s.pathParam(w, r, share.Path)
		if !ok {
			return
		}
		if !withinShare(share.Path, clean) {
			rest.Fail(w, http.StatusForbidden, "该路径不在此分享范围内")
			return
		}
		if r.URL.Query().Get("zip") == "1" {
			s.handleZip(w, r, clean)
			return
		}
		s.download(w, r, clean, false)
	case "zip":
		if !share.AllowDownload {
			rest.Fail(w, http.StatusForbidden, "该分享链接不允许下载")
			return
		}
		clean, ok := s.pathParam(w, r, share.Path)
		if !ok {
			return
		}
		if !withinShare(share.Path, clean) {
			rest.Fail(w, http.StatusForbidden, "该路径不在此分享范围内")
			return
		}
		s.handleZip(w, r, clean)
	default:
		rest.Fail(w, http.StatusNotFound, "分享链接不存在或已过期")
	}
}

// shareList is the read-only listing of a share link.
func (s *site) shareList(w http.ResponseWriter, r *http.Request, share Share, root string) {
	clean, ok := s.pathParam(w, r, root)
	if !ok {
		return
	}
	if !withinShare(share.Path, clean) {
		rest.Fail(w, http.StatusForbidden, "该路径不在此分享范围内")
		return
	}
	s.listPath(w, r, clean)
}

// withinShare reports whether p is the shared resource or below it.
func withinShare(root, p string) bool {
	if root == "" || root == "/" {
		return true
	}
	return p == root || strings.HasPrefix(p, root+"/")
}

func splitFirst(s, sep string) (string, string) {
	if i := strings.Index(s, sep); i >= 0 {
		return s[:i], s[i+len(sep):]
	}
	return s, ""
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// pathParam reads and normalises the "path" query parameter. The default is
// used when the parameter is missing.
func (s *site) pathParam(w http.ResponseWriter, r *http.Request, def string) (string, bool) {
	raw := r.URL.Query().Get("path")
	if strings.TrimSpace(raw) == "" {
		raw = def
	}
	clean, err := vfs.Clean(raw)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "路径无效")
		return "", false
	}
	return clean, true
}

// fail writes the HTTP equivalent of a vfs error.
func (s *site) fail(w http.ResponseWriter, op string, err error) {
	status := vfsStatus(err)
	if status >= http.StatusInternalServerError && s.log != nil {
		s.log.Warn("file operation failed", "op", op, "error", err)
	}
	rest.Fail(w, status, "%s", vfsMessage(status))
}

func vfsStatus(err error) int {
	switch {
	case err == nil:
		return http.StatusOK
	case errors.Is(err, vfs.ErrNotExist):
		return http.StatusNotFound
	case errors.Is(err, vfs.ErrReadOnly):
		return http.StatusForbidden
	case errors.Is(err, vfs.ErrInvalidPath):
		return http.StatusBadRequest
	case errors.Is(err, vfs.ErrIsDir):
		return http.StatusBadRequest
	case errors.Is(err, vfs.ErrNotEmpty):
		return http.StatusConflict
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

// vfsMessage keeps internal details (and absolute paths) out of responses.
func vfsMessage(status int) string {
	switch status {
	case http.StatusNotFound:
		return "路径不存在"
	case http.StatusForbidden:
		return "存储为只读，操作被拒绝"
	case http.StatusBadRequest:
		return "路径无效"
	case http.StatusConflict:
		return "目录不为空"
	case http.StatusGatewayTimeout:
		return "存储响应超时"
	default:
		return "存储操作失败"
	}
}

func sortEntries(items []vfs.Entry, key, order string) {
	if order != "desc" {
		order = "asc"
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		c := compareEntries(a, b, key)
		if order == "desc" {
			return c > 0
		}
		return c < 0
	})
}

func compareEntries(a, b vfs.Entry, key string) int {
	switch key {
	case "size":
		if a.Size != b.Size {
			if a.Size < b.Size {
				return -1
			}
			return 1
		}
	case "time":
		if !a.ModTime.Equal(b.ModTime) {
			if a.ModTime.Before(b.ModTime) {
				return -1
			}
			return 1
		}
	case "type":
		ea, eb := strings.ToLower(path.Ext(a.Name)), strings.ToLower(path.Ext(b.Name))
		if ea != eb {
			if ea < eb {
				return -1
			}
			return 1
		}
	}
	an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
	switch {
	case an < bn:
		return -1
	case an > bn:
		return 1
	default:
		return 0
	}
}
