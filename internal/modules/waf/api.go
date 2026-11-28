package waf

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

// defaultLogLimit is the number of events returned when no limit is given.
const defaultLogLimit = 100

// RegisterAPI mounts the REST endpoints below /api/v1/waf.
func (w *WAF) RegisterAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/waf")
	g.Get("/config", w.handleGetConfig)
	g.Put("/config", w.handlePutConfig)
	g.Get("/rules", w.handleRules)
	g.Get("/logs", w.handleLogs)
	g.Delete("/logs", w.handleClearLogs)
	g.Post("/test", w.handleTest)
	g.Post("/reload", w.handleReload)
}

// engineView is the runtime state of the engine as exposed to the UI.
type engineView struct {
	Enabled     bool       `json:"enabled"`
	Detail      string     `json:"detail,omitempty"`
	Error       string     `json:"error,omitempty"`
	Mode        string     `json:"mode"`
	LogOnly     bool       `json:"logOnly"`
	UseCRS      bool       `json:"useCrs"`
	CRSVersion  string     `json:"crsVersion,omitempty"`
	CRSFallback bool       `json:"crsFallback,omitempty"`
	Rules       int        `json:"rules"`
	RuleFiles   int        `json:"ruleFiles"`
	BuiltAt     *time.Time `json:"builtAt,omitempty"`
}

// Config returns a copy of the current firewall configuration.
func (w *WAF) Config() model.WAFConfig {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.cfg
}

// engineView builds the runtime view of the engine.
func (w *WAF) engineView() engineView {
	w.mu.RLock()
	eng := w.engine
	cfg := w.cfg
	buildErr := w.buildErr
	w.mu.RUnlock()

	// The runtime fields describe the engine that is actually serving traffic;
	// the requested configuration is returned separately by GET /config.
	if eng != nil {
		cfg = eng.cfg
	}
	view := engineView{
		Enabled: eng != nil && cfg.Enable,
		Mode:    cfg.Mode,
		LogOnly: cfg.LogOnly,
		UseCRS:  cfg.UseCRS,
	}
	if eng != nil {
		view.Detail = eng.detail
		view.Rules = eng.rules
		view.RuleFiles = eng.files
		view.CRSFallback = eng.crsFallback
		built := eng.builtAt
		if !built.IsZero() {
			view.BuiltAt = &built
		}
	}
	if buildErr != nil {
		view.Error = buildErr.Error()
	}
	if _, version, err := w.ruleCatalog(); err == nil {
		view.CRSVersion = version
	}
	return view
}

func (w *WAF) handleGetConfig(rw http.ResponseWriter, r *http.Request) {
	rest.OK(rw, map[string]any{
		"config": w.Config(),
		"engine": w.engineView(),
		"stats":  w.Stats(),
	})
}

func (w *WAF) handlePutConfig(rw http.ResponseWriter, r *http.Request) {
	var req model.WAFConfig
	if err := rest.Decode(rw, r, &req); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	req = normalizeWAFConfig(req)
	if err := validateEngineConfig(req); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "invalid waf configuration: %s", err.Error())
		return
	}
	if w.deps == nil || w.deps.Cfg == nil {
		rest.Fail(rw, http.StatusInternalServerError, "%s", errNoConfigStore.Error())
		return
	}
	previous := w.deps.Cfg.Snapshot().WAF
	if err := w.deps.Cfg.Update(func(c *model.Config) error {
		c.WAF = req
		return nil
	}); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "cannot save the waf configuration: %s", err.Error())
		return
	}
	if err := w.rebuild(req, true); err != nil {
		// Keep the previous working rule set, otherwise a typo would leave the
		// service unprotected until an administrator fixes it.
		if rerr := w.deps.Cfg.Update(func(c *model.Config) error {
			c.WAF = previous
			return nil
		}); rerr != nil && w.log != nil {
			w.log.Error("WAF：无法恢复之前的配置", "error", rerr)
		}
		_ = w.rebuild(previous, true)
		rest.Fail(rw, http.StatusBadRequest, "the rule set cannot be compiled: %s", err.Error())
		return
	}
	rest.OK(rw, map[string]any{
		"status": "ok",
		"config": w.Config(),
		"engine": w.engineView(),
		"stats":  w.Stats(),
	})
}

// ruleFileView is one entry of GET /rules.
type ruleFileView struct {
	ruleFile
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

func (w *WAF) handleRules(rw http.ResponseWriter, r *http.Request) {
	catalog, version, err := w.ruleCatalog()
	if err != nil {
		rest.Fail(rw, http.StatusInternalServerError, "cannot read the bundled rule set: %s", err.Error())
		return
	}
	cfg := w.Config()
	items := make([]ruleFileView, 0, len(catalog)+len(cfg.RuleFiles))
	for _, f := range catalog {
		view := ruleFileView{ruleFile: f, Enabled: true}
		switch {
		case !cfg.UseCRS:
			view.Enabled, view.Reason = false, "crs disabled"
		case disabledByRange(cfg.DisabledRules, f):
			view.Enabled, view.Reason = false, "disabled by rule id range"
		}
		items = append(items, view)
	}
	for _, file := range cfg.RuleFiles {
		view := ruleFileView{ruleFile: diskRuleFile(file), Enabled: true}
		if ferr := ruleFileExists(file); ferr != nil {
			view.Enabled, view.Reason = false, ferr.Error()
		}
		items = append(items, view)
	}
	rest.OK(rw, map[string]any{
		"items":         items,
		"crsVersion":    version,
		"useCrs":        cfg.UseCRS,
		"mode":          cfg.Mode,
		"disabledRules": cfg.DisabledRules,
	})
}

// diskRuleFile describes a rule file configured on disk.
func diskRuleFile(file string) ruleFile {
	base := path.Base(strings.ReplaceAll(file, "\\", "/"))
	out := ruleFile{File: file, Name: base, Title: base}
	if data, err := readLocalFile(file); err == nil {
		out = describeRuleFile(file, base, data, false)
		out.Builtin = false
	}
	return out
}

func (w *WAF) handleLogs(rw http.ResponseWriter, r *http.Request) {
	limit := defaultLogLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			rest.Fail(rw, http.StatusBadRequest, "limit must be a positive number")
			return
		}
		if n > defaultEventKeep {
			n = defaultEventKeep
		}
		limit = n
	}
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	if action != "" && action != "deny" && action != "detect" {
		rest.Fail(rw, http.StatusBadRequest, "action must be deny or detect")
		return
	}
	events := w.rec.list(limit)
	if action != "" {
		filtered := make([]Event, 0, len(events))
		for _, ev := range events {
			if ev.Action == action {
				filtered = append(filtered, ev)
			}
		}
		events = filtered
	}
	rest.OK(rw, map[string]any{
		"items": events,
		"count": len(events),
		// total is the whole buffer, matched is what survives the action
		// filter; the page prints the latter next to the filtered list.
		"total":   w.rec.size(),
		"matched": w.rec.count(action),
	})
}

func (w *WAF) handleClearLogs(rw http.ResponseWriter, r *http.Request) {
	w.rec.clear()
	rest.OK(rw, map[string]any{"status": "cleared"})
}

// testRequest is a synthetic request handed to the engine by the UI.
type testRequest struct {
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	ClientIP string            `json:"clientIp"`
}

// testResponse is the verdict of POST /test.
type testResponse struct {
	Blocked    bool      `json:"blocked"`
	Enforced   bool      `json:"enforced"`
	Mode       string    `json:"mode"`
	LogOnly    bool      `json:"logOnly"`
	Action     string    `json:"action,omitempty"`
	Status     int       `json:"status"`
	RuleID     int       `json:"ruleId,omitempty"`
	Message    string    `json:"message,omitempty"`
	Matched    []ruleHit `json:"matched"`
	TxID       string    `json:"txId,omitempty"`
	DurationMs int64     `json:"durationMs"`
	Error      string    `json:"error,omitempty"`
}

func (w *WAF) handleTest(rw http.ResponseWriter, r *http.Request) {
	var req testRequest
	if err := rest.Decode(rw, r, &req); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	meta, err := syntheticMeta(req)
	if err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	st := w.state()
	cfg := st.cfg
	res := testResponse{Mode: cfg.Mode, LogOnly: cfg.LogOnly, Status: http.StatusOK, Matched: []ruleHit{}}
	if st.engine == nil {
		res.Error = "the waf engine is disabled"
		rest.OK(rw, res)
		return
	}
	start := time.Now()
	out, perr := st.engine.process(r.Context(), meta)
	res.DurationMs = time.Since(start).Milliseconds()
	res.Blocked = out.Blocked
	res.Enforced = out.Blocked && st.engine.enforces()
	res.Action = out.Action
	res.RuleID = out.RuleID
	res.Message = out.Message
	res.TxID = out.TxID
	if out.Matched != nil {
		res.Matched = out.Matched
	}
	if out.Blocked && out.Status > 0 {
		res.Status = out.Status
	}
	if perr != nil {
		res.Error = perr.Error()
	}
	w.rec.tests.Add(1)
	rest.OK(rw, res)
}

func (w *WAF) handleReload(rw http.ResponseWriter, r *http.Request) {
	if err := w.rebuild(w.Config(), true); err != nil {
		rest.Fail(rw, http.StatusInternalServerError, "cannot compile the rule set: %s", err.Error())
		return
	}
	rest.OK(rw, map[string]any{"status": "reloaded", "engine": w.engineView()})
}

// syntheticMeta turns a test payload into an engine request.
func syntheticMeta(req testRequest) (*requestMeta, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	if !validToken(method) {
		return nil, fmt.Errorf("invalid http method %q", req.Method)
	}
	raw := strings.TrimSpace(req.URL)
	if raw == "" {
		raw = "/"
	}
	if strings.ContainsAny(raw, "\r\n\t ") {
		return nil, errors.New("the url must not contain whitespace or line breaks")
	}
	if !strings.HasPrefix(raw, "/") && !strings.Contains(raw, "://") {
		raw = "/" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url %q: %w", req.URL, err)
	}
	host := u.Host
	uri := u.RequestURI()
	if uri == "" {
		uri = "/"
	}
	if host == "" {
		host = "localhost"
	}
	headers := http.Header{}
	for name, value := range req.Headers {
		if !validToken(name) {
			return nil, fmt.Errorf("invalid header name %q", name)
		}
		if strings.ContainsAny(value, "\r\n") {
			return nil, fmt.Errorf("header %q contains line breaks", name)
		}
		headers.Set(name, value)
	}
	if v := headers.Get("Host"); v != "" {
		host = v
	}
	ip := strings.TrimSpace(strings.Trim(req.ClientIP, "[]"))
	if ip == "" {
		ip = "127.0.0.1"
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return nil, fmt.Errorf("invalid client ip %q", req.ClientIP)
	}
	meta := &requestMeta{
		ClientIP:   parsed.String(),
		ClientPort: 0,
		Method:     method,
		URI:        uri,
		Proto:      "HTTP/1.1",
		Host:       host,
		Headers:    headers,
	}
	if req.Body != "" {
		meta.Body = strings.NewReader(req.Body)
	}
	return meta, nil
}

// validToken reports whether s is a valid HTTP token (no separators).
func validToken(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		case strings.IndexByte("!#$%&'*+-.^_|~", c) >= 0:
		default:
			return false
		}
	}
	return true
}
