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

// balancer picks an upstream for every request.
type balancer struct {
	mode      string
	upstreams []upstream
	rr        atomic.Uint64
	mu        sync.Mutex
	rnd       *rand.Rand
}

func newBalancer(mode string, targets []string) (*balancer, error) {
	if len(targets) == 0 {
		return nil, errors.New("no upstream target configured")
	}
	b := &balancer{mode: strings.ToLower(strings.TrimSpace(mode)), rnd: rand.New(rand.NewSource(time.Now().UnixNano()))}
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

// pick returns the upstream serving a request.
func (b *balancer) pick(clientIP string) upstream {
	switch b.mode {
	case balanceRandom:
		b.mu.Lock()
		i := b.rnd.Intn(len(b.upstreams))
		b.mu.Unlock()
		return b.upstreams[i]
	case balanceIPHash:
		h := fnv.New32a()
		_, _ = h.Write([]byte(clientIP))
		return b.upstreams[int(h.Sum32()%uint32(len(b.upstreams)))]
	default:
		i := b.rr.Add(1) - 1
		return b.upstreams[int(i%uint64(len(b.upstreams)))]
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

	var handler http.Handler = http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		up := bal.pick(clientIPString(req, w.trustProxy(cfg)))
		req = req.WithContext(withUpstream(req.Context(), up.target))
		proxyFor(w, r, up, target).ServeHTTP(rw, req)
	})

	return &webSite{handler: handler, upstreams: bal.addresses()}, nil
}

// proxyCache stores one reverse proxy per upstream so that connection pools
// survive configuration reloads.
var proxyCache sync.Map // cache key -> *httputil.ReverseProxy

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
