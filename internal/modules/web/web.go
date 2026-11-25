// Package web implements the web service module: a shared HTTP/HTTPS front
// end that routes requests by listen address, host and path to reverse proxy,
// redirect and static file rules.
//
// The module owns every listener, applies the access control chain of a rule
// (IP/User-Agent filter, basic authentication, WAF) and keeps a bounded access
// log for the user interface.
package web

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/ipfilter"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/modules/waf"
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

// tlsChallengeProvider returns the ACME module when it can answer tls-alpn-01
// challenges on the TLS listeners of this module.
func (w *Web) tlsChallengeProvider() module.TLSChallengeProvider {
	if w.deps == nil || w.deps.Registry == nil {
		return nil
	}
	mod, ok := w.deps.Registry.Get("acme")
	if !ok {
		return nil
	}
	provider, ok := mod.(module.TLSChallengeProvider)
	if !ok {
		return nil
	}
	return provider
}

// alpnChallengeConfig asks the ACME module for the answer of a tls-alpn-01
// handshake. The TLS config installed by tlsSetup consults it before selecting
// a rule certificate, the same way Caddy and Traefik multiplex the challenge.
func (w *Web) alpnChallengeConfig(hello *tls.ClientHelloInfo) (*tls.Config, bool) {
	provider := w.tlsChallengeProvider()
	if provider == nil {
		return nil, false
	}
	return provider.ALPNChallengeConfig(hello)
}

// servesOnPort reports whether a listener of the given kind is bound to port.
func (w *Web) servesOnPort(port string, withTLS bool) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.started {
		return false
	}
	for addr, hasTLS := range w.tlsAddrs {
		if hasTLS != withTLS {
			continue
		}
		if _, p, err := net.SplitHostPort(addr); err == nil && p == port {
			return true
		}
	}
	return false
}

// ServesHTTPChallenge reports whether a plain listener on port 80 is running.
func (w *Web) ServesHTTPChallenge() bool { return w.servesOnPort("80", false) }

// ServesTLSChallenge reports whether a TLS listener on port 443 is running.
func (w *Web) ServesTLSChallenge() bool { return w.servesOnPort("443", true) }

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
		waf:        sharedWAF(deps),
		bindings:   map[string]*listener{},
		tlsAddrs:   map[string]bool{},
		siteCache:  map[string]cachedSite{},
		rebuildSem: make(chan struct{}, 1),
		counters:   map[string]int64{},
		logs:       newLogBuffer(cfg.Web.LogKeep),
		stopCtx:    context.Background(),
	}
	w.Init(deps, "web", "Web 服务")
	w.cfg = cfg
	// Every configuration change is followed by exactly one Reload: the module
	// API calls it directly, and the settings/import paths go through
	// app.Reload. Subscribing here as well would rebuild every listener twice.
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
	sites := w.collectSitesLocked()
	w.bindings = map[string]*listener{}
	w.tlsAddrs = map[string]bool{}
	w.rules = nil
	w.siteCache = map[string]cachedSite{}
	w.mu.Unlock()
	if gated {
		<-w.rebuildSem
	}

	if cancel != nil {
		cancel()
	}
	// Listeners drain in parallel: each one waits up to shutdownTimeout for its
	// in flight requests, and the shutdown context (the caller's budget) caps
	// the whole group. Draining them one after another would add up to
	// listeners × timeout, which is exactly what docker's grace period kills.
	var closing sync.WaitGroup
	for _, l := range listeners {
		closing.Add(1)
		go func(l *listener) {
			defer closing.Done()
			l.closeWithin(ctx, shutdownTimeout)
		}(l)
	}
	closing.Wait()
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

	compiled, plans, errs := w.compileWeb(cfg)
	var ruleErr error
	if len(errs) > 0 {
		w.logger().Warn("web：部分路由被跳过", "count", len(errs), "first", errs[0])
		ruleErr = fmt.Errorf("%d web route(s) are invalid, first: %w", len(errs), errs[0])
	}
	w.resolveCustomCertificates(plans)

	wanted := map[string]*listenerPlan{}
	for addr, plan := range plans {
		if len(plan.rules) > 0 {
			wanted[addr] = plan
		}
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
	w.forgetSites(keep)
	w.mu.Unlock()

	// Bring the wanted listeners up one by one so that one busy port cannot
	// hide the other rules.
	addrs := make([]string, 0, len(wanted))
	for addr := range wanted {
		addrs = append(addrs, addr)
	}
	sort.Strings(addrs)
	var firstErr error
	disabled := 0
	for _, addr := range addrs {
		plan := wanted[addr]
		tlsOn := plan.tls.mode != model.TLSModeOff
		for _, r := range plan.rules {
			if r.site != nil {
				continue
			}
			site, err := w.buildSite(r, cfg)
			if err != nil {
				w.logger().Error("web：无法准备路由", "route", r.name, "error", err)
				if firstErr == nil {
					firstErr = fmt.Errorf("route %q: %w", r.name, err)
				}
				continue
			}
			r.site = site
		}
		for _, r := range plan.rules {
			w.mu.Lock()
			w.storeSite(r)
			w.mu.Unlock()
		}

		m := newMatcher(addr, plan.rules, plan.tls)
		w.mu.Lock()
		l := w.bindings[addr]
		oldTLS := w.tlsAddrs[addr]
		w.mu.Unlock()
		if l != nil {
			l.router.setMatcher(m)
			l.router.setPlan(plan)
			if tlsOn != oldTLS {
				// The listener switched between plain and TLS: the socket has to
				// be rebound.
				l.close()
				w.mu.Lock()
				delete(w.bindings, addr)
				w.mu.Unlock()
				l = nil
			} else {
				w.mu.Lock()
				w.tlsAddrs[addr] = tlsOn
				w.mu.Unlock()
			}
		}
		if l == nil {
			nl := w.newListener(ctx, addr)
			if err := nl.start(plan); err != nil {
				// The port is taken (or cannot be bound). Take the listener out
				// of service instead of retrying on every reload: the operator
				// has to enable it again by hand.
				w.logger().Error("web：监听器启动失败，已自动停用",
					"addr", addr, "listeners", plan.listeners, "error", err)
				w.disableListeners(plan.listeners)
				disabled++
				continue
			}
			w.mu.Lock()
			w.bindings[addr] = nl
			w.tlsAddrs[addr] = tlsOn
			w.mu.Unlock()
		}
		w.ensureCertificates(plan)
	}

	// Release the cached proxies of rules that are gone or whose upstream
	// configuration changed, so a long lived process does not keep every
	// upstream it has ever served.
	pruneProxyCache(compiled)

	w.mu.Lock()
	total := len(w.bindings)
	w.mu.Unlock()
	detail := fmt.Sprintf("%d listener(s), %d rule(s)", total, len(compiled))
	if disabled > 0 {
		detail += fmt.Sprintf(", %d disabled", disabled)
	}
	w.SetDetail(detail)
	if disabled > 0 {
		// The disabled flags were written to the store while this pass was
		// already running; keep the module's view of the configuration in
		// sync so the API reports them immediately.
		if snap := w.deps.Cfg.Snapshot(); snap != nil {
			w.cfgMu.Lock()
			w.cfg = snap
			w.cfgMu.Unlock()
		}
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

// disableListeners marks the listeners that claim an address as disabled and
// persists that, so a taken port is not retried on every reload or restart.
func (w *Web) disableListeners(ids []string) {
	if len(ids) == 0 || w.deps == nil || w.deps.Cfg == nil {
		return
	}
	now := time.Now()
	err := w.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.Web.Listeners {
			for _, id := range ids {
				if c.Web.Listeners[i].ID != id {
					continue
				}
				c.Web.Listeners[i].Disabled = true
				c.Web.Listeners[i].UpdatedAt = now
			}
		}
		return nil
	})
	if err != nil {
		w.logger().Error("web：无法停用监听器", "listeners", ids, "error", err)
		return
	}
	w.logger().Warn("web：监听器已自动停用，请处理端口占用后手动启用", "listeners", ids)
}

// compileWeb turns listeners and routes into one plan per listen address.
func (w *Web) compileWeb(cfg *model.Config) ([]*rule, map[string]*listenerPlan, []error) {
	plans := map[string]*listenerPlan{}
	byListener := map[string][]*listenerPlan{}
	listenerAccess := map[string]model.Access{}
	for _, l := range cfg.Web.Listeners {
		listenerAccess[l.ID] = l.Access
	}
	var errs []error
	for _, l := range cfg.Web.Listeners {
		if l.Disabled {
			continue
		}
		tls := listenerTLS{
			mode:   normalizeTLSMode(l.TLS.Mode),
			certID: strings.TrimSpace(l.TLS.CertID),
			hsts:   l.TLS.HSTS,
		}
		if auth, on := clientAuthFor(l.TLS.ClientAuth); on {
			pool, err := clientCAPool(l.TLS.ClientCA)
			if err != nil {
				// Never fail open: a listener that promises client
				// certificates must not start without the CA that verifies
				// them. Refuse this listener and surface the error instead.
				w.logger().Error("web：客户端证书配置无效，监听器未启动", "listener", l.Name, "error", err)
				errs = append(errs, fmt.Errorf("listener %q: %w", l.Name, err))
				w.SetError(fmt.Errorf("listener %q: %w", l.Name, err))
				continue
			}
			tls.clientAuth = auth
			tls.clientCAs = pool
		}
		seen := map[string]bool{}
		for _, addr := range l.Listen {
			norm, err := netutil.NormalizeListen(addr)
			if err != nil {
				continue
			}
			if seen[norm] {
				continue
			}
			seen[norm] = true
			p := &listenerPlan{addr: norm, tls: tls, listeners: []string{l.ID}}
			plans[norm] = p
			byListener[l.ID] = append(byListener[l.ID], p)
		}
	}

	compiled := make([]*rule, 0, len(cfg.Web.Rules))
	for i, raw := range cfg.Web.Rules {
		if !raw.Enable {
			continue
		}
		r, err := compileRule(raw, i)
		if err != nil {
			errs = append(errs, fmt.Errorf("route %q: %w", displayRuleName(raw), err))
			continue
		}
		// A route with mode "inherit" uses the access rule of its listener;
		// any other mode is the route's own rule.
		access := raw.Access
		if access.Mode == model.AccessInherit {
			access = listenerAccess[raw.ListenerID]
		}
		filter, err := ipfilter.Compile(access, w.deps.Geo)
		if err != nil {
			errs = append(errs, fmt.Errorf("route %q: %w", displayRuleName(raw), err))
			continue
		}
		r.filter = filter
		r.spec.Access = access

		list := byListener[raw.ListenerID]
		if len(list) == 0 {
			errs = append(errs, fmt.Errorf("route %q: listener %q has no usable listen address", displayRuleName(raw), raw.ListenerID))
			continue
		}
		r.listenerID = raw.ListenerID
		if list[0].tls.mode == model.TLSModeAuto {
			for _, d := range r.domains {
				if d == "*" || strings.HasPrefix(d, "~") {
					continue
				}
				r.certDomains = append(r.certDomains, d)
			}
			if len(r.certDomains) == 0 {
				errs = append(errs, fmt.Errorf("route %q: automatic TLS needs at least one concrete domain", displayRuleName(raw)))
				continue
			}
		}
		r.hsts = list[0].tls.hsts
		for _, p := range list {
			p.rules = append(p.rules, r)
		}
		compiled = append(compiled, r)
	}
	return compiled, plans, errs
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

// releaseSites drops the sites of rules that are gone. The storage of a static
// rule stays open because a request that is already being served may still read
// from it; Stop closes it.
func (w *Web) releaseSites(rules []*rule) {
	for _, r := range rules {
		r.site = nil
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
