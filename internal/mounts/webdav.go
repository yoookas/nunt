package mounts

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/httpc"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/vfs"
)

// The remote backend talks plain WebDAV over HTTP. Only the handful of methods
// the vfs.FS contract needs are implemented: PROPFIND for Stat/List, GET (with
// Range) for Open, PUT for Create, MKCOL for Mkdir, DELETE for Remove and MOVE
// for Rename.
const (
	// davTimeout bounds metadata requests. File transfers are deliberately not
	// covered by it: a 4 GB upload must not be killed after 30 seconds, so the
	// client keeps the transport level timeouts instead of an overall deadline.
	davTimeout = 30 * time.Second
	// davMaxBody caps the PROPFIND response we are willing to parse.
	davMaxBody = 16 << 20
	// davMaxDepth bounds how many entries one listing may return.
	davMaxDepth = 20000

	davUserAgent = "nunt/1.0 (+https://github.com/nunt/nunt)"
)

// propfindBody asks for the four properties the file system needs. Namespaces
// are declared on the root element because some servers are picky about
// prefixed bodies.
const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:displayname/>
  </D:prop>
</D:propfind>`

// davFS implements vfs.FS on top of a remote WebDAV collection.
type davFS struct {
	label    string
	base     *url.URL // collection URL, always with a trailing slash
	client   *http.Client
	user     string
	pass     string
	readOnly bool
	log      *slog.Logger
}

// openWebDAV returns a vfs.FS backed by a remote WebDAV collection.
//
// The mount is probed once so that a wrong URL or bad credentials surface as a
// configuration error instead of an empty listing.
func openWebDAV(mnt model.Mount, password string, log *slog.Logger) (vfs.FS, func() error, error) {
	raw := strings.TrimSpace(mnt.URL)
	if raw == "" {
		return nil, nil, fmt.Errorf("webdav mount %q: url is required", mnt.Name)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("webdav mount %q: parse url: %w", mnt.Name, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, nil, fmt.Errorf("webdav mount %q: unsupported url scheme %q", mnt.Name, u.Scheme)
	}
	if u.Host == "" {
		return nil, nil, fmt.Errorf("webdav mount %q: url %q has no host", mnt.Name, raw)
	}
	user, pass := mnt.Username, password
	if u.User != nil {
		if user == "" {
			user = u.User.Username()
		}
		if pw, ok := u.User.Password(); ok && pass == "" {
			pass = pw
		}
		u.User = nil
	}
	u.RawQuery, u.Fragment = "", ""
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}

	client := httpc.New(davTimeout, mnt.InsecureTLS)
	// httpc sets an overall deadline for short outbound calls; streaming a file
	// through this client would hit it, so rely on the transport timeouts.
	client.Timeout = 0

	label := strings.TrimSpace(mnt.Name)
	if label == "" {
		label = u.Host
	}
	d := &davFS{
		label:    label,
		base:     u,
		client:   client,
		user:     user,
		pass:     pass,
		readOnly: mnt.ReadOnly,
		log:      log,
	}

	ctx, cancel := context.WithTimeout(context.Background(), davTimeout)
	defer cancel()
	if _, err := d.Stat(ctx, "/"); err != nil {
		client.CloseIdleConnections()
		return nil, nil, fmt.Errorf("webdav mount %q: connect to %s: %w", label, u.Host, err)
	}
	if log != nil {
		log.Debug("webdav mount ready", "mount", label, "url", u.String(), "readOnly", d.readOnly)
	}
	return d, func() error {
		client.CloseIdleConnections()
		return nil
	}, nil
}

// Name implements vfs.FS.
func (d *davFS) Name() string { return d.label }

// ReadOnly implements vfs.FS.
func (d *davFS) ReadOnly() bool { return d.readOnly }

func (d *davFS) guard() error {
	if d.readOnly {
		return fmt.Errorf("%s: %w", d.label, vfs.ErrReadOnly)
	}
	return nil
}

// urlOf maps a rooted slash path to an absolute collection/member URL.
func (d *davFS) urlOf(p string) (*url.URL, string, error) {
	clean, err := vfs.Clean(p)
	if err != nil {
		return nil, "", err
	}
	u := *d.base
	if clean == "/" {
		return &u, clean, nil
	}
	// Setting Path (and clearing RawPath) lets net/url escape every segment
	// exactly once, including names with spaces, '#' or non ASCII characters.
	u.Path = d.base.Path + strings.TrimPrefix(clean, "/")
	u.RawPath = ""
	return &u, clean, nil
}

// do performs one authenticated request with a bounded metadata deadline.
func (d *davFS) do(req *http.Request) (*http.Response, error) {
	if d.user != "" || d.pass != "" {
		req.SetBasicAuth(d.user, d.pass)
	}
	req.Header.Set("User-Agent", davUserAgent)
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	if d.log != nil && d.log.Enabled(req.Context(), slog.LevelDebug) {
		d.log.Debug("webdav request", "method", req.Method, "path", req.URL.Path, "status", resp.StatusCode)
	}
	return resp, nil
}

// request builds a metadata request carrying a 30 second deadline.
func (d *davFS) request(ctx context.Context, method string, u *url.URL, body io.Reader, depth string) (*http.Request, context.CancelFunc, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, davTimeout)
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("build %s request: %w", method, err)
	}
	if depth != "" {
		req.Header.Set("Depth", depth)
	}
	return req, cancel, nil
}

type davMultiStatus struct {
	XMLName   xml.Name      `xml:"multistatus"`
	Responses []davResponse `xml:"response"`
}

type davResponse struct {
	Href     string        `xml:"href"`
	Propstat []davPropstat `xml:"propstat"`
}

type davPropstat struct {
	Status string  `xml:"status"`
	Prop   davProp `xml:"prop"`
}

type davProp struct {
	DisplayName   string          `xml:"displayname"`
	ContentLength string          `xml:"getcontentlength"`
	LastModified  string          `xml:"getlastmodified"`
	ResourceType  davResourceType `xml:"resourcetype"`
}

type davResourceType struct {
	Collection *struct{} `xml:"collection"`
}

// propfind issues a PROPFIND and decodes the multistatus document. Element
// names are matched by local name only, which keeps the parser working for
// servers that use unusual namespace prefixes.
func (d *davFS) propfind(ctx context.Context, u *url.URL, depth string) ([]davResponse, error) {
	req, cancel, err := d.request(ctx, "PROPFIND", u, strings.NewReader(propfindBody), depth)
	if err != nil {
		return nil, err
	}
	defer cancel()
	req.Header.Set("Content-Type", "application/xml; charset=utf-8")

	resp, err := d.do(req)
	if err != nil {
		return nil, fmt.Errorf("propfind %s: %w", u.Path, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusMultiStatus && resp.StatusCode != http.StatusOK {
		return nil, davStatusError("propfind", u.Path, resp)
	}
	var ms davMultiStatus
	dec := xml.NewDecoder(io.LimitReader(resp.Body, davMaxBody))
	if err := dec.Decode(&ms); err != nil {
		return nil, fmt.Errorf("propfind %s: decode multistatus: %w", u.Path, err)
	}
	if len(ms.Responses) == 0 {
		return nil, fmt.Errorf("propfind %s: %w", u.Path, vfs.ErrNotExist)
	}
	return ms.Responses, nil
}

// propsOf returns the first successful propstat of a response.
func propsOf(r davResponse) (davProp, bool) {
	for _, ps := range r.Propstat {
		if ps.Status == "" || strings.Contains(ps.Status, " 200 ") {
			return ps.Prop, true
		}
	}
	return davProp{}, false
}

func (p davProp) isDir() bool { return p.ResourceType.Collection != nil }

func (p davProp) size() int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(p.ContentLength), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func (p davProp) modTime() time.Time {
	raw := strings.TrimSpace(p.LastModified)
	if raw == "" {
		return time.Time{}
	}
	if t, err := http.ParseTime(raw); err == nil {
		return t
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t
		}
	}
	return time.Time{}
}

// relative turns an href into the rooted slash path below the collection.
func (d *davFS) relative(href string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return "", false
	}
	p := u.Path
	if p == "" {
		p = u.Opaque
	}
	p = strings.TrimSuffix(p, "/")
	root := strings.TrimSuffix(d.base.Path, "/")
	rel := strings.TrimPrefix(p, root)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		return "/", true
	}
	if strings.Contains(rel, "..") {
		return "", false
	}
	return path.Clean("/" + rel), true
}

// Stat implements vfs.FS.
func (d *davFS) Stat(ctx context.Context, p string) (vfs.Entry, error) {
	u, clean, err := d.urlOf(p)
	if err != nil {
		return vfs.Entry{}, err
	}
	responses, err := d.propfind(ctx, u, "0")
	if err != nil {
		return vfs.Entry{}, err
	}
	for _, r := range responses {
		rel, ok := d.relative(r.Href)
		if !ok || rel != clean {
			continue
		}
		prop, ok := propsOf(r)
		if !ok {
			continue
		}
		name := path.Base(clean)
		if clean == "/" {
			name = d.label
		}
		return davEntry(name, clean, prop), nil
	}
	return vfs.Entry{}, fmt.Errorf("stat %s: %w", clean, vfs.ErrNotExist)
}

// List implements vfs.FS.
func (d *davFS) List(ctx context.Context, p string, showHidden bool) ([]vfs.Entry, error) {
	u, clean, err := d.urlOf(p)
	if err != nil {
		return nil, err
	}
	responses, err := d.propfind(ctx, u, "1")
	if err != nil {
		return nil, err
	}
	out := make([]vfs.Entry, 0, len(responses))
	for _, r := range responses {
		rel, ok := d.relative(r.Href)
		if !ok || rel == clean || rel == "/" {
			continue
		}
		if path.Dir(rel) != clean {
			// Depth 1 must not return grandchildren; a misbehaving server that
			// does is filtered out instead of leaking entries.
			continue
		}
		name := path.Base(rel)
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		prop, ok := propsOf(r)
		if !ok {
			continue
		}
		out = append(out, davEntry(name, rel, prop))
		if len(out) >= davMaxDepth {
			break
		}
	}
	sortEntries(out)
	return out, nil
}

// Open implements vfs.FS with byte range support.
func (d *davFS) Open(ctx context.Context, p string, offset, size int64) (io.ReadCloser, vfs.Entry, error) {
	entry, err := d.Stat(ctx, p)
	if err != nil {
		return nil, vfs.Entry{}, err
	}
	if entry.Dir {
		return nil, vfs.Entry{}, fmt.Errorf("open %s: %w", p, vfs.ErrIsDir)
	}
	if offset < 0 {
		offset = 0
	}
	u, clean, err := d.urlOf(p)
	if err != nil {
		return nil, vfs.Entry{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, vfs.Entry{}, fmt.Errorf("build get request: %w", err)
	}
	if offset > 0 || size > 0 {
		req.Header.Set("Range", davRangeHeader(offset, size))
	}
	resp, err := d.do(req)
	if err != nil {
		return nil, vfs.Entry{}, fmt.Errorf("get %s: %w", clean, err)
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		_ = resp.Body.Close()
		return nil, vfs.Entry{}, fmt.Errorf("get %s: range %s not satisfiable", clean, davRangeHeader(offset, size))
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		err := davStatusError("get", clean, resp)
		_ = resp.Body.Close()
		return nil, vfs.Entry{}, err
	}

	body := io.ReadCloser(resp.Body)
	start := int64(0)
	if resp.StatusCode == http.StatusPartialContent {
		start = contentRangeStart(resp.Header.Get("Content-Range"))
	}
	if start < offset {
		if _, err := io.CopyN(io.Discard, resp.Body, offset-start); err != nil {
			_ = resp.Body.Close()
			return nil, vfs.Entry{}, fmt.Errorf("get %s: skip to offset %d: %w", clean, offset, err)
		}
	}
	if resp.ContentLength >= 0 {
		entry.Size = resp.ContentLength
	}
	if mod := resp.Header.Get("Last-Modified"); mod != "" {
		if t, err := http.ParseTime(mod); err == nil {
			entry.ModTime = t
		}
	}
	if size > 0 {
		body = &davLimitedBody{r: io.LimitReader(resp.Body, size), c: resp.Body}
	}
	return body, entry, nil
}

type davLimitedBody struct {
	r io.Reader
	c io.Closer
}

func (b *davLimitedBody) Read(p []byte) (int, error) { return b.r.Read(p) }
func (b *davLimitedBody) Close() error               { return b.c.Close() }

// Create implements vfs.FS by streaming the reader through a PUT.
func (d *davFS) Create(ctx context.Context, p string, r io.Reader) (int64, error) {
	if err := d.guard(); err != nil {
		return 0, err
	}
	u, clean, err := d.urlOf(p)
	if err != nil {
		return 0, err
	}
	if clean == "/" {
		return 0, fmt.Errorf("create %s: %w", p, vfs.ErrInvalidPath)
	}
	if r == nil {
		r = strings.NewReader("")
	}
	if err := d.Mkdir(ctx, path.Dir(clean)); err != nil {
		return 0, err
	}
	n, err := d.put(ctx, u, clean, r)
	if err == nil {
		return n, nil
	}
	if errors.Is(err, errDavConflict) {
		// A missing intermediate collection is the usual cause; create it and
		// retry exactly once so a race with another client is not hidden.
		if mkErr := d.Mkdir(ctx, path.Dir(clean)); mkErr != nil {
			return 0, mkErr
		}
		return d.put(ctx, u, clean, r)
	}
	return n, err
}

func (d *davFS) put(ctx context.Context, u *url.URL, clean string, r io.Reader) (int64, error) {
	counter := &countingReader{r: r}
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), counter)
	if err != nil {
		return 0, fmt.Errorf("build put request: %w", err)
	}
	if n := readerLength(r); n >= 0 {
		req.ContentLength = n
	}
	resp, err := d.do(req)
	if err != nil {
		return counter.count(), fmt.Errorf("put %s: %w", clean, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return counter.count(), nil
	case http.StatusConflict:
		return counter.count(), fmt.Errorf("put %s: %w", clean, errDavConflict)
	default:
		return counter.count(), davStatusError("put", clean, resp)
	}
}

// Mkdir implements vfs.FS; parents are created recursively because MKCOL has
// no "create intermediate collections" flag.
func (d *davFS) Mkdir(ctx context.Context, p string) error {
	if err := d.guard(); err != nil {
		return err
	}
	_, clean, err := d.urlOf(p)
	if err != nil {
		return err
	}
	if clean == "/" {
		return nil
	}
	segs := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	cur := ""
	for _, seg := range segs {
		if seg == "" || seg == "." {
			continue
		}
		if cur == "" {
			cur = "/" + seg
		} else {
			cur = cur + "/" + seg
		}
		u, _, err := d.urlOf(cur)
		if err != nil {
			return err
		}
		req, cancel, err := d.request(ctx, "MKCOL", u, nil, "")
		if err != nil {
			return err
		}
		resp, err := d.do(req)
		if err != nil {
			cancel()
			return fmt.Errorf("mkcol %s: %w", cur, err)
		}
		status := resp.StatusCode
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		cancel()
		switch status {
		case http.StatusCreated, http.StatusOK, http.StatusNoContent:
		case http.StatusMethodNotAllowed:
			// 405 means the collection already exists.
		case http.StatusConflict:
			// Some servers return 409 when the parent vanished between two
			// MKCOL calls; treat it as "already there" only for a non final
			// segment, otherwise report it.
			if cur != clean {
				continue
			}
			return fmt.Errorf("mkcol %s: parent collection does not exist", cur)
		default:
			return fmt.Errorf("mkcol %s: unexpected status %d", cur, status)
		}
	}
	return nil
}

// Remove implements vfs.FS.
func (d *davFS) Remove(ctx context.Context, p string, recursive bool) error {
	if err := d.guard(); err != nil {
		return err
	}
	u, clean, err := d.urlOf(p)
	if err != nil {
		return err
	}
	if clean == "/" {
		return fmt.Errorf("remove %s: %w", p, vfs.ErrInvalidPath)
	}
	entry, err := d.Stat(ctx, p)
	if err != nil {
		return err
	}
	if entry.Dir && !recursive {
		responses, err := d.propfind(ctx, u, "1")
		if err != nil {
			return err
		}
		for _, r := range responses {
			if rel, ok := d.relative(r.Href); ok && rel != clean {
				return fmt.Errorf("remove %s: %w", clean, vfs.ErrNotEmpty)
			}
		}
	}
	req, cancel, err := d.request(ctx, http.MethodDelete, u, nil, "")
	if err != nil {
		return err
	}
	defer cancel()
	resp, err := d.do(req)
	if err != nil {
		return fmt.Errorf("delete %s: %w", clean, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusNoContent, http.StatusAccepted:
		return nil
	default:
		return davStatusError("delete", clean, resp)
	}
}

// Rename implements vfs.FS with MOVE.
func (d *davFS) Rename(ctx context.Context, oldPath, newPath string) error {
	if err := d.guard(); err != nil {
		return err
	}
	oldURL, oldClean, err := d.urlOf(oldPath)
	if err != nil {
		return err
	}
	newURL, newClean, err := d.urlOf(newPath)
	if err != nil {
		return err
	}
	if oldClean == "/" || newClean == "/" {
		return fmt.Errorf("rename %s to %s: %w", oldPath, newPath, vfs.ErrInvalidPath)
	}
	if err := d.Mkdir(ctx, path.Dir(newClean)); err != nil {
		return err
	}
	req, cancel, err := d.request(ctx, "MOVE", oldURL, nil, "")
	if err != nil {
		return err
	}
	defer cancel()
	req.Header.Set("Destination", newURL.String())
	req.Header.Set("Overwrite", "T")
	resp, err := d.do(req)
	if err != nil {
		return fmt.Errorf("move %s to %s: %w", oldClean, newClean, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return nil
	default:
		return davStatusError("move "+oldClean+" to "+newClean, "", resp)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// errDavConflict marks a 409 so Create can create missing parents and retry.
var errDavConflict = errors.New("webdav conflict")

func davEntry(name, p string, prop davProp) vfs.Entry {
	mode := "file"
	if prop.isDir() {
		mode = "dir"
	}
	return vfs.Entry{
		Name:    name,
		Path:    p,
		Dir:     prop.isDir(),
		Size:    prop.size(),
		ModTime: prop.modTime(),
		Mode:    mode,
	}
}

func sortEntries(items []vfs.Entry) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
}

// davStatusError converts an HTTP status into the closest vfs error.
func davStatusError(op, p string, resp *http.Response) error {
	status := resp.StatusCode
	where := p
	if where == "" {
		where = resp.Request.URL.Path
	}
	switch status {
	case http.StatusNotFound, http.StatusGone:
		return fmt.Errorf("%s %s: %w", op, where, vfs.ErrNotExist)
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%s %s: %w (%s)", op, where, fs.ErrPermission, http.StatusText(status))
	case http.StatusConflict:
		return fmt.Errorf("%s %s: %w", op, where, errDavConflict)
	case http.StatusLocked:
		return fmt.Errorf("%s %s: resource is locked by another client", op, where)
	case http.StatusInsufficientStorage:
		return fmt.Errorf("%s %s: remote storage is full", op, where)
	default:
		return fmt.Errorf("%s %s: unexpected status %d %s", op, where, status, http.StatusText(status))
	}
}

func davRangeHeader(offset, size int64) string {
	if size > 0 {
		return "bytes=" + strconv.FormatInt(offset, 10) + "-" + strconv.FormatInt(offset+size-1, 10)
	}
	return "bytes=" + strconv.FormatInt(offset, 10) + "-"
}

// contentRangeStart extracts the first byte offset of a "bytes 0-99/1234"
// header; it returns 0 when the header is missing or malformed.
func contentRangeStart(header string) int64 {
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(strings.ToLower(header), "bytes") {
		return 0
	}
	header = strings.TrimSpace(header[len("bytes"):])
	if i := strings.IndexByte(header, '/'); i >= 0 {
		header = header[:i]
	}
	dash := strings.IndexByte(header, '-')
	if dash <= 0 {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(header[:dash]), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

type countingReader struct {
	r io.Reader

	// n is written by the transport's writer goroutine while the request is in
	// flight and read by the caller once it completes, so it must be accessed
	// atomically.
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// count returns the number of bytes read from the underlying reader so far.
func (c *countingReader) count() int64 { return c.n.Load() }

// readerLength reports the size of a body when it can be determined without
// consuming it; -1 means the request has to use chunked encoding.
func readerLength(r io.Reader) int64 {
	switch v := r.(type) {
	case interface{ Len() int }:
		return int64(v.Len())
	case *os.File:
		if info, err := v.Stat(); err == nil {
			return info.Size()
		}
	case interface{ Size() int64 }:
		return v.Size()
	}
	return -1
}
