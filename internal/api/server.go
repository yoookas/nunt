// Package api implements the admin REST API and serves the embedded UI.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/version"
	"github.com/nunt/nunt/internal/webui"
)

// SessionCookie is the name of the admin session cookie.
const SessionCookie = "nunt_session"

// Options configures the API server.
type Options struct {
	Cfg      *config.Store
	Log      *logging.Hub
	Registry *module.Registry
	Certs    *certs.Store
	Box      *secret.Box
	Sessions *security.SessionStore
	DataDir  string
	Geo      *ip2region.Service
	Reload   func() // called after a configuration change that needs a reload
	// AdminWAF optionally wraps the admin API with the web application
	// firewall (used when system protection is enabled in the WAF config).
	AdminWAF func(http.Handler) http.Handler
}

// Server is the admin API.
type Server struct {
	opts         Options
	mux          *rest.Mux
	log          *slog.Logger
	loginLimiter *security.Limiter
	apiLimiter   *security.RateLimiter
	events       *eventHub
	logOnce      sync.Once
	// allowList caches the parsed admin IP allow list and allowDenied counts
	// the requests that the allow list guard rejected.
	allowList   atomic.Pointer[ipAllowList]
	allowDenied atomic.Int64
	// bindSessionIP mirrors System.SessionBindIP, refreshed by a configuration
	// subscriber so the request path does not have to clone the configuration.
	bindSessionIP atomic.Bool
	// bg tracks best effort background work (for example persisting the last
	// use of an API token) so it can be joined before the data directory goes
	// away.
	bg sync.WaitGroup
	// admin is the rebindable admin listener, attached by the application after
	// the API handler exists (the listener serves that handler). Unit tests may
	// leave it nil: the API then reports the configured address and setting a
	// new address only updates the configuration file.
	admin atomic.Pointer[adminlisten.Server]
}

// SetAdminListener attaches the rebindable admin listener. It must be called
// while the application is being assembled, before the listener serves.
func (s *Server) SetAdminListener(srv *adminlisten.Server) { s.admin.Store(srv) }

// AdminListener returns the attached admin listener (nil when the API is used
// standalone).
func (s *Server) AdminListener() *adminlisten.Server { return s.admin.Load() }

// WaitBackground blocks until every background task started by the server has
// finished. Call it on shutdown so that no deferred write lands after the
// configuration directory is gone.
func (s *Server) WaitBackground() { s.bg.Wait() }

// goBackground runs fn in a goroutine that WaitBackground joins.
func (s *Server) goBackground(fn func()) {
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		fn()
	}()
}

// New creates the API server and registers every route.
func New(opts Options) *Server {
	log := opts.Log.Logger().With("component", "api")
	s := &Server{
		opts:         opts,
		log:          log,
		loginLimiter: security.NewLimiter(opts.Cfg.Snapshot().System.LoginMaxFail, time.Duration(opts.Cfg.Snapshot().System.LoginLockMin)*time.Minute, 30*time.Minute),
		apiLimiter:   security.NewRateLimiter(50, 100),
		events:       newEventHub(),
	}
	// The admin IP allow list is parsed once here and refreshed by the
	// configuration subscriber, never on the request path.
	s.allowList.Store(newIPAllowList(log, opts.Cfg.Snapshot().System))
	s.bindSessionIP.Store(opts.Cfg.Snapshot().System.SessionBindIP)
	opts.Cfg.Subscribe(func(cfg *model.Config) {
		s.allowList.Store(newIPAllowList(log, cfg.System))
		s.bindSessionIP.Store(cfg.System.SessionBindIP)
	})
	s.mux = rest.NewMux(log, rest.Recover(log), rest.AccessLog(log))
	s.mux = s.mux.With(s.apiLimit)
	s.mux = s.mux.WithAuth(s.authenticate)
	s.mux = s.mux.With(s.adminScope)
	s.register()
	return s
}

// Handler returns the HTTP handler of the admin interface.
func (s *Server) Handler() http.Handler {
	root := http.NewServeMux()
	var apiHandler http.Handler = s.mux
	if s.opts.AdminWAF != nil {
		apiHandler = s.opts.AdminWAF(apiHandler)
	}
	root.Handle("/api/", apiHandler)
	root.Handle("/healthz", http.HandlerFunc(s.health))
	root.Handle("/", rest.Chain(webui.Handler(), rest.SecurityHeaders()))
	// The IP allow list guards the complete admin surface, including the sign
	// in route and the static assets; only /healthz stays exempt.
	return rest.Chain(root, rest.SecurityHeaders(), s.adminGuard)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, map[string]any{"status": "ok", "time": time.Now().Format(time.RFC3339)})
}

// rateLimitKey identifies the caller for the API rate limiter. It honours the
// trust proxy setting, so clients behind a reverse proxy get a bucket each
// instead of sharing the proxy address.
func (s *Server) rateLimitKey(r *http.Request) string {
	if ip := s.clientIP(r); ip != nil {
		return ip.String()
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func (s *Server) apiLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.apiLimiter.Allow(s.rateLimitKey(r)) {
			rest.Fail(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

// IdentityKind distinguishes browser sessions from open API tokens.
type IdentityKind string

// Identity kinds.
const (
	IdentitySession IdentityKind = "session"
	IdentityToken   IdentityKind = "token"
)

// Identity is the authenticated caller.
type Identity struct {
	Kind     IdentityKind `json:"kind"`
	UserID   string       `json:"userId,omitempty"`
	Username string       `json:"username"`
	TokenID  string       `json:"tokenId,omitempty"`
	Scopes   []string     `json:"scopes,omitempty"`
	CSRF     string       `json:"-"`
	Session  *security.Session
}

type identityKey struct{}

// WithIdentity stores the caller in the request context.
func WithIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// IdentityFrom extracts the caller from a request context.
func IdentityFrom(ctx context.Context) (*Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(*Identity)
	return id, ok
}

// SessionFrom returns the browser session of the caller when it has one.
func (s *Server) SessionFrom(r *http.Request) (*security.Session, bool) {
	id, ok := IdentityFrom(r.Context())
	if !ok || id.Session == nil {
		return nil, false
	}
	return id.Session, true
}

func tokenFromRequest(r *http.Request) (token string, isBearer bool) {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:]), true
	}
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		return c.Value, false
	}
	return "", false
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, isBearer := tokenFromRequest(r)
		if token == "" {
			// Open API clients may also use the X-API-Token header.
			token = r.Header.Get("X-Api-Token")
			isBearer = token != ""
		}
		if token == "" {
			rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "需要先登录")
			return
		}

		if isBearer {
			if id := s.matchToken(token); id != nil {
				next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
				return
			}
			rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "API Token 无效")
			return
		}

		sess, ok := s.opts.Sessions.Get(token)
		if !ok {
			rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "会话已过期，请重新登录")
			return
		}
		if !s.sessionMatches(sess, r) {
			// The cookie is being used by another client: drop it instead of
			// letting the copied token live until it expires.
			s.opts.Sessions.Delete(token)
			rest.FailCode(w, http.StatusUnauthorized, "session_mismatch", "会话与当前客户端不匹配，请重新登录")
			return
		}
		// Cookie authenticated state changing requests must carry the CSRF token.
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if !security.ConstantTimeEqual(r.Header.Get("X-CSRF-Token"), sess.CSRF) {
				rest.FailCode(w, http.StatusForbidden, "csrf", "CSRF 校验失败，请刷新页面后重试")
				return
			}
		}
		id := &Identity{Kind: IdentitySession, UserID: sess.UserID, Username: sess.Username, CSRF: sess.CSRF, Session: sess}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

func (s *Server) matchToken(token string) *Identity {
	var matched *model.APIToken
	cfg := s.opts.Cfg.Snapshot()
	for i := range cfg.Tokens {
		t := cfg.Tokens[i]
		if !t.Enabled || t.TokenHash == "" {
			continue
		}
		if security.ConstantTimeEqual(t.TokenHash, hashTokenValue(token)) {
			matched = &t
			break
		}
	}
	if matched == nil {
		return nil
	}
	// Persisting every request would rewrite the configuration file far too
	// often, so the usage timestamp is only refreshed every few minutes. The
	// write is tracked so shutdown (and tests) can wait for it.
	if matched.LastUsed == nil || time.Since(*matched.LastUsed) > 5*time.Minute {
		s.goBackground(func() { s.touchToken(matched.ID) })
	}
	return &Identity{Kind: IdentityToken, Username: matched.Name, TokenID: matched.ID, Scopes: matched.Scopes}
}

func (s *Server) touchToken(id string) {
	_ = s.opts.Cfg.Update(func(c *model.Config) error {
		for i := range c.Tokens {
			if c.Tokens[i].ID == id {
				now := time.Now()
				c.Tokens[i].LastUsed = &now
			}
		}
		return nil
	})
}

// adminScope protects every mutating route, including the ones registered by
// modules, against API tokens that were issued with a restricted scope.
func (s *Server) adminScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		id, ok := IdentityFrom(r.Context())
		if !ok {
			// Public route (sign in); authentication is not required.
			next.ServeHTTP(w, r)
			return
		}
		if id.Kind == IdentityToken && !hasAdminScope(id.Scopes) {
			rest.FailCode(w, http.StatusForbidden, "forbidden", "该 API Token 没有修改配置的权限")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hasAdminScope(scopes []string) bool {
	if len(scopes) == 0 {
		return true
	}
	for _, scope := range scopes {
		if scope == "*" || scope == "admin" {
			return true
		}
	}
	return false
}

// isAdmin reports whether the caller may change configuration.
func isAdmin(r *http.Request) bool {
	id, ok := IdentityFrom(r.Context())
	if !ok {
		return false
	}
	if id.Kind == IdentitySession {
		return true
	}
	for _, scope := range id.Scopes {
		if scope == "*" || scope == "admin" {
			return true
		}
	}
	return len(id.Scopes) == 0
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !isAdmin(r) {
		rest.FailCode(w, http.StatusForbidden, "forbidden", "该 API Token 没有修改配置的权限")
		return false
	}
	return true
}

// sessionMatches checks that a session is used by the client it was issued to.
// The user agent is compared against the one captured at login; the address is
// only compared when the administrator enabled it. A session that recorded no
// user agent (older sessions, or clients that send none) skips that check.
func (s *Server) sessionMatches(sess *security.Session, r *http.Request) bool {
	if sess.UserAgent != "" && sess.UserAgent != r.UserAgent() {
		return false
	}
	if !s.bindSessionIP.Load() || sess.IP == "" {
		return true
	}
	ip := s.clientIP(r)
	return ip != nil && ip.String() == sess.IP
}

// clientIP returns the caller address honouring the trust proxy setting.
func (s *Server) clientIP(r *http.Request) net.IP {
	return netutil.ClientIP(r, s.opts.Cfg.Snapshot().System.TrustProxy)
}

func (s *Server) register() {
	s.registerAuth()
	s.registerSystem()
	s.registerModules()
	s.registerEvents()

	// Every module that exposes REST endpoints mounts them on the same mux so
	// they inherit authentication, CSRF protection and the token scope check.
	if s.opts.Registry != nil {
		for _, provider := range s.opts.Registry.APIProviders() {
			provider.RegisterAPI(s.mux)
		}
	}
}

func versionInfo() version.Info { return version.Get() }

// jsonBody decodes a JSON request body.
func jsonBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := rest.Decode(w, r, v); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) { rest.OK(w, v) }

func idParam(r *http.Request, name string) string { return r.PathValue(name) }

// audit logs a configuration change with the caller identity.
func (s *Server) audit(r *http.Request, action string, fields ...any) {
	id, _ := IdentityFrom(r.Context())
	user := "unknown"
	if id != nil {
		user = id.Username
	}
	args := append([]any{"user", user, "ip", s.clientIP(r).String(), "action", action}, fields...)
	s.log.Info("admin action", args...)
}

var _ = fmt.Sprintf
var _ = json.Marshal
