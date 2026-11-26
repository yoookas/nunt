// Package waf wraps the Coraza engine used to protect the web service.
//
// The module compiles the OWASP Core Rule Set (embedded in the binary) together
// with the administrator rules, exposes a http middleware for the web service
// and keeps a rolling buffer of the interceptions shown in the admin UI.
package waf

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/reqmeta"
)

// WAF is the web application firewall module.
type WAF struct {
	module.Base
	deps *module.Deps
	log  *slog.Logger

	rec        *recorder
	mu         sync.RWMutex
	cfg        model.WAFConfig
	engine     *engine
	buildErr   error
	trustProxy bool
	started    bool
	wake       chan struct{}
	done       chan struct{}
	wg         sync.WaitGroup

	catalogOnce sync.Once
	catalog     []ruleFile
	crsVersion  string
	catalogErr  error
}

// New creates the module.
func New(deps *module.Deps) *WAF {
	w := &WAF{
		deps: deps,
		log:  deps.Logger("waf"),
		rec:  newRecorder(defaultEventKeep),
	}
	w.Init(deps, "waf", "Web 应用防火墙")
	if deps != nil && deps.Cfg != nil {
		snap := deps.Cfg.Snapshot()
		w.cfg = normalizeWAFConfig(snap.WAF)
		w.trustProxy = snap.System.TrustProxy
	}
	return w
}

// Start compiles the rule set and launches the background rebuilder. A rule set
// that cannot be compiled leaves the module running in pass-through mode, so a
// broken configuration never takes the service down.
func (w *WAF) Start(ctx context.Context) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return nil
	}
	w.started = true
	w.wake = make(chan struct{}, 1)
	w.done = make(chan struct{})
	cfg := w.cfg
	w.mu.Unlock()

	if err := w.rebuild(cfg, true); err != nil && w.log != nil {
		w.log.Error("WAF：规则集编译失败，流量不会被检查", "error", err)
	}
	w.wg.Add(1)
	go w.worker()
	w.SetRunning(true)
	return nil
}

// Stop releases the engine and waits for the background rebuilder.
func (w *WAF) Stop(context.Context) error {
	w.mu.Lock()
	if !w.started {
		w.mu.Unlock()
		w.SetRunning(false)
		return nil
	}
	w.started = false
	done := w.done
	eng := w.engine
	w.engine = nil
	w.buildErr = nil
	w.done, w.wake = nil, nil
	w.mu.Unlock()

	if done != nil {
		close(done)
	}
	w.wg.Wait()
	if eng != nil {
		if err := eng.close(); err != nil && w.log != nil {
			w.log.Warn("WAF：正在关闭引擎", "error", err)
		}
	}
	w.SetRunning(false)
	w.SetDetail("stopped")
	return nil
}

// Reload schedules a rebuild when the firewall configuration changed. It never
// blocks the caller: the engine is replaced by the background worker.
func (w *WAF) Reload(cfg *model.Config) {
	if w == nil || cfg == nil {
		return
	}
	next := normalizeWAFConfig(cfg.WAF)
	w.mu.Lock()
	same := sameWAFConfig(w.cfg, next)
	w.cfg = next
	w.trustProxy = cfg.System.TrustProxy
	started, wake := w.started, w.wake
	w.mu.Unlock()
	if same || !started || wake == nil {
		return
	}
	select {
	case wake <- struct{}{}:
	default: // a rebuild is already queued
	}
}

// worker rebuilds the engine whenever Reload asks for it.
func (w *WAF) worker() {
	defer w.wg.Done()
	for {
		w.mu.RLock()
		wake, done := w.wake, w.done
		w.mu.RUnlock()
		if wake == nil || done == nil {
			return
		}
		select {
		case <-done:
			return
		case <-wake:
			w.mu.RLock()
			cfg := w.cfg
			w.mu.RUnlock()
			if err := w.rebuild(cfg, false); err != nil && w.log != nil {
				w.log.Error("WAF：规则集编译失败，继续使用旧引擎", "error", err)
			}
		}
	}
}

// rebuild compiles cfg and swaps the engine. The previous engine is kept when
// the new configuration cannot be compiled, so a bad reload cannot disable the
// protection that is already in place.
func (w *WAF) rebuild(cfg model.WAFConfig, force bool) error {
	cfg = normalizeWAFConfig(cfg)

	w.mu.RLock()
	current := w.engine
	w.mu.RUnlock()
	if current != nil && !force && cfg.Enable && sameWAFConfig(current.cfg, cfg) {
		return nil
	}

	if !cfg.Enable {
		w.mu.Lock()
		old := w.engine
		w.engine = nil
		w.cfg = cfg
		w.buildErr = nil
		w.mu.Unlock()
		if old != nil {
			_ = old.close()
		}
		w.SetError(nil)
		w.SetDetail("disabled")
		return nil
	}

	eng, err := buildEngine(cfg, w.log)
	if err != nil {
		w.mu.Lock()
		w.cfg = cfg
		w.buildErr = err
		w.mu.Unlock()
		w.SetError(err)
		w.SetDetail("engine disabled: " + err.Error())
		return err
	}

	w.mu.Lock()
	old := w.engine
	w.engine = eng
	w.cfg = eng.cfg
	w.buildErr = nil
	w.mu.Unlock()
	if old != nil {
		_ = old.close()
	}
	w.SetError(nil)
	w.SetDetail(eng.detail)
	if w.log != nil {
		w.log.Info("WAF：引擎已就绪", "detail", eng.detail, "mode", eng.cfg.Mode, "logOnly", eng.cfg.LogOnly)
	}
	return nil
}

// sameWAFConfig compares two normalized configurations.
func sameWAFConfig(a, b model.WAFConfig) bool {
	a = normalizeWAFConfig(a)
	b = normalizeWAFConfig(b)
	return reflect.DeepEqual(a, b)
}

// requestState is the immutable snapshot the request path needs.
type requestState struct {
	engine     *engine
	cfg        model.WAFConfig
	trustProxy bool
}

func (w *WAF) state() requestState {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return requestState{engine: w.engine, cfg: w.cfg, trustProxy: w.trustProxy}
}

// Enabled reports whether the engine inspects traffic.
func (w *WAF) Enabled() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.engine != nil && w.cfg.Enable
}

// AdminProtect reports whether the admin interface should be filtered as well.
func (w *WAF) AdminProtect() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.cfg.Enable && w.cfg.AdminProtect && w.engine != nil
}

// Middleware wraps a handler; when the WAF is disabled it returns next.
//
// The request phases (connection, URI, headers, body) are driven by hand
// instead of using the generic coraza/v3/http wrapper because the module needs
// its own block page, its own event log and a log-only mode in which the
// interruption is reported but not enforced.
func (w *WAF) Middleware(ruleName string, next http.Handler) http.Handler {
	if next == nil {
		next = http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			http.NotFound(rw, r)
		})
	}
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		st := w.state()
		if st.engine == nil {
			next.ServeHTTP(rw, r)
			return
		}
		w.rec.requests.Add(1)
		handled, err := w.inspect(st, ruleName, rw, r, next)
		if err != nil {
			w.rec.errors.Add(1)
			if w.log != nil {
				w.log.Warn("WAF：请求无法被检查", "rule", ruleName, "error", err)
			}
		}
		if handled {
			return
		}
		next.ServeHTTP(rw, r)
	})
}

// flow tracks whether the response of a request was already produced while the
// request is still being inspected. The panic guard needs it to tell an engine
// panic (reported as an error, the request is served anyway) from a downstream
// panic (passed on untouched).
type flow struct {
	served     bool
	inspection bool
}

// inspect runs one request through the engine. It reports whether the response
// has already been produced, either because the request was blocked or because
// the downstream handler ran inside the transaction lifetime. A panic raised
// while inspecting is converted into an error so the request is served anyway;
// a panic raised by the downstream handler is passed on untouched.
func (w *WAF) inspect(st requestState, ruleName string, rw http.ResponseWriter, r *http.Request, next http.Handler) (handled bool, err error) {
	f := &flow{inspection: true}
	defer func() {
		if rec := recover(); rec != nil {
			if !f.inspection {
				panic(rec)
			}
			handled = f.served
			err = fmt.Errorf("panic while inspecting the request: %v", rec)
		}
	}()
	clientIP := netutil.ClientIP(r, st.trustProxy)
	remoteHost, port := splitHostPort(r.RemoteAddr)
	if clientIP == nil {
		clientIP = net.ParseIP(remoteHost)
	}
	ip := remoteHost
	if clientIP != nil {
		ip = clientIP.String()
	}
	meta := &requestMeta{
		ClientIP:         ip,
		ClientPort:       port,
		Method:           r.Method,
		URI:              requestURI(r),
		Proto:            r.Proto,
		Host:             r.Host,
		Headers:          r.Header,
		TransferEncoding: r.TransferEncoding,
		Body:             r.Body,
		Restore: func(body io.Reader) {
			r.Body = io.NopCloser(body)
		},
		Serve: func() {
			f.served = true
			f.inspection = false
			next.ServeHTTP(rw, r)
		},
		Block: func(blocked outcome) {
			f.served = true
			f.inspection = false
			w.writeBlocked(rw, blocked)
		},
	}
	if r.Body == nil || r.Body == http.NoBody {
		meta.Body = nil
	}

	out, perr := st.engine.process(r.Context(), meta)
	f.inspection = false

	// When the engine could not inspect the request (the body reader failed,
	// for example) the request must not be forwarded as if it had been checked.
	// Enforce mode answers 500; detect and log-only keep the traffic flowing so
	// a rollout never takes the service down.
	if perr != nil && st.engine.enforces() {
		f.served = true
		http.Error(rw, "internal server error", http.StatusInternalServerError)
		return true, perr
	}

	// The enforcement decision mirrors the one taken inside the engine so the
	// counters always describe what actually happened.
	enforce := st.engine.enforces()
	action := "detect"
	switch {
	case out.Blocked && enforce:
		action = "deny"
		w.rec.blocked.Add(1)
	case out.Blocked:
		w.rec.detected.Add(1)
	default:
		w.rec.passed.Add(1)
	}
	if out.Blocked {
		w.record(out, ruleName, r, ip, action)
	}
	return f.served, perr
}

func tlsVersion(r *http.Request) string {
	if r.TLS == nil {
		return ""
	}
	switch r.TLS.Version {
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

func requestURI(r *http.Request) string {
	if r.URL == nil {
		return "/"
	}
	return r.URL.RequestURI()
}

// splitHostPort extracts the port of a RemoteAddr, returning 0 when unknown.
func splitHostPort(addr string) (string, int) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port := 0
	for i := 0; i < len(portStr); i++ {
		if portStr[i] < '0' || portStr[i] > '9' {
			return host, 0
		}
		port = port*10 + int(portStr[i]-'0')
	}
	return host, port
}

// record stores the events of one blocked (or detected) request.
func (w *WAF) record(out outcome, ruleName string, r *http.Request, clientIP, action string) {
	base := Event{
		Time:      time.Now(),
		ClientIP:  clientIP,
		Method:    r.Method,
		Host:      truncate(r.Host, 255),
		URI:       truncate(requestURI(r), maxURILen),
		Rule:      ruleName,
		Action:    action,
		Status:    out.Status,
		TxID:      out.TxID,
		RequestID: r.Header.Get("X-Request-ID"),
		Proto:     r.Proto,
		TLS:       tlsVersion(r),
	}
	ids := make([]int, 0, len(out.Matched))
	for _, hit := range out.Matched {
		ids = append(ids, hit.ID)
	}

	// A web request already has an access record; the WAF verdict is merged
	// into it instead of being written as a second row. The admin WAF has no
	// such record, so its interceptions are still persisted on their own.
	info := reqmeta.From(r.Context())
	if len(out.Matched) == 0 {
		base.RuleID = out.RuleID
		base.Message = truncate(out.Message, maxURILen)
		base.RuleIDs = ids
		w.rec.add(base)
		if info != nil {
			info.SetWAF(action, base.RuleID, base.Message)
		} else {
			w.persistEvent(base)
		}
		return
	}
	for i, hit := range out.Matched {
		if i >= maxEventsPerRequest {
			break
		}
		ev := base
		ev.RuleID = hit.ID
		ev.Message = truncate(hit.Message, maxURILen)
		ev.Severity = hit.Severity
		ev.Tags = hit.Tags
		ev.RuleIDs = ids
		w.rec.add(ev)
		if info != nil {
			if i == 0 {
				info.SetWAF(action, ev.RuleID, ev.Message)
			}
			continue
		}
		w.persistEvent(ev)
	}
}

// persistEvent copies an interception to the persistent access log so it
// survives a restart and can be filtered together with the other sources.
func (w *WAF) persistEvent(ev Event) {
	if w.deps == nil || w.deps.Logs == nil {
		return
	}
	entry := logstore.Entry{
		Time:      ev.Time,
		Source:    logstore.SourceWAF,
		Rule:      ev.Rule,
		Host:      ev.Host,
		Method:    ev.Method,
		Path:      ev.URI,
		Status:    ev.Status,
		ClientIP:  ev.ClientIP,
		Result:    ev.Action,
		WAFAction: ev.Action,
		WAFRuleID: ev.RuleID,
		Message:   ev.Message,
		RequestID: ev.RequestID,
		Proto:     ev.Proto,
		TLS:       ev.TLS,
	}
	if w.deps.Geo != nil {
		if ip := net.ParseIP(ev.ClientIP); ip != nil {
			if record, err := w.deps.Geo.Lookup(ip); err == nil {
				entry.Country, entry.Province, entry.City = record.Country, record.Province, record.City
			}
		}
	}
	w.deps.Logs.Append(entry)
}

// blockPage is a static page: no part of the request is echoed back, so a
// blocked request can never inject markup.
const blockPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>请求被拦截</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#12141a;color:#e6e8ee;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:3rem;margin:0 0 .5rem;color:#ff6b6b}
p{margin:.35rem 0;color:#a8adbd;line-height:1.6}
code{background:#1d2029;border-radius:4px;padding:.15rem .4rem;color:#e6e8ee}
</style>
</head>
<body>
<main>
<h1>%d</h1>
<p>该请求被 Web 应用防火墙拦截。</p>
%s
</main>
</body>
</html>
`

// writeBlocked answers a blocked request. Only numeric rule ids and the Coraza
// transaction id are rendered.
func (w *WAF) writeBlocked(rw http.ResponseWriter, out outcome) {
	if out.Action == "redirect" {
		if target := safeRedirect(out.Data); target != "" {
			h := rw.Header()
			h.Set("Location", target)
			h.Set("Cache-Control", "no-store")
			rw.WriteHeader(redirectStatus(out.Status))
			return
		}
	}
	status := out.Status
	if status < 400 || status > 599 {
		status = http.StatusForbidden
	}
	extra := ""
	if out.RuleID > 0 {
		extra = fmt.Sprintf("<p>规则 ID <code>%d</code></p>", out.RuleID)
	}
	if ref := safeToken(out.TxID); ref != "" {
		extra += fmt.Sprintf("<p>请求编号 <code>%s</code></p>", ref)
	}
	h := rw.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	rw.WriteHeader(status)
	_, _ = io.WriteString(rw, fmt.Sprintf(blockPage, status, extra))
}

// safeRedirect validates the target of a "redirect" rule action.
func safeRedirect(target string) string {
	target = strings.TrimSpace(target)
	if target == "" || len(target) > 2048 {
		return ""
	}
	for _, r := range target {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	u, err := url.Parse(target)
	if err != nil {
		return ""
	}
	if u.Scheme != "" && u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	if u.Scheme == "" && !strings.HasPrefix(target, "/") {
		return ""
	}
	return target
}

func redirectStatus(status int) int {
	if status >= 300 && status <= 399 {
		return status
	}
	return http.StatusFound
}

// safeToken keeps only ASCII letters and digits, used for values rendered in
// the block page.
func safeToken(s string) string {
	if s == "" || len(s) > 64 {
		return ""
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '-':
		default:
			return ""
		}
	}
	return s
}

// Stats returns counters for the UI.
func (w *WAF) Stats() map[string]any {
	w.mu.RLock()
	eng := w.engine
	cfg := w.cfg
	buildErr := w.buildErr
	w.mu.RUnlock()

	// The counters describe the engine that is actually serving traffic.
	if eng != nil {
		cfg = eng.cfg
	}
	stats := map[string]any{
		"enabled":           eng != nil && cfg.Enable,
		"mode":              cfg.Mode,
		"logOnly":           cfg.LogOnly,
		"useCrs":            cfg.UseCRS,
		"paranoiaLevel":     cfg.ParanoiaLevel,
		"executingLevel":    cfg.ExecutingLevel,
		"inboundThreshold":  cfg.InboundThreshold,
		"outboundThreshold": cfg.OutboundThreshold,
		"bodyLimitKb":       cfg.BodyLimitKB,
		"adminProtect":      cfg.AdminProtect,
		"requests":          w.rec.requests.Load(),
		"blocked":           w.rec.blocked.Load(),
		"detected":          w.rec.detected.Load(),
		"passed":            w.rec.passed.Load(),
		"errors":            w.rec.errors.Load(),
		"tests":             w.rec.tests.Load(),
		"events":            w.rec.size(),
		"topRules":          w.rec.topRules(10),
		"topWebRules":       w.rec.topWebRules(10),
	}
	if eng != nil {
		stats["rules"] = eng.rules
		stats["ruleFiles"] = eng.files
		stats["detail"] = eng.detail
		stats["crsFallback"] = eng.crsFallback
		stats["builtAt"] = eng.builtAt
	}
	if buildErr != nil {
		stats["buildError"] = buildErr.Error()
	}
	if _, version, err := w.ruleCatalog(); err == nil {
		stats["crsVersion"] = version
	}
	return stats
}

// Status extends the module status with the WAF counters.
func (w *WAF) Status() module.Status {
	st := w.Base.Status()
	st.Stats = w.Stats()
	if st.Error == "" {
		w.mu.RLock()
		err := w.buildErr
		w.mu.RUnlock()
		if err != nil {
			st.Error = err.Error()
		}
	}
	return st
}

// ruleCatalog returns the built-in rule file list. It is computed once.
func (w *WAF) ruleCatalog() ([]ruleFile, string, error) {
	w.catalogOnce.Do(func() {
		files, version, err := builtinRuleFiles()
		w.catalog, w.crsVersion, w.catalogErr = files, version, err
	})
	return w.catalog, w.crsVersion, w.catalogErr
}

// Errors used by the module.
var (
	errNoConfigStore = errors.New("the configuration store is not available")
)
