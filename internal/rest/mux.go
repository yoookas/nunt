// Package rest contains the tiny HTTP toolkit used by every module: a
// router with groups, middleware and JSON helpers. It depends on nothing but
// the standard library so modules can import it freely.
package rest

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"
)

// HandlerFunc is a http handler without the error return.
type HandlerFunc = http.HandlerFunc

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Mux is a small wrapper around http.ServeMux with method patterns, groups
// and middleware support. Authentication middleware is kept separate from the
// ordinary chain so that Public routes can opt out of it.
type Mux struct {
	prefix string
	mux    *http.ServeMux
	auth   []Middleware
	base   []Middleware
	log    *slog.Logger
	public bool
}

// NewMux creates a root mux sharing one http.ServeMux.
func NewMux(log *slog.Logger, base ...Middleware) *Mux {
	return &Mux{mux: http.NewServeMux(), base: base, log: log}
}

// WithAuth returns a copy of the mux that runs mw before every protected
// route. It is normally called once, on the root mux.
func (m *Mux) WithAuth(mw ...Middleware) *Mux {
	return &Mux{
		prefix: m.prefix,
		mux:    m.mux,
		auth:   append(append([]Middleware{}, m.auth...), mw...),
		base:   m.base,
		log:    m.log,
		public: m.public,
	}
}

// Group returns a child mux that prepends prefix to every path and appends mw
// to the middleware chain. Groups inherit authentication.
func (m *Mux) Group(prefix string, mw ...Middleware) *Mux {
	return &Mux{
		prefix: strings.TrimSuffix(m.prefix, "/") + "/" + strings.Trim(prefix, "/"),
		mux:    m.mux,
		auth:   m.auth,
		base:   append(append([]Middleware{}, m.base...), mw...),
		log:    m.log,
		public: m.public,
	}
}

// With returns a copy of the mux with extra middleware.
func (m *Mux) With(mw ...Middleware) *Mux {
	return &Mux{
		prefix: m.prefix,
		mux:    m.mux,
		auth:   m.auth,
		base:   append(append([]Middleware{}, m.base...), mw...),
		log:    m.log,
		public: m.public,
	}
}

// Public returns a copy of the mux that skips the authentication middleware.
func (m *Mux) Public() *Mux {
	return &Mux{prefix: m.prefix, mux: m.mux, base: m.base, log: m.log, public: true}
}

// Handle registers a handler for "METHOD /path".
func (m *Mux) Handle(method, path string, h http.Handler, mw ...Middleware) {
	pattern := strings.ToUpper(method) + " " + m.join(path)
	chain := make([]Middleware, 0, len(m.auth)+len(m.base)+len(mw))
	if !m.public {
		chain = append(chain, m.auth...)
	}
	chain = append(chain, m.base...)
	chain = append(chain, mw...)
	m.mux.Handle(pattern, Chain(h, chain...))
}

// Get registers a GET route.
func (m *Mux) Get(path string, h HandlerFunc, mw ...Middleware) {
	m.Handle(http.MethodGet, path, h, mw...)
}

// Post registers a POST route.
func (m *Mux) Post(path string, h HandlerFunc, mw ...Middleware) {
	m.Handle(http.MethodPost, path, h, mw...)
}

// Put registers a PUT route.
func (m *Mux) Put(path string, h HandlerFunc, mw ...Middleware) {
	m.Handle(http.MethodPut, path, h, mw...)
}

// Patch registers a PATCH route.
func (m *Mux) Patch(path string, h HandlerFunc, mw ...Middleware) {
	m.Handle(http.MethodPatch, path, h, mw...)
}

// Delete registers a DELETE route.
func (m *Mux) Delete(path string, h HandlerFunc, mw ...Middleware) {
	m.Handle(http.MethodDelete, path, h, mw...)
}

func (m *Mux) join(path string) string {
	if path == "" {
		// An empty route means "the group itself": registering it as "/" would
		// only create a subtree pattern and every client that asks for the
		// group path without the trailing slash would get a 301 instead of the
		// response.
		if prefix := strings.TrimSuffix(m.prefix, "/"); prefix != "" {
			return prefix
		}
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	p := strings.TrimSuffix(m.prefix, "/") + path
	if p == "" {
		p = "/"
	}
	return p
}

// ServeHTTP implements http.Handler.
func (m *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) { m.mux.ServeHTTP(w, r) }

// Chain applies middleware to a handler in order.
func Chain(h http.Handler, mw ...Middleware) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// Recover converts panics into 500 responses instead of killing the process.
func Recover(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					if log != nil {
						log.Error("处理请求时发生 panic", "path", r.URL.Path, "panic", rec)
					}
					Fail(w, http.StatusInternalServerError, "internal server error")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders sets conservative headers for the admin UI.
func SecurityHeaders() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
			// The admin interface is a plain ES module application: no inline
			// scripts, no external origins. Inline styles are allowed because
			// pages attach their own local style elements.
			h.Set("Content-Security-Policy",
				"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
					"img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "+
					"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
			next.ServeHTTP(w, r)
		})
	}
}

// AccessLog logs one line per request at debug level.
func AccessLog(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if log != nil {
				host, _, splitErr := net.SplitHostPort(r.RemoteAddr)
				if splitErr != nil {
					host = r.RemoteAddr
				}
				log.Debug("HTTP 请求",
					"method", r.Method,
					"path", r.URL.Path,
					"host", r.Host,
					"ip", host,
					"status", rec.status,
					"bytes", rec.bytes,
					"duration", time.Since(start).Round(time.Millisecond).String())
			}
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Flush forwards to the underlying writer when it supports flushing.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer, which the
// event stream needs to bound a slow client with a write deadline.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
