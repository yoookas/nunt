// Package web implements the web service module: a shared HTTP/HTTPS front
// end that routes requests by listen address, host and path to reverse proxy,
// redirect, static file, file browser and WebDAV rules.
//
// The module owns every listener, applies the access control chain of a rule
// (IP/User-Agent filter, basic authentication, WAF) and keeps a bounded access
// log for the user interface.
package web

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/modules/filebrowser"
	"github.com/nunt/nunt/internal/modules/waf"
	"github.com/nunt/nunt/internal/modules/webdav"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
)

// configWait bounds how long Reload waits for a concurrent reconfiguration.
const configWait = 30 * time.Second

// Web is the web service module.
type Web struct {
	module.Base
	deps *module.Deps
	log  *slog.Logger

	fb  *filebrowser.Service
	dav *webdav.Service
	// waf is the firewall instance registered in the module registry; the web
	// module shares it instead of building a second engine, so the rule level
	// counters land on the instance the admin API and the WAF page report.
	waf *waf.WAF

	mu sync.Mutex
	// rebuildSem serialises reconfigurations. It is a one slot channel rather
	// than a mutex because a caller that gives up waiting must be able to
	// leave the slot alone: a mutex taken by a helper goroutine after the
	// caller timed out would stay locked for the rest of the process.
	rebuildSem chan struct{}
	started    bool
	stopCtx    context.Context
	cancelAll  context.CancelFunc
	wg         sync.WaitGroup

	rules     []*rule
	bindings  map[string]*listener
	tlsAddrs  map[string]bool
	fallback  *listener
	siteCache map[string]cachedSite

	cfgMu sync.RWMutex
	cfg   *model.Config

	countersMu sync.Mutex
	counters   map[string]int64
	total      int64
	// rateLimited and bodyRejected count the requests refused by the proxy
	// limits; they are reported through Stats.
	rateLimited  int64
	bodyRejected int64

	logs *logBuffer
}

// acmeChallengePath is the well known prefix the ACME server queries for an
// http-01 challenge. The web listeners answer it when a certificate order is in
// flight, so the ACME module never has to compete for port 80.
const acmeChallengePath = "/.well-known/acme-challenge/"

// challengeProvider returns the ACME module when it can answer http-01
// challenges through the listeners of this module.
func (w *Web) challengeProvider() module.ChallengeProvider {
	if w.deps == nil || w.deps.Registry == nil {
		return nil
	}
	mod, ok := w.deps.Registry.Get("acme")
	if !ok {
		return nil
	}
	provider, ok := mod.(module.ChallengeProvider)
	if !ok {
		return nil
	}
	return provider
}

// sharedWAF returns the firewall of the module registry. The registry owns the
// instance: it starts, stops and reloads it, and the admin API plus the WAF page
// read its statistics. Sharing it is what makes the rule level counters visible
// in the API; a missing or foreign module leaves the module without a firewall,
// which the middleware treats as "no protection configured".
func sharedWAF(deps *module.Deps) *waf.WAF {
	if deps == nil || deps.Registry == nil {
		return nil
	}
	mod, ok := deps.Registry.Get("waf")
	if !ok {
		return nil
	}
	engine, _ := mod.(*waf.WAF)
	return engine
}

// New creates the module.
func New(deps *module.Deps) *Web {
	cfg := deps.Cfg.Snapshot()
	w := &Web{
		deps:       deps,
		log:        deps.Logger("web"),
		fb:         filebrowser.New(deps),
		dav:        webdav.New(deps),
		waf:        sharedWAF(deps),
		bindings:   map[string]*listener{},
		tlsAddrs:   map[string]bool{},
		siteCache:  map[string]cachedSite{},
		rebuildSem: make(chan struct{}, 1),
		counters:   map[string]int64{},
		logs:       newLogBuffer(cfg.Web.LogKeep),
		stopCtx:    context.Background(),
	}
	w.Init(deps, "web", "Web service")
	w.cfg = cfg
	// Reload is also called by the module registry and by the REST API; the
	// subscription makes sure a configuration change applied elsewhere is
	// picked up even when no explicit reload happens.
	deps.Cfg.Subscribe(func(next *model.Config) { w.Reload(next) })
	return w
}

// Start brings the listeners up. It is safe to call more than once.
func (w *Web) Start(ctx context.Context) error {
	w.mu.Lock()
	if w.cancelAll == nil {
		w.stopCtx, w.cancelAll = context.WithCancel(context.Background())
	}
	base := w.stopCtx
	w.started = true
	w.mu.Unlock()

	if err := w.apply(base, w.snapshot()); err != nil {
		w.SetRunning(true)
		return err
	}
	w.SetRunning(true)
	return nil
}

// Stop closes every listener and waits for the background workers.
func (w *Web) Stop(ctx context.Context) error {
	w.mu.Lock()
	cancel := w.cancelAll
	w.cancelAll = nil
	w.started = false
	w.mu.Unlock()

	// Wait for an in flight reconfiguration, but never forever: a shutdown has
	// to finish even when a previous rebuild is stuck.
	gated := false
	select {
	case w.rebuildSem <- struct{}{}:
		gated = true
	case <-time.After(configWait):
	case <-ctx.Done():
	}
	w.mu.Lock()
	listeners := make([]*listener, 0, len(w.bindings))
	for _, l := range w.bindings {
		listeners = append(listeners, l)
	}
	if w.fallback != nil {
		listeners = append(listeners, w.fallback)
	}
	sites := w.collectSitesLocked()
	w.bindings = map[string]*listener{}
	w.tlsAddrs = map[string]bool{}
	w.fallback = nil
	w.rules = nil
	w.siteCache = map[string]cachedSite{}
	w.mu.Unlock()
	if gated {
		<-w.rebuildSem
	}

	if cancel != nil {
		cancel()
	}
	for _, l := range listeners {
		l.close()
	}
	for _, s := range sites {
		closeSite(s)
	}

	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	w.SetRunning(false)
	w.SetDetail("")
	return nil
}

// Reload applies a new configuration. It never blocks a running listener and
// is safe to call from several goroutines.
func (w *Web) Reload(cfg *model.Config) {
	if cfg == nil {
		return
	}
	w.cfgMu.Lock()
	w.cfg = cfg
	w.cfgMu.Unlock()
	w.logs.resize(cfg.Web.LogKeep)

	w.mu.Lock()
	started := w.started
	base := w.stopCtx
	w.mu.Unlock()
	if !started {
		return
	}
	if err := w.apply(base, cfg); err != nil {
		w.SetError(err)
	}
}

// logger returns the module logger, falling back to the default one so the
// request path can never panic on a half built module.
func (w *Web) logger() *slog.Logger {
	if w.log == nil {
		return slog.Default()
	}
	return w.log
}

// snapshot returns the configuration currently in use.
func (w *Web) snapshot() *model.Config {
	w.cfgMu.RLock()
	defer w.cfgMu.RUnlock()
	return w.cfg
}

// baseContext returns the process context used by background workers.
func (w *Web) baseContext() context.Context {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopCtx == nil {
		return context.Background()
	}
	return w.stopCtx
}

// trustProxy reports whether X-Forwarded-For may be trusted.
func (w *Web) trustProxy(cfg *model.Config) bool {
	if cfg == nil {
		return false
	}
	return cfg.System.TrustProxy
}

// accessLogEnabled reads the access log switch of the live configuration.
func (w *Web) accessLogEnabled() bool {
	cfg := w.snapshot()
	if cfg == nil {
		return true
	}
	return cfg.Web.AccessLog
}

// apply reconciles the running listeners with the wanted rule set.
func (w *Web) apply(ctx context.Context, cfg *model.Config) error {
	if cfg == nil {
		return nil
	}
	// Serialise the reconfiguration. Another rebuild is allowed to finish, but
	// never for longer than configWait, so a caller can not be blocked forever
	// by a stuck listener. Giving up releases nothing, so a late rebuild can
	// never steal the slot from the caller that owns it.
	select {
	case w.rebuildSem <- struct{}{}:
		defer func() { <-w.rebuildSem }()
	case <-time.After(configWait):
		return errors.New("timed out waiting for the previous reconfiguration")
	case <-ctx.Done():
		return ctx.Err()
	}

	compiled, errs := w.compileRules(cfg)
	var ruleErr error
	if len(errs) > 0 {
		w.logger().Warn("web: some rules were skipped", "count", len(errs), "first", errs[0])
		ruleErr = fmt.Errorf("%d web rule(s) are invalid, first: %w", len(errs), errs[0])
	}
	w.resolveCustomCertificates(compiled)

	groups := groupRules(compiled)
	wanted := map[string][]*rule{}
	for addr, rules := range groups {
		if len(rules) == 0 {
			continue
		}
		if _, err := netutil.NormalizeListen(addr); err != nil {
			w.logger().Warn("web: invalid listen address", "addr", addr, "error", err)
			continue
		}
		wanted[addr] = rules
	}

	w.mu.Lock()
	old := w.bindings
	retired := make([]*listener, 0)
	for addr, l := range old {
		if _, keep := wanted[addr]; keep {
			continue
		}
		retired = append(retired, l)
		delete(w.bindings, addr)
		delete(w.tlsAddrs, addr)
	}
	// Fallback socket used by rules that could not bind their address.
	if w.fallback != nil {
		retired = append(retired, w.fallback)
		w.fallback = nil
	}
	previous := w.rules
	w.rules = compiled
	newCounters := map[string]int64{}
	for _, r := range compiled {
		if v, ok := w.counters[r.id]; ok {
			newCounters[r.id] = v
		}
	}
	w.counters = newCounters
	w.mu.Unlock()

	for _, l := range retired {
		l.close()
	}
	w.releaseSites(previous)

	// Handlers of rules that did not change are reused, so a module that opens
	// its storage inside Site is not asked to do it again on every reload.
	keep := make(map[string]bool, len(compiled))
	for _, r := range compiled {
		keep[r.id] = true
		w.reuseSite(r)
	}
	w.mu.Lock()
	dropped := w.forgetSites(keep)
	w.mu.Unlock()

	// Bring the wanted listeners up one by one so that one busy port cannot
	// hide the other rules.
	addrs := make([]string, 0, len(wanted))
	for addr := range wanted {
		addrs = append(addrs, addr)
	}
	sort.Strings(addrs)
	var firstErr error
	for _, addr := range addrs {
		rules := wanted[addr]
		needsTLS := false
		for _, r := range rules {
			if r.tls.mode != model.TLSModeOff {
				needsTLS = true
				break
			}
		}
		m := newMatcher(addr, rules)
		for _, r := range rules {
			if r.site != nil {
				continue
			}
			site, err := w.buildSite(r, cfg)
			if err != nil {
				w.logger().Error("web: cannot prepare a rule", "rule", r.name, "error", err)
				if firstErr == nil {
					firstErr = fmt.Errorf("rule %q: %w", r.name, err)
				}
				continue
			}
			r.site = site
		}
		for _, r := range rules {
			w.mu.Lock()
			w.storeSite(r)
			w.mu.Unlock()
		}

		w.mu.Lock()
		l := w.bindings[addr]
		w.mu.Unlock()
		if l != nil {
			l.router.setMatcher(m)
			if needsTLS && !w.tlsAddrs[addr] {
				// TLS was enabled for an existing socket: restart it.
				l.close()
				w.mu.Lock()
				delete(w.bindings, addr)
				w.mu.Unlock()
				l = nil
			} else {
				w.mu.Lock()
				w.tlsAddrs[addr] = needsTLS
				w.mu.Unlock()
			}
		}
		if l == nil {
			nl := w.newListener(ctx, addr)
			if err := nl.start(m, needsTLS); err != nil {
				w.logger().Error("web: cannot start listener", "addr", addr, "error", err)
				if firstErr == nil {
					firstErr = err
				}
				w.mu.Lock()
				w.fallback = w.ensureFallbackLocked(ctx)
				w.mu.Unlock()
				continue
			}
			w.mu.Lock()
			w.bindings[addr] = nl
			w.tlsAddrs[addr] = needsTLS
			w.mu.Unlock()
		}
		w.ensureCertificates(m)
	}

	w.mu.Lock()
	total := len(w.bindings)
	w.mu.Unlock()
	w.SetDetail(fmt.Sprintf("%d listener(s), %d rule(s)", total, len(compiled)))

	// Handlers of removed rules are released without closing their storage:
	// a request that is already running may still read from it. Stop and
	// Mounts.Invalidate release the file systems themselves.
	for _, s := range dropped {
		s.detach()
	}

	// The most useful error wins: an unusable rule explains a missing site
	// better than a listener that could not bind.
	switch {
	case ruleErr != nil:
		w.SetError(ruleErr)
		return ruleErr
	default:
		w.SetError(firstErr)
		return firstErr
	}
}

// ensureFallbackLocked returns the socket that answers requests which no rule
// serves. The caller holds the web mutex.
func (w *Web) ensureFallbackLocked(ctx context.Context) *listener {
	if w.fallback != nil {
		return w.fallback
	}
	l := w.newListener(ctx, ":0")
	m := newMatcher("", nil)
	l.router.setMatcher(m)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		w.logger().Error("web: cannot open the fallback listener", "error", err)
		return nil
	}
	l.addr = ln.Addr().String()
	l.mu.Lock()
	l.plain = ln
	l.mu.Unlock()
	go l.serve(ln, "http")
	w.logger().Info("web: fallback listener ready", "addr", l.addr)
	return l
}

// compileRules turns the enabled rules of a configuration into runtime rules.
func (w *Web) compileRules(cfg *model.Config) ([]*rule, []error) {
	compiled := make([]*rule, 0, len(cfg.Web.Rules))
	var errs []error
	for i, raw := range cfg.Web.Rules {
		if !raw.Enable {
			continue
		}
		r, err := compileRule(raw, i)
		if err != nil {
			errs = append(errs, fmt.Errorf("rule %q: %w", displayRuleName(raw), err))
			continue
		}
		compiled = append(compiled, r)
	}
	return compiled, errs
}

// collectSitesLocked gathers the resources of every live rule. The caller
// holds the web mutex.
func (w *Web) collectSitesLocked() []*webSite {
	out := make([]*webSite, 0, len(w.rules))
	for _, r := range w.rules {
		if r.site != nil {
			out = append(out, r.site)
		}
	}
	return out
}

// releaseSites detaches the sites of rules that are gone. The storage of a
// static rule stays open because a request that is already being served may
// still read from it; Mounts.Invalidate and Stop release it instead.
func (w *Web) releaseSites(rules []*rule) {
	for _, r := range rules {
		if r.site != nil {
			r.site.detach()
			r.site = nil
		}
	}
}

// closeSite releases every resource of a site.
func closeSite(s *webSite) {
	if s != nil {
		s.close()
	}
}

// Listeners returns the addresses the module currently serves.
func (w *Web) Listeners() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, 0, len(w.bindings))
	for addr := range w.bindings {
		out = append(out, addr)
	}
	sort.Strings(out)
	return out
}

// Stats implements the module statistics contract.
func (w *Web) Stats() map[string]any {
	w.mu.Lock()
	listeners := len(w.bindings)
	rules := len(w.rules)
	w.mu.Unlock()

	w.countersMu.Lock()
	total := w.total
	rateLimited := w.rateLimited
	bodyRejected := w.bodyRejected
	perRule := make(map[string]int64, len(w.counters))
	for id, n := range w.counters {
		perRule[id] = n
	}
	w.countersMu.Unlock()

	base := w.Base.Status()
	stats := map[string]any{
		"listeners":    listeners,
		"rules":        rules,
		"requests":     total,
		"ruleRequests": perRule,
		"rateLimited":  rateLimited,
		"bodyRejected": bodyRejected,
		"addresses":    w.Listeners(),
		"lastError":    base.Error,
		"upstreams":    w.upstreams(),
	}
	return stats
}

// upstreams lists the configured reverse proxy targets per rule.
func (w *Web) upstreams() map[string][]string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := map[string][]string{}
	for _, r := range w.rules {
		if r.site != nil && len(r.site.upstreams) > 0 {
			out[r.id] = r.site.upstreams
		}
	}
	return out
}

// Status reports the module state with the web specific statistics.
func (w *Web) Status() module.Status {
	st := w.Base.Status()
	st.Stats = w.Stats()
	return st
}

// RegisterAPI mounts the REST endpoints.
func (w *Web) RegisterAPI(mux *rest.Mux) {
	w.registerAPI(mux)
}

// countRequest records one request for the statistics.
func (w *Web) countRequest(r *rule) {
	if r == nil {
		return
	}
	w.countersMu.Lock()
	if w.counters == nil {
		w.counters = map[string]int64{}
	}
	w.counters[r.id]++
	w.total++
	w.countersMu.Unlock()
}
