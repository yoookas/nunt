// Package forward implements TCP and UDP port forwarding.
//
// Every enabled model.ForwardRule owns one or two proxies (TCP and/or UDP)
// bound to the rule source address. The module is fully driven by the
// configuration store: Reload diffs the desired rules against the running
// proxies and only opens or closes what actually changed, so a configuration
// write never disturbs unrelated listeners.
package forward

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
)

// Protocols accepted by a forward rule.
const (
	protoTCP  = "tcp"
	protoUDP  = "udp"
	protoBoth = "both"
)

// Tunables of the forwarder.
const (
	defaultTimeoutSec = 300
	minTimeoutSec     = 1
	maxTimeoutSec     = 86400
	defaultLogKeep    = 200
	maxLogKeep        = 5000
	dialTimeout       = 10 * time.Second
	closeGrace        = 5 * time.Second
	udpSessionTTL     = 60 * time.Second
	udpPollInterval   = time.Second
	udpMaxSessions    = 1024
	udpBufferSize     = 64 * 1024
)

// Reasons recorded when a connection is refused by a concurrency limit. The
// same vocabulary is used by the access log and by the rule list API.
const (
	reasonRuleLimit = "rule-limit"
	reasonIPLimit   = "ip-limit"
)

// Forward is the port forwarding module.
type Forward struct {
	module.Base

	deps *module.Deps
	log  *slog.Logger

	// reloadMu serialises listener changes so two concurrent Reload calls can
	// never install the same socket twice.
	reloadMu sync.Mutex
	mu       sync.RWMutex
	// proxies maps a rule id to the proxies it owns: one for tcp or udp, two
	// for a rule that declares "both".
	proxies map[string][]*proxy
	stopped bool
	access  *accessLogger
	cfg     *model.Config
}

// New creates the module.
func New(deps *module.Deps) *Forward {
	f := &Forward{
		deps:    deps,
		proxies: map[string][]*proxy{},
		access:  newAccessLogger(defaultLogKeep),
	}
	f.Init(deps, "forward", "Port forwarding")
	f.log = deps.Logger("forward")
	return f
}

// Start opens every enabled rule.
func (f *Forward) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	f.stopped = false
	f.mu.Unlock()

	f.SetRunning(true)
	f.Reload(f.snapshot())

	f.SetDetail(f.detail())
	return nil
}

// Stop closes every listener and every relayed connection.
func (f *Forward) Stop(ctx context.Context) error {
	f.mu.Lock()
	f.stopped = true
	f.mu.Unlock()

	f.reloadMu.Lock()
	proxies := f.detachAll()
	f.reloadMu.Unlock()

	for _, p := range proxies {
		p.close()
	}
	waitProxies(ctx, proxies)

	f.SetRunning(false)
	f.SetDetail("stopped")
	return nil
}

// Reload applies a new configuration: proxies are added, dropped or replaced
// by rule id, and untouched rules keep their listener.
func (f *Forward) Reload(cfg *model.Config) {
	if cfg == nil {
		cfg = f.snapshot()
	}
	if cfg == nil {
		return
	}
	f.access.apply(cfg.Forward.AccessLog)

	f.reloadMu.Lock()
	defer f.reloadMu.Unlock()

	f.mu.Lock()
	stopped := f.stopped
	f.cfg = cfg
	f.mu.Unlock()
	if stopped {
		return
	}

	desired := map[string]model.ForwardRule{}
	for _, r := range cfg.Forward.Rules {
		if !r.Enable {
			continue
		}
		if _, err := netutil.NormalizeListen(r.SrcAddr); err != nil {
			f.log.Error("forward: rule has an invalid source address",
				"rule", ruleLabel(r), "src", r.SrcAddr, "error", err)
			continue
		}
		desired[r.ID] = r
	}

	var fresh, obsolete []*proxy
	f.mu.Lock()
	for id, r := range desired {
		current := map[string]*proxy{}
		for _, p := range f.proxies[id] {
			current[p.proto] = p
		}
		want := protoList(r.Protocol)
		kept := make([]*proxy, 0, len(want))
		for _, proto := range want {
			prev := current[proto]
			delete(current, proto)
			if prev != nil && prev.fingerprint == fingerprint(r) {
				kept = append(kept, prev)
				continue
			}
			np := newProxyFor(f, r, proto)
			kept = append(kept, np)
			fresh = append(fresh, np)
			if prev != nil {
				obsolete = append(obsolete, prev)
			}
		}
		// Protocols the rule stopped declaring are released.
		for _, p := range current {
			obsolete = append(obsolete, p)
		}
		if len(kept) == 0 {
			delete(f.proxies, id)
			continue
		}
		f.proxies[id] = kept
	}
	for id, proxies := range f.proxies {
		if _, keep := desired[id]; keep {
			continue
		}
		delete(f.proxies, id)
		obsolete = append(obsolete, proxies...)
	}
	f.mu.Unlock()

	for _, p := range obsolete {
		p.close()
	}
	for _, p := range fresh {
		if err := p.start(); err != nil {
			// A busy port must never take the whole module down; the rule is
			// reported as not listening both in the log and in the status.
			f.log.Error("forward: cannot start rule",
				"rule", ruleLabel(p.rule), "protocol", p.proto,
				"src", p.rule.SrcAddr, "dst", p.rule.DstAddr, "error", err)
		}
	}
	f.SetDetail(f.detail())
}

// RegisterAPI mounts the REST endpoints.
func (f *Forward) RegisterAPI(mux *rest.Mux) {
	f.registerAPI(mux)
}

// Status extends the module status with the forwarder statistics.
func (f *Forward) Status() module.Status {
	st := f.Base.Status()
	st.Stats = f.Stats()
	return st
}

// Stats aggregates the counters of every configured rule.
func (f *Forward) Stats() map[string]any {
	f.mu.RLock()
	cfg := f.cfg
	proxies := f.proxiesLocked()
	f.mu.RUnlock()

	total, enabled := 0, 0
	var rules []model.ForwardRule
	if cfg != nil {
		rules = cfg.Forward.Rules
	}
	for _, r := range rules {
		total++
		if r.Enable {
			enabled++
		}
	}

	active, accepted := 0, uint64(0)
	up, down := uint64(0), uint64(0)
	rejectedRule, rejectedIP := uint64(0), uint64(0)
	listening := 0
	for _, p := range proxies {
		active += int(p.active.Load())
		accepted += p.total.Load()
		up += p.upBytes.Load()
		down += p.downBytes.Load()
		rejectedRule += p.rejectedRule.Load()
		rejectedIP += p.rejectedIP.Load()
		if p.isRunning() {
			listening++
		}
	}
	return map[string]any{
		"rules":             total,
		"enabled":           enabled,
		"listening":         listening,
		"activeConnections": active,
		"totalConnections":  accepted,
		"upBytes":           up,
		"downBytes":         down,
		"rejectedRuleLimit": rejectedRule,
		"rejectedIPLimit":   rejectedIP,
		"accessLogEnabled":  f.access.enabledNow(),
	}
}

// Rules returns a copy of the configured forward rules.
func (f *Forward) Rules() []model.ForwardRule {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.cfg == nil {
		return nil
	}
	out := make([]model.ForwardRule, len(f.cfg.Forward.Rules))
	copy(out, f.cfg.Forward.Rules)
	return out
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

func (f *Forward) snapshot() *model.Config {
	if f.deps == nil || f.deps.Cfg == nil {
		return nil
	}
	return f.deps.Cfg.Snapshot()
}

func (f *Forward) detail() string {
	f.mu.RLock()
	cfg := f.cfg
	proxies := f.proxiesLocked()
	f.mu.RUnlock()

	total, enabled := 0, 0
	if cfg != nil {
		total = len(cfg.Forward.Rules)
		enabled = countEnabled(cfg)
	}
	listening := 0
	for _, p := range proxies {
		if p.isRunning() {
			listening++
		}
	}
	if enabled == 0 {
		return fmt.Sprintf("no enabled rule (%d configured)", total)
	}
	return fmt.Sprintf("%d listening of %d enabled rules (%d configured)", listening, enabled, total)
}

func (f *Forward) ruleByID(id, proto string) (model.ForwardRule, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.cfg == nil {
		return model.ForwardRule{}, false
	}
	for _, r := range f.cfg.Forward.Rules {
		if r.ID == id && protocolMatches(r.Protocol, proto) {
			return r, true
		}
	}
	return model.ForwardRule{}, false
}

// ensure lazily starts a proxy for a rule that has not been applied yet. It is
// used by the UDP read path, which resolves the rule before any listener
// exists, and is harmless when the rule is already running.
func (f *Forward) ensure(id, proto string) (*proxy, bool) {
	f.reloadMu.Lock()
	defer f.reloadMu.Unlock()

	f.mu.RLock()
	stopped := f.stopped
	f.mu.RUnlock()
	if stopped {
		return nil, false
	}
	r, ok := f.ruleByID(id, proto)
	if !ok {
		return nil, false
	}
	np := newProxyFor(f, r, proto)
	f.mu.Lock()
	if f.stopped {
		f.mu.Unlock()
		return nil, false
	}
	for _, p := range f.proxies[id] {
		if p.proto == np.proto {
			f.mu.Unlock()
			return nil, false
		}
	}
	f.proxies[id] = append(f.proxies[id], np)
	f.mu.Unlock()
	if err := np.start(); err != nil {
		f.log.Error("forward: cannot start rule on demand",
			"rule", ruleLabel(r), "protocol", proto, "src", r.SrcAddr, "error", err)
		return nil, false
	}
	return np, true
}

// proxiesLocked flattens the proxy table. The caller must hold f.mu.
func (f *Forward) proxiesLocked() []*proxy {
	out := make([]*proxy, 0, len(f.proxies))
	for _, proxies := range f.proxies {
		out = append(out, proxies...)
	}
	return out
}

// proxy returns the running proxy of one rule and protocol (nil when absent).
func (f *Forward) proxy(id, proto string) *proxy {
	f.mu.RLock()
	defer f.mu.RUnlock()
	for _, p := range f.proxies[id] {
		if p.proto == proto {
			return p
		}
	}
	return nil
}

func (f *Forward) detachAll() []*proxy {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*proxy, 0, len(f.proxies))
	for id, proxies := range f.proxies {
		delete(f.proxies, id)
		out = append(out, proxies...)
	}
	return out
}

func countEnabled(cfg *model.Config) int {
	if cfg == nil {
		return 0
	}
	n := 0
	for _, r := range cfg.Forward.Rules {
		if r.Enable {
			n++
		}
	}
	return n
}

func waitProxies(ctx context.Context, proxies []*proxy) {
	if ctx == nil {
		ctx = context.Background()
	}
	done := make(chan struct{})
	go func() {
		for _, p := range proxies {
			p.wait()
		}
		close(done)
	}()
	timer := time.NewTimer(closeGrace + time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-ctx.Done():
	case <-timer.C:
	}
}

// protoList expands the rule protocol into the concrete proxies to run.
func protoList(protocol string) []string {
	switch strings.ToLower(strings.TrimSpace(protocol)) {
	case protoUDP:
		return []string{protoUDP}
	case protoBoth, "":
		return []string{protoTCP, protoUDP}
	default:
		return []string{protoTCP}
	}
}

func protocolMatches(protocol, proto string) bool {
	for _, p := range protoList(protocol) {
		if p == proto {
			return true
		}
	}
	return false
}

// fingerprint captures everything that requires a listener rebuild.
func fingerprint(r model.ForwardRule) string {
	return strings.Join([]string{
		strings.ToLower(strings.TrimSpace(r.Protocol)),
		strings.TrimSpace(r.SrcAddr),
		strings.TrimSpace(r.DstAddr),
		fmt.Sprintf("timeout=%d", timeoutSeconds(r)),
		fmt.Sprintf("limits=%d/%d", maxConns(r), maxConnsPerIP(r)),
		accessFingerprint(r.Access),
	}, "|")
}

func accessFingerprint(a model.Access) string {
	ips := append([]string{}, a.IPs...)
	sort.Strings(ips)
	return strings.Join([]string{a.Mode, strings.Join(ips, ",")}, "~")
}

func timeoutSeconds(r model.ForwardRule) int {
	switch {
	case r.TimeoutSec <= 0:
		return defaultTimeoutSec
	case r.TimeoutSec < minTimeoutSec:
		return minTimeoutSec
	case r.TimeoutSec > maxTimeoutSec:
		return maxTimeoutSec
	default:
		return r.TimeoutSec
	}
}

// maxConns returns the concurrent connection cap of a rule. A rule without a
// configured cap (zero) is never refused by the rule limit.
func maxConns(r model.ForwardRule) int {
	if r.MaxConns < 0 {
		return 0
	}
	return r.MaxConns
}

// maxConnsPerIP returns the cap of concurrent connections a single client
// address may open on the rule.
func maxConnsPerIP(r model.ForwardRule) int {
	if r.MaxConnsPerIP < 0 {
		return 0
	}
	return r.MaxConnsPerIP
}

// sessionLimit returns how many concurrent UDP sessions a rule may keep: its
// own connection cap when one is configured, the built-in guard otherwise so a
// rule can never be abused as a reflection amplifier.
func sessionLimit(r model.ForwardRule) int {
	if n := maxConns(r); n > 0 {
		return n
	}
	return udpMaxSessions
}

// clientIPKey renders a peer address without its port, which is what the per
// address limits count on.
func clientIPKey(addr net.Addr) string {
	if ip := clientIP(addr); ip != nil {
		return ip.String()
	}
	return addrString(addr)
}

func ruleLabel(r model.ForwardRule) string {
	if strings.TrimSpace(r.Name) != "" {
		return r.Name
	}
	return r.ID
}

func clientIP(addr net.Addr) net.IP {
	if addr == nil {
		return nil
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		host = addr.String()
	}
	return net.ParseIP(strings.Trim(host, "[]"))
}
