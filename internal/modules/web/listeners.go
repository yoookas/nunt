package web

import (
	"context"
	"crypto/tls"
	"crypto/x509"
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

// listenerTLS is the TLS configuration shared by every route of a listener.
type listenerTLS struct {
	mode   string
	certID string
	hsts   bool
	// certDomains is the SAN list of a pinned custom certificate.
	certDomains []string
	// clientAuth is set when the listener requires client certificates.
	clientAuth tls.ClientAuthType
	clientCAs  *x509.CertPool
}

// listenerPlan is one socket to bind plus the routes served on it.
type listenerPlan struct {
	addr  string
	tls   listenerTLS
	rules []*rule
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

// start binds the socket of one listener plan. TLS is a property of the
// listener, so the address is either plain or TLS, never both.
func (l *listener) start(plan *listenerPlan) error {
	m := newMatcher(plan.addr, plan.rules, plan.tls)
	l.router.setMatcher(m)
	l.router.setPlan(plan)

	if plan.tls.mode == model.TLSModeOff {
		ln, err := listenWithRetry(l.addr)
		if err != nil {
			l.cancel()
			return fmt.Errorf("listen on %s: %w", l.addr, err)
		}
		l.mu.Lock()
		l.plain = ln
		l.mu.Unlock()
		go l.serve(ln, "http")
		l.web.logger().Info("web: listener ready", "addr", l.addr, "tls", false, "routes", len(plan.rules))
		return nil
	}

	tlsCfg := l.web.tlsConfig(l.router.currentMatcher, l.router.currentPlan)
	if plan.tls.clientAuth != tls.NoClientCert {
		tlsCfg.ClientAuth = plan.tls.clientAuth
		tlsCfg.ClientCAs = plan.tls.clientCAs
	}
	ln, err := listenWithRetry(l.addr)
	if err != nil {
		l.cancel()
		return fmt.Errorf("listen on %s: %w", l.addr, err)
	}
	l.mu.Lock()
	l.secure = ln
	l.mu.Unlock()
	go l.serve(tls.NewListener(ln, tlsCfg), "https")
	l.web.logger().Info("web: listener ready", "addr", l.addr, "tls", true, "routes", len(plan.rules))
	return nil
}

func (l *listener) serve(ln net.Listener, scheme string) {
	err := l.server.Serve(ln)
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !isClosedError(err) {
		l.web.log.Error("web: listener stopped", "addr", l.addr, "scheme", scheme, "error", err)
		l.web.SetError(fmt.Errorf("listener %s (%s): %w", l.addr, scheme, err))
	}
}

// close shuts the sockets down and waits for in flight requests, bounded by
// shutdownTimeout. The service keeps using it when a listener is retired at
// runtime (a reload can afford to drain a connection).
func (l *listener) close() {
	l.closeWithin(context.Background(), shutdownTimeout)
}

// closeWithin shuts the sockets down and waits for in flight requests, bounded
// by both timeout and ctx. Stop passes the shutdown context so several
// listeners drain in parallel under one shared budget: docker sends SIGKILL
// when the grace period ends, so the total must stay below it.
func (l *listener) closeWithin(ctx context.Context, timeout time.Duration) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	plain, secure := l.plain, l.secure
	l.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	drainCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := l.server.Shutdown(drainCtx); err != nil {
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

// tlsConfig builds the TLS configuration of a listener. The certificate map is
// read through the router so route changes apply without restarting the socket.
func (w *Web) tlsConfig(nextMatcher func() *matcher, nextPlan func() *listenerPlan) *tls.Config {
	base := &tls.Config{MinVersion: tls.VersionTLS12}
	if w.deps.Certs != nil {
		base = w.deps.Certs.TLSConfig()
	}
	return w.tlsSetup(nextMatcher, nextPlan, base)
}

// resolveCustomCertificates loads the certificate referenced by each listener
// that pins one explicitly. A missing certificate is reported and leaves the
// listener without a usable certificate instead of stopping the process.
func (w *Web) resolveCustomCertificates(plans map[string]*listenerPlan) {
	for _, plan := range plans {
		if plan.tls.mode != model.TLSModeCustom || w.deps.Certs == nil {
			continue
		}
		info, ok := w.deps.Certs.Get(plan.tls.certID)
		if !ok {
			w.logger().Error("web: certificate not found", "listener", plan.addr, "certificate", plan.tls.certID)
			w.SetError(fmt.Errorf("listener %q: certificate %q does not exist", plan.addr, plan.tls.certID))
			continue
		}
		plan.tls.certDomains = append([]string{}, info.Domains...)
		if len(plan.tls.certDomains) == 0 {
			plan.tls.certDomains = []string{info.ID}
		}
	}
}
