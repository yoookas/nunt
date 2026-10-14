package web

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// ruleTLS carries the resolved TLS settings of a rule.
type ruleTLS struct {
	mode   string
	certID string
	hsts   bool
	// cert caches the loaded certificate; it is written under the web mutex.
	cert        *tls.Certificate
	certDomains []string
}

// rule is the compiled form of a model.WebRule. Instances are shared between
// concurrent requests, so they are immutable after construction.
type rule struct {
	id       string
	name     string
	index    int
	path     string
	priority int
	domains  []string
	spec     *model.WebRule
	ipNets   []*net.IPNet
	tls      ruleTLS
	// siteKey fingerprints the rule definition so an unchanged rule keeps its
	// handler (and the storage that handler may have opened) across reloads.
	siteKey string
	site    *webSite
	// limiter throttles the requests of one client address on this rule; nil
	// when the rule does not configure a rate limit.
	limiter *rateLimiter
	// maxBody caps the request body of the rule; zero means the body size is
	// not limited.
	maxBody int64
}

// compileRule validates a rule and turns it into its runtime form. The site
// handler itself is built later, once the rule is bound to a listener.
func compileRule(r model.WebRule, index int) (*rule, error) {
	if r.ID == "" {
		r.ID = model.NewID()
	}
	out := &rule{
		id:       r.ID,
		name:     displayRuleName(r),
		index:    index,
		path:     model.NormalizePath(r.Path),
		priority: r.Priority,
		domains:  normalizeDomains(r.Domains),
		spec:     &r,
		siteKey:  siteFingerprint(&r),
		tls: ruleTLS{
			mode:   normalizeTLSMode(r.TLS.Mode),
			certID: strings.TrimSpace(r.TLS.CertID),
			hsts:   r.TLS.HSTS,
		},
	}
	if len(r.Listen) == 0 {
		return nil, fmt.Errorf("at least one listen address is required")
	}
	for _, addr := range r.Listen {
		if _, err := netutil.NormalizeListen(addr); err != nil {
			return nil, err
		}
	}
	switch out.spec.Type {
	case model.WebTypeProxy:
		if out.spec.Proxy == nil || len(out.spec.Proxy.Targets) == 0 {
			return nil, errors.New("at least one proxy target is required")
		}
		if _, err := newBalancer(out.spec.Proxy.Balance, out.spec.Proxy.Targets); err != nil {
			return nil, err
		}
	case model.WebTypeRedirect:
		if out.spec.Redirect == nil || strings.TrimSpace(out.spec.Redirect.To) == "" {
			return nil, errors.New("a redirect target is required")
		}
	}
	switch out.tls.mode {
	case model.TLSModeCustom:
		if out.tls.certID == "" {
			return nil, errors.New("a certificate must be selected for the custom TLS mode")
		}
	case model.TLSModeAuto:
		for _, d := range out.domains {
			if d == "*" || strings.HasPrefix(d, "~") {
				continue
			}
			out.tls.certDomains = append(out.tls.certDomains, d)
		}
		if len(out.tls.certDomains) == 0 {
			return nil, errors.New("automatic certificates need at least one concrete domain")
		}
	}
	if p := out.spec.Proxy; p != nil {
		if p.RateLimitPerSec < 0 {
			return nil, errors.New("rateLimitPerSec must not be negative")
		}
		if p.MaxBodyBytes < 0 {
			return nil, errors.New("maxBodyBytes must not be negative")
		}
		out.maxBody = p.MaxBodyBytes
		if p.RateLimitPerSec > 0 {
			out.limiter = newRateLimiter(p.RateLimitPerSec)
		}
	}
	nets, err := netutil.ParseIPList(r.Access.IPs)
	if err != nil {
		return nil, err
	}
	out.ipNets = nets
	if r.BasicAuth != nil && r.BasicAuth.Enable && len(r.BasicAuth.Users) == 0 {
		return nil, errors.New("basic authentication is enabled without users")
	}
	if err := checkRuleStorage(r); err != nil {
		return nil, err
	}
	return out, nil
}

// checkRuleStorage validates the storage reference of a rule without opening
// it, so a broken rule cannot take a whole listener down.
func checkRuleStorage(r model.WebRule) error {
	switch r.Type {
	case model.WebTypeStatic, model.WebTypeFiles, model.WebTypeWebDAV:
	default:
		return nil
	}
	var mountID, root string
	switch {
	case r.Static != nil:
		mountID, root = strings.TrimSpace(r.Static.MountID), strings.TrimSpace(r.Static.Root)
	case r.Files != nil:
		mountID, root = strings.TrimSpace(r.Files.MountID), strings.TrimSpace(r.Files.Root)
	default:
		return errors.New("storage settings are required")
	}
	if mountID == "" && root == "" {
		return errors.New("a mount or a root directory is required")
	}
	if mountID != "" && strings.ContainsAny(mountID, "\\/") {
		return errors.New("invalid mount id")
	}
	return nil
}

// normalizeDomains trims and lowercases the domain patterns of a rule.
func normalizeDomains(in []string) []string {
	out := make([]string, 0, len(in))
	for _, d := range in {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "" {
			continue
		}
		out = append(out, d)
	}
	return out
}

func normalizeTLSMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case model.TLSModeAuto:
		return model.TLSModeAuto
	case model.TLSModeCustom:
		return model.TLSModeCustom
	default:
		return model.TLSModeOff
	}
}

func displayRuleName(r model.WebRule) string {
	if n := strings.TrimSpace(r.Name); n != "" {
		return n
	}
	if r.ID != "" {
		return r.ID
	}
	return "unnamed"
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

// router serves the requests of one listen address.
type router struct {
	web *Web
	// matcher is replaced on every reload; requests read it atomically through
	// the mutex protected pointer.
	mu      sync.RWMutex
	matcher *matcher
	addr    string
}

func newRouter(w *Web, addr string) *router {
	return &router{web: w, addr: addr}
}

func (rt *router) setMatcher(m *matcher) {
	rt.mu.Lock()
	rt.matcher = m
	rt.mu.Unlock()
}

func (rt *router) currentMatcher() *matcher {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.matcher
}

// ServeHTTP resolves the rule and runs the middleware chain.
func (rt *router) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	m := rt.currentMatcher()
	if m == nil {
		http.Error(rw, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	r := m.Match(req.Host, req.URL.Path)
	if r == nil {
		rt.web.logger().Debug("web: no rule matches the request", "listen", rt.addr, "host", req.Host, "path", req.URL.Path)
		http.Error(rw, "no route for this host", http.StatusNotFound)
		return
	}
	// Every request inside a matched rule is counted and logged, even when the
	// rule could not be prepared.
	rt.web.countRequest(r)
	rec := &accessRecorder{ResponseWriter: rw}
	start := time.Now()
	defer func() {
		if panicValue := recover(); panicValue != nil {
			rt.web.logger().Error("web: handler panicked", "rule", r.name, "path", req.URL.Path, "panic", panicValue)
			if !rec.wrote {
				http.Error(rec, "internal server error", http.StatusInternalServerError)
			}
		}
		rt.web.logAccess(r, req, rec, start)
	}()

	if r.site == nil || r.site.handler == nil {
		rt.web.logger().Warn("web: rule has no handler", "rule", r.name)
		http.Error(rec, "route is not available", http.StatusServiceUnavailable)
		return
	}
	// A file service that nobody guards must not be served at all. This is the
	// runtime half of the configuration check; both refuse the same rules.
	if r.fileServiceUnprotected() {
		rt.web.warnUnprotectedFileService(r, req)
		http.Error(rec, fileGuardMessage, http.StatusForbidden)
		return
	}

	ctx := withRule(req.Context(), r)
	req = req.WithContext(ctx)

	// The chain is built outer to inner: access control, rate limit, basic
	// auth, WAF and finally the business handler. The rate limit sits in front
	// of the password check so a flood cannot burn the hashing budget.
	handler := rt.web.accessHandler(r, r.site.handler)
	if r.limiter != nil {
		handler = rt.web.rateLimitHandler(r, handler)
	}
	if r.spec.BasicAuth != nil && r.spec.BasicAuth.Enable {
		handler = rt.web.basicAuthHandler(r, handler)
	}
	handler = rt.web.wafHandler(r, handler)
	if r.tls.hsts && isTLSRequest(req) {
		handler = rt.web.hstsHandler(r, handler)
	}
	handler.ServeHTTP(rec, req)
}

// isTLSRequest reports whether the request arrived over TLS, honouring a
// reverse proxy that terminates TLS in front of the service.
func isTLSRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// ruleFrom returns the rule serving the request.
func ruleFrom(ctx context.Context) (*rule, bool) {
	r, ok := ctx.Value(ruleKey{}).(*rule)
	return r, ok
}

type ruleKey struct{}

func withRule(ctx context.Context, r *rule) context.Context {
	return context.WithValue(ctx, ruleKey{}, r)
}

// clientIPFor exposes the caller address to the rest of the module.
func (w *Web) clientIPFor(req *http.Request) string {
	return clientIPString(req, w.trustProxy(w.cfg))
}
