package web

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"hash/fnv"
	"math/rand"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/http2"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// Balance strategies supported by a proxy rule.
const (
	balanceRoundRobin = "roundrobin"
	balanceRandom     = "random"
	balanceIPHash     = "iphash"
)

// hopHeaders must never be forwarded by a proxy.
var hopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// upstream is one normalised proxy target.
type upstream struct {
	url    *url.URL
	target string
}

// Health tracking. An upstream is taken out of rotation after this many
// consecutive failures and gets another chance after the cooldown; one success
// (or a successful probe request) puts it back immediately.
const (
	upstreamFailThreshold = 3
	upstreamCooldown      = 30 * time.Second
)

type upstreamHealth struct {
	failures int
	until    time.Time
}

// balancer picks an upstream for every request.
type balancer struct {
	mode      string
	upstreams []upstream
	rr        atomic.Uint64
	mu        sync.Mutex
	rnd       *rand.Rand
	health    map[string]*upstreamHealth
	now       func() time.Time
}

func newBalancer(mode string, targets []string) (*balancer, error) {
	if len(targets) == 0 {
		return nil, errors.New("no upstream target configured")
	}
	b := &balancer{
		mode:   strings.ToLower(strings.TrimSpace(mode)),
		rnd:    rand.New(rand.NewSource(time.Now().UnixNano())),
		health: map[string]*upstreamHealth{},
		now:    time.Now,
	}
	for _, raw := range targets {
		u, err := parseTarget(raw)
		if err != nil {
			return nil, err
		}
		b.upstreams = append(b.upstreams, upstream{url: u, target: u.Scheme + "://" + u.Host})
	}
	switch b.mode {
	case "", balanceRoundRobin:
		b.mode = balanceRoundRobin
	case balanceRandom, balanceIPHash:
	default:
		return nil, fmt.Errorf("unsupported balance strategy %q", mode)
	}
	return b, nil
}

// parseTarget turns a configured target into an absolute URL.
func parseTarget(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("empty proxy target")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	if err := netutil.TargetAllowed(raw); err != nil {
		return nil, err
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse target %q: %w", raw, err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("proxy target %q has no host", raw)
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	return u, nil
}

// pick returns the upstream serving a request, skipping the ones that are
// currently considered down. When every upstream is down the normal choice is
// returned anyway: a proxy that refuses to try is worse than one that tries and
// fails, and it lets the first successful request bring the upstream back.
func (b *balancer) pick(clientIP string) upstream {
	start := b.startIndex(clientIP)
	if up, ok := b.scan(start, ""); ok {
		return up
	}
	// Every upstream looks down: fall back to the strategy's choice so a
	// recovery is noticed instead of the rule refusing to try at all.
	return b.upstreams[start%len(b.upstreams)]
}

// pickExcept is pick with one upstream excluded (used for a retry). It only
// returns an upstream that is currently healthy.
func (b *balancer) pickExcept(clientIP, exclude string) (upstream, bool) {
	return b.scan(b.startIndex(clientIP), exclude)
}

// scan walks the upstream list from start and returns the first healthy entry
// that is not excluded.
func (b *balancer) scan(start int, exclude string) (upstream, bool) {
	for offset := 0; offset < len(b.upstreams); offset++ {
		candidate := b.upstreams[(start+offset)%len(b.upstreams)]
		if candidate.target == exclude {
			continue
		}
		if b.healthy(candidate.target) {
			return candidate, true
		}
	}
	return upstream{}, false
}

// startIndex returns the first candidate of the configured strategy.
func (b *balancer) startIndex(clientIP string) int {
	switch b.mode {
	case balanceRandom:
		b.mu.Lock()
		i := b.rnd.Intn(len(b.upstreams))
		b.mu.Unlock()
		return i
	case balanceIPHash:
		h := fnv.New32a()
		_, _ = h.Write([]byte(clientIP))
		return int(h.Sum32() % uint32(len(b.upstreams)))
	default:
		i := b.rr.Add(1) - 1
		return int(i % uint64(len(b.upstreams)))
	}
}

// healthy reports whether an upstream may receive traffic.
func (b *balancer) healthy(target string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	state, ok := b.health[target]
	if !ok || state.failures < upstreamFailThreshold {
		return true
	}
	return !b.now().Before(state.until)
}

// report records the outcome of one request: consecutive failures open the
// circuit for a cooldown, one success closes it.
func (b *balancer) report(target string, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	state, exists := b.health[target]
	if !exists {
		state = &upstreamHealth{}
		b.health[target] = state
	}
	if ok {
		state.failures = 0
		state.until = time.Time{}
		return
	}
	state.failures++
	if state.failures >= upstreamFailThreshold {
		state.until = b.now().Add(upstreamCooldown)
	}
}

// requestAttempt tracks which upstream is serving the current request, so the
// retry path can hand the report over to the next upstream.
type requestAttempt struct{ target string }

type attemptKey struct{}

func withAttempt(ctx context.Context, target string) (context.Context, *requestAttempt) {
	at := &requestAttempt{target: target}
	return context.WithValue(ctx, attemptKey{}, at), at
}

func attemptFrom(ctx context.Context) *requestAttempt {
	at, _ := ctx.Value(attemptKey{}).(*requestAttempt)
	return at
}

type balancerKey struct{}

func withBalancer(ctx context.Context, b *balancer) context.Context {
	return context.WithValue(ctx, balancerKey{}, b)
}

func balancerFrom(ctx context.Context) *balancer {
	b, _ := ctx.Value(balancerKey{}).(*balancer)
	return b
}

type retriedKey struct{}

func withRetried(ctx context.Context) context.Context {
	return context.WithValue(ctx, retriedKey{}, true)
}

func alreadyRetried(ctx context.Context) bool {
	v, _ := ctx.Value(retriedKey{}).(bool)
	return v
}

// retryableRequest reports whether a failed request may be sent to another
// upstream: only idempotent methods, only transport failures (a timeout would
// just double the latency) and never an upgraded connection.
func retryableRequest(req *http.Request, err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || req.Context().Err() != nil {
		return false
	}
	if isUpgrade(req) {
		return false
	}
	switch req.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

// addresses lists the configured upstreams for logging and status output.
func (b *balancer) addresses() []string {
	out := make([]string, 0, len(b.upstreams))
	for _, u := range b.upstreams {
		out = append(out, u.target)
	}
	return out
}

// rewritePath applies the PathPrefix/PathReplace pair of a rule.
func rewritePath(p, prefix, replacement string) string {
	if prefix == "" {
		if replacement == "" {
			return p
		}
		return joinURLPath(replacement, p)
	}
	if !strings.HasPrefix(p, prefix) {
		return p
	}
	return joinURLPath(replacement, strings.TrimPrefix(p, prefix))
}

// joinURLPath joins two URL paths keeping exactly one separating slash.
func joinURLPath(a, b string) string {
	switch {
	case a == "":
		if b == "" {
			return "/"
		}
		return b
	case b == "":
		return a
	case strings.HasSuffix(a, "/") && strings.HasPrefix(b, "/"):
		return a + b[1:]
	case !strings.HasSuffix(a, "/") && !strings.HasPrefix(b, "/"):
		return a + "/" + b
	default:
		return a + b
	}
}

// proxySite builds the reverse proxy handler of a rule.
func (w *Web) proxySite(r *rule, cfg *model.Config) (*webSite, error) {
	target := r.spec.Proxy
	bal, err := newBalancer(target.Balance, target.Targets)
	if err != nil {
		return nil, fmt.Errorf("rule %q: %w", r.name, err)
	}

	cors := newCORSPolicy(target.CORS)

	var handler http.Handler = http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		// CORS runs before anything that reads the body: a preflight has no
		// body and must be answered without touching the upstream.
		if cors != nil && cors.applyCORS(rw, req) {
			return
		}
		// The body limit is applied here, right in front of the upstream, so a
		// request that the WAF already inspected is not read twice.
		if !w.capRequestBody(rw, r, req) {
			return
		}
		up := bal.pick(clientIPString(req, w.trustProxy(cfg)))
		ctx, attempt := withAttempt(req.Context(), up.target)
		ctx = withBalancer(ctx, bal)
		req = req.WithContext(ctx)
		req = req.WithContext(withUpstream(req.Context(), up.target))

		rec := &accessRecorder{ResponseWriter: rw}
		proxyFor(w, r, up, target).ServeHTTP(rec, req)
		// 502/503/504 mean the upstream was unreachable or refused to serve;
		// anything else is a real answer and closes the circuit again.
		status := rec.status
		bal.report(attempt.target, status < 502 || status > 504)
	})

	return &webSite{handler: handler, upstreams: bal.addresses()}, nil
}

// proxyCache stores one reverse proxy per upstream so that connection pools
// survive configuration reloads.
var proxyCache sync.Map // cache key -> *httputil.ReverseProxy

// pruneProxyCache drops the cached proxies the current rule set can no longer
// use and closes their idle connections. Entries that a surviving rule still
// reaches are kept, so a reload does not throw away healthy connection pools.
func pruneProxyCache(rules []*rule) {
	live := make(map[string]bool, len(rules))
	for _, r := range rules {
		if r.spec == nil || r.spec.Proxy == nil {
			continue
		}
		target := r.spec.Proxy
		for _, raw := range target.Targets {
			u, err := parseTarget(raw)
			if err != nil {
				continue
			}
			live[proxyCacheKey(r.id, u.Scheme+"://"+u.Host, target)] = true
		}
	}
	proxyCache.Range(func(key, value any) bool {
		cacheKey, _ := key.(string)
		if live[cacheKey] {
			return true
		}
		if p, ok := value.(*httputil.ReverseProxy); ok {
			closeIdleConnections(p.Transport)
		}
		proxyCache.Delete(key)
		return true
	})
}

// closeIdleConnections releases the pooled connections of a transport.
func closeIdleConnections(rt http.RoundTripper) {
	switch t := rt.(type) {
	case *http.Transport:
		t.CloseIdleConnections()
	case *http2.Transport:
		t.CloseIdleConnections()
	}
}

// proxyFor returns the cached reverse proxy of one upstream.
func proxyFor(w *Web, r *rule, up upstream, target *model.ProxyTarget) *httputil.ReverseProxy {
	key := proxyCacheKey(r.id, up.target, target)
	if cached, ok := proxyCache.Load(key); ok {
		return cached.(*httputil.ReverseProxy)
	}
	actual, loaded := proxyCache.LoadOrStore(key, buildProxy(w, r, up, target))
	if loaded {
		return actual.(*httputil.ReverseProxy)
	}
	return actual.(*httputil.ReverseProxy)
}

func proxyCacheKey(id, target string, t *model.ProxyTarget) string {
	parts := []string{
		id, target, t.HostHeader, t.PathPrefix, t.PathReplace,
		fmt.Sprint(t.TimeoutSec), fmt.Sprint(t.InsecureTLS), fmt.Sprint(t.DisableCompres),
	}
	parts = append(parts, headerPairs(t.Headers)...)
	parts = append(parts, headerPairs(t.RespHeaders)...)
	return strings.Join(parts, "|")
}

func headerPairs(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func buildProxy(w *Web, r *rule, up upstream, target *model.ProxyTarget) *httputil.ReverseProxy {
	timeout := time.Duration(target.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: timeout,
		// Suppress the transport generated Accept-Encoding so an upstream
		// response is never transparently decompressed.
		DisableCompression: target.DisableCompres,
	}
	if target.InsecureTLS {
		// #nosec G402 - explicit opt-in per rule.
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}

	var rt http.RoundTripper = transport
	if target.H2C && up.url != nil && up.url.Scheme == "http" {
		rt = newH2CTransport(timeout)
	}

	return &httputil.ReverseProxy{
		Transport:     rt,
		FlushInterval: 100 * time.Millisecond,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(up.url)
			// SetURL deletes the inbound Host, so restore the original one and
			// let the rule override it when configured.
			pr.Out.Host = outboundHost(pr, target, up)
			// Rewrite mode clears the forwarding headers, so they have to be
			// rebuilt explicitly. The chain of an upstream proxy is kept.
			pr.Out.Header["X-Forwarded-For"] = pr.In.Header.Values("X-Forwarded-For")
			pr.SetXForwarded()
			rewriteOutboundPath(pr.Out, target)
			applyHeaders(pr.Out.Header, target.Headers)
			removeHopHeaders(pr.Out.Header)
			if isUpgrade(pr.In) {
				// Forward the switch request verbatim: WebSocket is the common
				// case but h2c and custom upgrade tokens must work as well.
				pr.Out.Header.Set("Connection", "Upgrade")
				pr.Out.Header.Set("Upgrade", pr.In.Header.Get("Upgrade"))
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			// A 101 response is the protocol switch itself: stripping the
			// hop-by-hop headers here would remove Upgrade/Connection and make
			// the reverse proxy reject its own backend ("backend tried to
			// switch protocol ... when ... was requested").
			if resp.StatusCode != http.StatusSwitchingProtocols {
				removeHopHeaders(resp.Header)
			}
			for k, v := range target.RespHeaders {
				if k = strings.TrimSpace(k); k != "" {
					resp.Header.Set(k, v)
				}
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, err error) {
			if bodyLimitHit(req, err) {
				// The configured cap stopped the upload: the upstream never saw
				// the request and the refusal is already counted.
				http.Error(rw, bodyLimitMessage, http.StatusRequestEntityTooLarge)
				return
			}
			// One retry on another healthy upstream for idempotent requests.
			if bal := balancerFrom(req.Context()); bal != nil && !alreadyRetried(req.Context()) &&
				retryableRequest(req, err) {
				if next, ok := bal.pickExcept(clientIPString(req, w.trustProxy(w.cfg)), up.target); ok {
					bal.report(up.target, false)
					if attempt := attemptFrom(req.Context()); attempt != nil {
						attempt.target = next.target
					}
					w.logger().Warn("web: retrying on another upstream", "rule", r.name,
						"failed", up.target, "next", next.target, "error", err)
					proxyFor(w, r, next, target).ServeHTTP(rw, req.WithContext(withRetried(req.Context())))
					return
				}
			}
			status := http.StatusBadGateway
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
			}
			w.logger().Warn("web: upstream request failed", "rule", r.name, "upstream", up.target,
				"method", req.Method, "path", req.URL.Path, "error", err)
			rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
			rw.WriteHeader(status)
			_, _ = rw.Write([]byte(http.StatusText(status)))
		},
	}
}

func outboundHost(pr *httputil.ProxyRequest, target *model.ProxyTarget, up upstream) string {
	if h := strings.TrimSpace(target.HostHeader); h != "" {
		return h
	}
	if h := headerValue(target.Headers, "host"); h != "" {
		return h
	}
	if pr.In != nil && pr.In.Host != "" {
		return pr.In.Host
	}
	return up.url.Host
}

// rewriteOutboundPath applies the PathPrefix/PathReplace pair to the outgoing
// request. URL.RawPath is dropped because the configured prefix and the
// replacement are plain paths, so net/http escapes the result itself.
func rewriteOutboundPath(out *http.Request, target *model.ProxyTarget) {
	if target.PathPrefix == "" && target.PathReplace == "" {
		return
	}
	out.URL.Path = rewritePath(out.URL.Path, target.PathPrefix, target.PathReplace)
	if out.URL.Path == "" {
		out.URL.Path = "/"
	}
	out.URL.RawPath = ""
}

func applyHeaders(h http.Header, extra map[string]string) {
	for k, v := range extra {
		if strings.EqualFold(strings.TrimSpace(k), "host") {
			continue // handled through Request.Host
		}
		h.Set(k, v)
	}
}

func headerValue(m map[string]string, name string) string {
	for k, v := range m {
		if strings.EqualFold(strings.TrimSpace(k), name) {
			return v
		}
	}
	return ""
}

func removeHopHeaders(h http.Header) {
	for _, c := range h.Values("Connection") {
		for _, f := range strings.Split(c, ",") {
			if f = strings.TrimSpace(f); f != "" {
				h.Del(f)
			}
		}
	}
	for _, k := range hopHeaders {
		h.Del(k)
	}
}

// h2cServer serves cleartext HTTP/2 on the plain listeners.
var h2cServer = &http2.Server{}

// newH2CTransport builds a transport that speaks HTTP/2 over plain TCP to an
// upstream, which is what native (non TLS) gRPC servers require.
func newH2CTransport(timeout time.Duration) *http2.Transport {
	return &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}
}

// isUpgrade reports whether the request asks for a protocol switch. Any
// token is accepted (websocket, h2c, custom tunnels); the proxy forwards it
// unchanged instead of hard coding WebSocket.
func isUpgrade(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}
