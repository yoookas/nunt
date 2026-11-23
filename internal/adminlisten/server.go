package adminlisten

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/netutil"
)

// DrainDelay is how long a replaced listener keeps running after a successful
// rebind. The settings save that triggered the move is answered by the old
// listener: http.Server.Shutdown already waits for the active handler, but a
// short grace period makes sure the response has been flushed and read before
// the old socket disappears.
const DrainDelay = 300 * time.Millisecond

// shutdownGrace bounds one graceful shutdown (a replaced listener or Close).
const shutdownGrace = 10 * time.Second

// Error kinds reported by Rebind and Serve.
const (
	// KindEnv means the address is controlled by an environment variable, so a
	// configuration change cannot be applied at runtime.
	KindEnv = "env"
	// KindInvalid means the value is not a usable listen address.
	KindInvalid = "invalid"
	// KindInUse means another socket already owns the port.
	KindInUse = "in-use"
	// KindPermission means the process is not allowed to bind the port.
	KindPermission = "permission"
	// KindBind is every other bind failure (for example an address that is not
	// assigned to this host).
	KindBind = "bind"
)

// RebindError explains why a listen address could not be activated. Its message
// is meant for the settings page, so it names the concrete problem and states
// that the old listener is still in place.
type RebindError struct {
	Kind   string
	Addr   string
	Port   int
	EnvVar string
	Err    error
}

// Error implements error.
func (e *RebindError) Error() string {
	switch e.Kind {
	case KindEnv:
		name := e.EnvVar
		if name == "" {
			name = EnvListen
		}
		return fmt.Sprintf("当前监听地址由环境变量 %s 控制，修改配置不会生效；请移除该环境变量并重启服务后再修改。", name)
	case KindInvalid:
		return fmt.Sprintf("管理后台监听地址不合法：%v", e.Err)
	case KindInUse:
		return fmt.Sprintf("端口 %d 已被占用（%s），旧监听保持不变。", e.Port, e.Addr)
	case KindPermission:
		return fmt.Sprintf("没有权限绑定端口 %d（%s），旧监听保持不变。", e.Port, e.Addr)
	}
	return fmt.Sprintf("无法监听 %s：%v，旧监听保持不变。", e.Addr, e.Err)
}

// Unwrap exposes the underlying error.
func (e *RebindError) Unwrap() error { return e.Err }

// newBindError classifies a net.Listen failure. The classification is textual
// on purpose: net wraps platform specific codes (WSAEADDRINUSE on Windows is
// not syscall.EADDRINUSE), and the strings below are stable across the
// platforms the project targets.
func newBindError(addr string, err error) *RebindError {
	out := &RebindError{Kind: KindBind, Addr: addr, Err: err}
	if _, portText, splitErr := net.SplitHostPort(addr); splitErr == nil {
		if port, convErr := strconv.Atoi(portText); convErr == nil {
			out.Port = port
		}
	}
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "address already in use"),
		strings.Contains(text, "only one usage of each socket address"):
		out.Kind = KindInUse
	case strings.Contains(text, "permission denied"),
		strings.Contains(text, "access is denied"),
		strings.Contains(text, "operation not permitted"),
		strings.Contains(text, "forbidden by its access permissions"):
		out.Kind = KindPermission
	}
	return out
}

// Server owns the admin HTTP listener.
//
// The listener can move to another address while the process keeps running
// (Rebind): the new socket is bound first and only after that does the old one
// stop accepting, so a request on the old port (the settings save that asked
// for the move) still receives its response. Sessions, the module registry and
// every other piece of in-process state stay untouched because the handler and
// the process are the same.
type Server struct {
	handler http.Handler
	log     *slog.Logger
	drain   time.Duration

	rebindMu sync.Mutex
	mu       sync.Mutex
	info     Info
	srv      *http.Server
	ln       net.Listener
	errCh    chan error
	started  bool
	closed   bool
	drains   sync.WaitGroup
}

// NewServer wraps handler and remembers where the address came from (config or
// environment). The address is not bound until Serve is called.
func NewServer(handler http.Handler, log *slog.Logger, info Info) *Server {
	return &Server{
		handler: handler,
		log:     log,
		info:    info,
		drain:   DrainDelay,
		errCh:   make(chan error, 1),
	}
}

// Info returns the address currently in use and its source.
func (s *Server) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// Addr returns the concrete bound address. It differs from Info().Listen only
// when the port was 0.
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln != nil {
		return s.ln.Addr().String()
	}
	return s.info.Listen
}

// Errors reports a fatal serving error of the current listener.
func (s *Server) Errors() <-chan error { return s.errCh }

// Serve binds addr (Info().Listen when empty) and starts serving in the
// background. The listener then runs until a rebind or Close.
func (s *Server) Serve(addr string) error {
	if strings.TrimSpace(addr) == "" {
		addr = s.Info().Listen
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("adminlisten: the server is closed")
	}
	if s.started {
		s.mu.Unlock()
		return errors.New("adminlisten: Serve called more than once")
	}
	s.started = true
	s.mu.Unlock()

	if err := s.bind(addr); err != nil {
		return err
	}
	if s.log != nil {
		s.log.Info("管理界面开始监听", "addr", s.Addr())
	}
	return nil
}

// bind creates the listener and starts serving on it.
func (s *Server) bind(addr string) error {
	normalized, err := netutil.NormalizeListen(addr)
	if err != nil {
		return &RebindError{Kind: KindInvalid, Addr: addr, Err: err}
	}
	ln, err := net.Listen("tcp", normalized)
	if err != nil {
		return newBindError(normalized, err)
	}
	srv := s.newHTTPServer()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = ln.Close()
		return errors.New("adminlisten: the server is closed")
	}
	s.srv, s.ln = srv, ln
	s.info.Listen = normalized
	s.mu.Unlock()

	go s.serve(srv, ln)
	return nil
}

// Rebind moves the admin interface to addr.
//
// Order matters: the new socket is bound before the old one is touched at all,
// so an occupied port, a missing privilege or an invalid address leaves the
// running listener exactly as it was and the error can be returned to the
// caller. On success the old server is retired asynchronously after
// DrainDelay (see retire), keeping the response of the triggering request
// alive. Rebinding to the current address is a no-op.
func (s *Server) Rebind(addr string) error {
	s.rebindMu.Lock()
	defer s.rebindMu.Unlock()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("adminlisten: the server is closed")
	}
	if s.info.Source == SourceEnv {
		err := &RebindError{Kind: KindEnv, Addr: addr, EnvVar: s.info.EnvVar}
		s.mu.Unlock()
		return err
	}
	old := s.srv
	current := s.info.Listen
	s.mu.Unlock()
	if old == nil {
		return errors.New("adminlisten: the server is not running")
	}

	normalized, err := netutil.NormalizeListen(addr)
	if err != nil {
		return &RebindError{Kind: KindInvalid, Addr: addr, Err: err}
	}
	if netutil.SameListen(normalized, current) {
		s.mu.Lock()
		s.info.Listen = normalized
		s.mu.Unlock()
		return nil
	}

	ln, err := net.Listen("tcp", normalized)
	if err != nil {
		return newBindError(normalized, err)
	}
	srv := s.newHTTPServer()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = ln.Close()
		return errors.New("adminlisten: the server is closed")
	}
	s.srv, s.ln = srv, ln
	s.info.Listen = normalized
	s.mu.Unlock()

	go s.serve(srv, ln)
	s.drains.Add(1)
	go func() {
		defer s.drains.Done()
		s.retire(old)
	}()
	if s.log != nil {
		s.log.Info("管理界面已切换监听地址", "from", current, "to", normalized)
	}
	return nil
}

// Close gracefully stops the current listener and joins pending retirements.
// It is safe to call more than once.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	srv := s.srv
	s.mu.Unlock()

	var err error
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		err = srv.Shutdown(ctx)
		cancel()
		if err != nil {
			_ = srv.Close()
		}
	}
	s.drains.Wait()
	return err
}

// serve runs one http.Server and forwards its fatal error. A replaced server
// ends with http.ErrServerClosed and is ignored.
func (s *Server) serve(srv *http.Server, ln net.Listener) {
	err := srv.Serve(ln)
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		return
	}
	s.mu.Lock()
	current := s.srv == srv
	s.mu.Unlock()
	if !current {
		return
	}
	select {
	case s.errCh <- err:
	default:
	}
}

// retire keeps a replaced server alive for DrainDelay and then shuts it down
// gracefully. Shutdown waits for active handlers, so a response that is still
// being written is never cut in half.
func (s *Server) retire(old *http.Server) {
	time.Sleep(s.drain)
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := old.Shutdown(ctx); err != nil {
		if s.log != nil {
			s.log.Warn("管理监听器在切换后关闭", "error", err)
		}
		_ = old.Close()
	}
}

// newHTTPServer builds the HTTP server for one listener. Every rebind gets a
// fresh instance so the old one can be shut down independently.
func (s *Server) newHTTPServer() *http.Server {
	srv := &http.Server{
		Handler:           s.handler,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       0, // uploads and SSE streams may be long lived
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
	if s.log != nil {
		srv.ErrorLog = slog.NewLogLogger(s.log.Handler(), slog.LevelWarn)
	}
	return srv
}
