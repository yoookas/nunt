package web

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/reqmeta"
)

// defaultLogKeep is the fallback size of the access log ring buffer.
const defaultLogKeep = 200

// AccessEntry is one recorded request.
type AccessEntry struct {
	Time       time.Time `json:"time"`
	RuleID     string    `json:"ruleId"`
	Rule       string    `json:"rule"`
	Listen     string    `json:"listen,omitempty"`
	Host       string    `json:"host,omitempty"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	Status     int       `json:"status"`
	Duration   string    `json:"duration"`
	DurationMs int64     `json:"durationMs"`
	ClientIP   string    `json:"clientIp"`
	UserAgent  string    `json:"userAgent"`
	Upstream   string    `json:"upstream,omitempty"`
	// UpstreamStatus and Attempts describe the proxy exchange; BytesIn is the
	// declared request body and BytesOut the response bytes.
	UpstreamStatus int   `json:"upstreamStatus,omitempty"`
	Attempts       int   `json:"attempts,omitempty"`
	Bytes          int64 `json:"bytes"`
	BytesIn        int64 `json:"bytesIn,omitempty"`
	BytesOut       int64 `json:"bytesOut,omitempty"`
	// Protocol is the HTTP version, TLS the negotiated TLS version.
	Protocol  string `json:"proto,omitempty"`
	TLS       string `json:"tls,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Error     string `json:"error,omitempty"`
	// WAF verdict (merged into this record instead of a second source=waf row).
	WAFAction string `json:"wafAction,omitempty"`
	WAFRuleID int    `json:"wafRuleId,omitempty"`
	Message   string `json:"message,omitempty"`
	// Geography resolved from ClientIP when the database is loaded.
	Country  string `json:"country,omitempty"`
	Province string `json:"province,omitempty"`
	City     string `json:"city,omitempty"`
}

// logBuffer is a fixed size ring buffer of access log entries.
type logBuffer struct {
	mu    sync.Mutex
	items []AccessEntry
	next  int
	full  bool
	keep  int
}

func newLogBuffer(keep int) *logBuffer {
	if keep <= 0 {
		keep = defaultLogKeep
	}
	return &logBuffer{items: make([]AccessEntry, keep), keep: keep}
}

// add appends an entry, overwriting the oldest one when the buffer is full.
func (b *logBuffer) add(e AccessEntry) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.items[b.next] = e
	b.next = (b.next + 1) % len(b.items)
	if b.next == 0 {
		b.full = true
	}
	b.mu.Unlock()
}

// resize changes the capacity, keeping the most recent entries.
func (b *logBuffer) resize(keep int) {
	if keep <= 0 {
		keep = defaultLogKeep
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if keep == len(b.items) {
		return
	}
	recent := b.listLocked(keep)
	b.items = make([]AccessEntry, keep)
	b.next = 0
	b.full = false
	for _, e := range recent {
		b.items[b.next] = e
		b.next = (b.next + 1) % len(b.items)
		if b.next == 0 {
			b.full = true
		}
	}
	b.keep = keep
}

// list returns up to limit entries, newest first. An empty ruleID returns the
// entries of every rule.
func (b *logBuffer) list(ruleID string, limit int) []AccessEntry {
	if b == nil {
		return []AccessEntry{}
	}
	b.mu.Lock()
	rows := b.listLocked(0)
	b.mu.Unlock()
	if limit <= 0 || limit > len(rows) {
		limit = len(rows)
	}
	out := make([]AccessEntry, 0, limit)
	for i := len(rows) - 1; i >= 0 && len(out) < limit; i-- {
		if ruleID != "" && rows[i].RuleID != ruleID {
			continue
		}
		out = append(out, rows[i])
	}
	return out
}

// listLocked returns the stored entries oldest first. The caller holds the lock.
func (b *logBuffer) listLocked(limit int) []AccessEntry {
	size := b.next
	if b.full {
		size = len(b.items)
	}
	if limit <= 0 || limit > size {
		limit = size
	}
	out := make([]AccessEntry, 0, limit)
	start := (b.next - limit + len(b.items)) % len(b.items)
	for i := 0; i < limit; i++ {
		out = append(out, b.items[(start+i)%len(b.items)])
	}
	return out
}

// accessRecorder captures the response status and size for the access log. It
// forwards Flush and Hijack so streaming and upgraded connections keep working.
type accessRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
	wrote  bool
}

func (a *accessRecorder) WriteHeader(code int) {
	if !a.wrote {
		a.status = code
		a.wrote = true
	}
	a.ResponseWriter.WriteHeader(code)
}

func (a *accessRecorder) Write(b []byte) (int, error) {
	if !a.wrote {
		a.status = http.StatusOK
		a.wrote = true
	}
	n, err := a.ResponseWriter.Write(b)
	a.bytes += int64(n)
	return n, err
}

// Flush keeps streaming responses (SSE, chunked uploads) working.
func (a *accessRecorder) Flush() {
	if !a.wrote {
		a.status = http.StatusOK
		a.wrote = true
	}
	if f, ok := a.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack keeps protocol upgrades working.
func (a *accessRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := a.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("web: the response writer does not support hijacking")
	}
	if !a.wrote {
		a.status = http.StatusSwitchingProtocols
		a.wrote = true
	}
	return h.Hijack()
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (a *accessRecorder) Unwrap() http.ResponseWriter { return a.ResponseWriter }

// underlyingWriter unwraps the middleware writers down to the writer net/http
// knows about. http.MaxBytesReader marks the response through an unexported
// interface, which a wrapper implemented in another package can never satisfy,
// so anything that has to talk to net/http directly is handed this writer.
func underlyingWriter(w http.ResponseWriter) http.ResponseWriter {
	for i := 0; i < 8; i++ {
		unwrapper, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return w
		}
		next := unwrapper.Unwrap()
		if next == nil || next == w {
			return w
		}
		w = next
	}
	return w
}

// maxLogLimit bounds the number of entries a single API call may return.
const maxLogLimit = 1000

// logAccess writes the entry of a finished request.
func (w *Web) logAccess(r *rule, req *http.Request, rec *accessRecorder, start time.Time) {
	if r == nil {
		return
	}
	if !w.accessLogEnabled() {
		return
	}
	elapsed := time.Since(start)
	status := rec.status
	if status == 0 {
		status = http.StatusOK
	}
	reason, errText, upstreamStatus, attempts := noteFrom(req.Context()).snapshot()
	clientIP := clientIPString(req, w.trustProxy(w.cfg))
	country, province, city := w.lookupGeo(clientIP)
	wafAction, wafRuleID, wafMessage := "", 0, ""
	if verdict, ok := reqmeta.From(req.Context()).WAF(); ok {
		wafAction, wafRuleID, wafMessage = verdict.Action, verdict.RuleID, verdict.Message
	}
	bytesIn := req.ContentLength
	if bytesIn < 0 {
		bytesIn = 0
	}
	entry := AccessEntry{
		Time:           start,
		RuleID:         r.id,
		Rule:           r.name,
		Listen:         requestListenAddr(req),
		Host:           req.Host,
		Method:         req.Method,
		Path:           req.URL.RequestURI(),
		Status:         status,
		Duration:       elapsed.Round(time.Millisecond).String(),
		DurationMs:     elapsed.Milliseconds(),
		ClientIP:       clientIP,
		UserAgent:      req.UserAgent(),
		Upstream:       upstreamFrom(req.Context()),
		UpstreamStatus: upstreamStatus,
		Attempts:       attempts,
		Bytes:          rec.bytes,
		BytesIn:        bytesIn,
		BytesOut:       rec.bytes,
		Protocol:       req.Proto,
		TLS:            tlsVersionLabel(req),
		RequestID:      requestIDFrom(req.Context()),
		Reason:         reason,
		Error:          errText,
		WAFAction:      wafAction,
		WAFRuleID:      wafRuleID,
		Message:        wafMessage,
		Country:        country,
		Province:       province,
		City:           city,
	}
	w.logs.add(entry)
	w.persist(entry)
	if status >= 500 {
		w.logger().Warn("web：请求失败", "rule", r.name, "requestId", entry.RequestID,
			"method", req.Method, "path", entry.Path, "status", status,
			"client", entry.ClientIP, "error", entry.Error)
	}
}

// persist appends the entry to the persistent access log. The in memory ring
// keeps the live view fast; the store survives a restart.
func (w *Web) persist(e AccessEntry) {
	if w.deps == nil || w.deps.Logs == nil {
		return
	}
	w.deps.Logs.Append(logstore.Entry{
		Time:           e.Time,
		Source:         logstore.SourceWeb,
		RuleID:         e.RuleID,
		Rule:           e.Rule,
		Listen:         e.Listen,
		Host:           e.Host,
		Method:         e.Method,
		Path:           e.Path,
		Status:         e.Status,
		ClientIP:       e.ClientIP,
		UserAgent:      e.UserAgent,
		Upstream:       e.Upstream,
		UpstreamStatus: e.UpstreamStatus,
		Attempts:       e.Attempts,
		DurationMs:     e.DurationMs,
		Bytes:          e.Bytes,
		BytesIn:        e.BytesIn,
		BytesOut:       e.BytesOut,
		Proto:          e.Protocol,
		TLS:            e.TLS,
		RequestID:      e.RequestID,
		Reason:         e.Reason,
		Error:          e.Error,
		WAFAction:      e.WAFAction,
		WAFRuleID:      e.WAFRuleID,
		Message:        e.Message,
		Country:        e.Country,
		Province:       e.Province,
		City:           e.City,
	})
}

// Logs returns the recorded entries, newest first.
func (w *Web) Logs(ruleID string, limit int) []AccessEntry {
	if limit <= 0 || limit > maxLogLimit {
		limit = defaultLogKeep
	}
	return w.logs.list(ruleID, limit)
}

// lookupGeo resolves the country/province/city of a client address. Missing or
// unloaded databases simply leave the fields empty.
func (w *Web) lookupGeo(addr string) (string, string, string) {
	if w.deps == nil || w.deps.Geo == nil {
		return "", "", ""
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return "", "", ""
	}
	record, err := w.deps.Geo.Lookup(ip)
	if err != nil {
		return "", "", ""
	}
	return record.Country, record.Province, record.City
}

// tlsVersionLabel renders the negotiated TLS version of a request.
func tlsVersionLabel(req *http.Request) string {
	if req.TLS == nil {
		return ""
	}
	switch req.TLS.Version {
	case tls.VersionTLS10:
		return "1.0"
	case tls.VersionTLS11:
		return "1.1"
	case tls.VersionTLS12:
		return "1.2"
	case tls.VersionTLS13:
		return "1.3"
	default:
		return ""
	}
}
