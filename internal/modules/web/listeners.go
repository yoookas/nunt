package web

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/http2/h2c"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// Listener timeouts. ReadTimeout stays generous enough for slow mobile
// clients while WriteTimeout is deliberately unset so that WebSocket tunnels
// and long lived streams are never cut in the middle of a session.
const (
	readHeaderTimeout = 15 * time.Second
	readTimeout       = 60 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 10 * time.Second
)

// siteMux hands every request to the rule matcher. Since Go 1.22 the standard
// http.ServeMux matches on the Host header, which would let a request for an
// unconfigured host bypass the module router and be answered with the mux own
// 404. Routing here is done by domain and path, never by http pattern.
type siteMux struct {
	handler http.Handler
}

// ServeHTTP implements http.Handler.
func (m *siteMux) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	m.handler.ServeHTTP(rw, req)
}

// Handle satisfies the http.Handler registration interface; the server only
// ever registers the root pattern.
func (m *siteMux) Handle(_ string, handler http.Handler) {
	if handler != nil {
		m.handler = handler
	}
}

// listener owns the sockets of one listen address.
type listener struct {
	web  *Web
	addr string

	server *http.Server
	router *router

	mu      sync.Mutex
	plain   net.Listener
	secure  net.Listener
	cancel  context.CancelFunc
	baseCtx context.Context
	closed  bool
}

// newListener prepares the server of one address.
func (w *Web) newListener(ctx context.Context, addr string) *listener {
	baseCtx, cancel := context.WithCancel(ctx)
	router := newRouter(w, addr)
	mux := &siteMux{handler: router}
	mux.Handle("/", router)
	server := &http.Server{
		// h2c lets cleartext HTTP/2 clients (native gRPC without TLS) reach
		// the virtual hosts. Plain HTTP/1.1 and WebSocket upgrades are left
		// alone: the wrapper only reacts to the HTTP/2 preface and to
		// "Upgrade: h2c".
		Handler:           h2c.NewHandler(mux, h2cServer),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      0, // WebSocket and streaming responses
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    1 << 20,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
		ErrorLog:          slog.NewLogLogger(w.logger().Handler(), slog.LevelDebug),
	}
	return &listener{
		web:     w,
		addr:    addr,
		server:  server,
		router:  router,
		cancel:  cancel,
		baseCtx: baseCtx,
	}
}

// start binds the sockets. When tlsRules is true the address also gets a TLS
// socket, so a rule with TLS enabled can share the port with plain HTTP rules.
func (l *listener) start(m *matcher, tlsRules bool) error {
	l.router.setMatcher(m)

	// A TCP address can only be bound once (Go does not set SO_REUSEPORT), so
	// the plain socket is only opened when at least one rule on this address
	// does not terminate TLS. Opening both would make the TLS bind fail and
	// silently downgrade an HTTPS port to HTTP.
	plainNeeded := len(m.tlsRules) < len(m.rules)
	if plainNeeded {
		plain, err := listenWithRetry(l.addr)
		if err != nil {
			l.cancel()
			return fmt.Errorf("listen on %s: %w", l.addr, err)
		}
		l.mu.Lock()
		l.plain = plain
		l.mu.Unlock()
		go l.serve(plain, "http")
	}

	if !tlsRules {
		if !plainNeeded {
			l.cancel()
			return fmt.Errorf("listen on %s: no rule can be served", l.addr)
		}
		return nil
	}
	tlsCfg := l.web.tlsConfig(m)
	secure, err := listenWithRetry(l.addr)
	if err != nil {
		// The TLS socket is a bonus: the plain socket keeps serving.
		l.web.log.Error("web: cannot listen for TLS", "addr", l.addr, "error", err)
		l.web.SetError(fmt.Errorf("listen for TLS on %s: %w", l.addr, err))
		return nil
	}
	l.mu.Lock()
	l.secure = secure
	l.mu.Unlock()
	go l.serve(tls.NewListener(secure, tlsCfg), "https")
	l.web.log.Info("web: listener ready", "addr", l.addr, "tls", true, "rules", len(m.rules))
	return nil
}

func (l *listener) serve(ln net.Listener, scheme string) {
	err := l.server.Serve(ln)
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !isClosedError(err) {
		l.web.log.Error("web: listener stopped", "addr", l.addr, "scheme", scheme, "error", err)
		l.web.SetError(fmt.Errorf("listener %s (%s): %w", l.addr, scheme, err))
	}
}

// close shuts the sockets down and waits for in flight requests.
func (l *listener) close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	plain, secure := l.plain, l.secure
	l.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := l.server.Shutdown(ctx); err != nil {
		_ = l.server.Close()
	}
	if plain != nil {
		_ = plain.Close()
	}
	if secure != nil {
		_ = secure.Close()
	}
	l.cancel()
}

// health reports whether the listener still owns a socket.
func (l *listener) health() (plainOK, secureOK bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.plain != nil && !l.closed, l.secure != nil && !l.closed
}

// listenWithRetry binds an address again for a short while when the port is
// still busy. Reconfiguring a listener closes one socket and opens another on
// the same port, which can fail with "address already in use" for a moment.
func listenWithRetry(addr string) (net.Listener, error) {
	const attempts = 5
	delay := 20 * time.Millisecond
	var err error
	for i := 0; i < attempts; i++ {
		var ln net.Listener
		ln, err = net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		if !isAddrInUse(err) {
			return nil, err
		}
		time.Sleep(delay)
		delay *= 2
	}
	return nil, err
}

func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "address already in use") ||
		strings.Contains(strings.ToLower(err.Error()), "only one usage of each socket address")
}

func isClosedError(err error) bool {
	return errors.Is(err, net.ErrClosed) || strings.Contains(err.Error(), "use of closed network connection")
}

// tlsConfig builds the TLS configuration of a listener, including per rule
// certificate selection.
func (w *Web) tlsConfig(m *matcher) *tls.Config {
	base := &tls.Config{MinVersion: tls.VersionTLS12}
	if w.deps.Certs != nil {
		base = w.deps.Certs.TLSConfig()
	}
	return w.tlsSetup(m, base)
}

// resolveCustomCertificates loads the certificates referenced by rules that
// pin one explicitly. Failures are reported through the rule status instead of
// stopping the listener.
func (w *Web) resolveCustomCertificates(rules []*rule) {
	for _, r := range rules {
		if r.tls.mode != model.TLSModeCustom || w.deps.Certs == nil {
			continue
		}
		info, ok := w.deps.Certs.Get(r.tls.certID)
		if !ok {
			w.logger().Error("web: certificate not found", "rule", r.name, "certificate", r.tls.certID)
			w.SetError(fmt.Errorf("rule %q: certificate %q does not exist", r.name, r.tls.certID))
			continue
		}
		r.tls.certDomains = append([]string{}, info.Domains...)
		if len(r.tls.certDomains) == 0 {
			r.tls.certDomains = []string{info.ID}
		}
	}
}

// groupRules splits the enabled rules by listen address. Addresses that
// resolve to the same socket (":80", "0.0.0.0:80", "[::]:80") share one
// listener; the first spelling in the configuration names the group.
func groupRules(rules []*rule) map[string][]*rule {
	out := map[string][]*rule{}
	for _, r := range rules {
		for _, addr := range r.spec.Listen {
			normalized, err := netutil.NormalizeListen(addr)
			if err != nil {
				continue
			}
			key, list := findListenGroup(out, normalized)
			if containsRule(list, r) {
				continue
			}
			out[key] = append(list, r)
		}
	}
	return out
}

// findListenGroup returns the existing group of an address and its rules.
func findListenGroup(groups map[string][]*rule, addr string) (string, []*rule) {
	for key, list := range groups {
		if key == addr || netutil.SameListen(key, addr) {
			return key, list
		}
	}
	return addr, nil
}

func containsRule(list []*rule, r *rule) bool {
	for _, item := range list {
		if item == r {
			return true
		}
	}
	return false
}
