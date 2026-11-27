package web

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/ipfilter"
	"github.com/nunt/nunt/internal/model"
)

// rule is the compiled form of a model.WebRule. Instances are shared between
// concurrent requests, so they are immutable after construction.
type rule struct {
	id         string
	name       string
	index      int
	path       string
	priority   int
	domains    []string
	spec       *model.WebRule
	filter     *ipfilter.Filter
	listenerID string
	// hsts and certDomains are copied from the owning listener at compile time.
	hsts        bool
	certDomains []string
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
	filter, err := ipfilter.Compile(r.Access, nil)
	if err != nil {
		return nil, err
	}
	out.filter = filter
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
	case model.WebTypeStatic:
	default:
		return nil
	}
	if r.Static == nil {
		return errors.New("static settings are required")
	}
	if strings.TrimSpace(r.Static.Root) == "" {
		return errors.New("a root directory is required")
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
	plan    *listenerPlan
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

func (rt *router) setPlan(p *listenerPlan) {
	rt.mu.Lock()
	rt.plan = p
	rt.mu.Unlock()
}

func (rt *router) currentPlan() *listenerPlan {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.plan
}

// ServeHTTP resolves the rule and runs the middleware chain.
func (rt *router) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	// Routing, static resolution and proxying must all see the same path. A
	// raw path such as "//admin", "/./admin" or "/admin\\secret" would miss the
	// rule that protects /admin while the upstream (nginx merges slashes and
	// dot segments by default) still serves it. Canonicalise once, here.
	canonical, ok := canonicalPath(req.URL.Path)
	if !ok {
		http.Error(rw, "invalid path", http.StatusBadRequest)
		return
	}
	if canonical != req.URL.Path {
		req.URL.Path = canonical
		req.URL.RawPath = ""
	}

	// Every request gets an id that ties the access record, the WAF event and
	// the process log together; handlers enrich the note with the reason of a
	// refusal or the upstream outcome.
	reqCtx, requestID, _ := withRequestInfo(req.Context())
	req = req.WithContext(reqCtx)
	if requestID != "" {
		req.Header.Set("X-Request-ID", requestID)
		rw.Header().Set("X-Request-ID", requestID)
	}

	// An ACME http-01 challenge is answered before routing: it belongs to no
	// rule, and the CA only accepts it on port 80, which this listener may own.
	if strings.HasPrefix(req.URL.Path, acmeChallengePath) {
		if provider := rt.web.challengeProvider(); provider != nil && provider.ServeChallenge(rw, req) {
			return
		}
	}

	m := rt.currentMatcher()
	if m == nil {
		http.Error(rw, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	r := m.Match(req.Host, req.URL.Path)
	if r == nil {
		rt.web.logger().Debug("web：没有匹配的路由", "listen", rt.addr, "host", req.Host, "path", req.URL.Path)
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
			rt.web.logger().Error("web：处理请求时发生 panic", "rule", r.name, "path", req.URL.Path, "panic", panicValue)
			if !rec.wrote {
				http.Error(rec, "internal server error", http.StatusInternalServerError)
			}
		}
		rt.web.logAccess(r, req, rec, start)
	}()

	if r.site == nil || r.site.handler == nil {
		rt.web.logger().Warn("web：路由没有可用的处理器", "rule", r.name)
		http.Error(rec, "route is not available", http.StatusServiceUnavailable)
		return
	}
	ctx := withRule(req.Context(), r)
	req = req.WithContext(ctx)

	// HSTS belongs to the listener but is emitted on the matched route.
	if r.hsts && rt.web.isTLSRequest(req) {
		rec.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
	// The chain is built inner to outer: basic auth, WAF, access control and
	// rate limit. Execution therefore runs the rate limit before the password
	// check (a flood must not burn the Argon2 hashing budget) and the access
	// control before the WAF (a denied address costs no inspection).
	handler := r.site.handler
	if r.spec.BasicAuth != nil && r.spec.BasicAuth.Enable {
		handler = rt.web.basicAuthHandler(r, handler)
	}
	handler = rt.web.wafHandler(r, handler)
	handler = rt.web.accessHandler(r, handler)
	if r.limiter != nil {
		handler = rt.web.rateLimitHandler(r, handler)
	}
	handler.ServeHTTP(rec, req)
}

// canonicalPath returns the routing form of a request path: backslashes count
// as separators, duplicate slashes and dot segments collapse, and a trailing
// slash is preserved. A NUL byte is never valid.
func canonicalPath(p string) (string, bool) {
	if strings.ContainsRune(p, 0) {
		return "", false
	}
	if p == "" {
		return "/", true
	}
	p = strings.ReplaceAll(p, "\\", "/")
	cleaned := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if cleaned == "." {
		cleaned = "/"
	}
	if strings.HasSuffix(p, "/") && cleaned != "/" {
		cleaned += "/"
	}
	return cleaned, true
}

// isTLSRequest reports whether the request reached the service over TLS,
// directly or through a proxy that is allowed to assert it. The forwarded
// header counts only from a configured trusted proxy, exactly like the client
// address: a caller that writes its own X-Forwarded-Proto must not be able to
// make the service emit a security header that belongs to a TLS connection it
// never had.
func (w *Web) isTLSRequest(r *http.Request) bool {
	return w.trustPolicy().HTTPS(r)
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
	return clientIPString(req, w.trustPolicy())
}
