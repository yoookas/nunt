// Package api implements the admin REST API and serves the embedded UI.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/logstore"
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
	// Logs is the persistent access log store; nil disables the access log
	// endpoints (they answer with empty results).
	Logs   *logstore.Store
	Reload func() // called after a configuration change that needs a reload
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
	// totpChallenges are the pending second factor logins (password accepted,
	// code not yet verified). totpPending holds half finished enrollments.
	totpChallenges *security.ChallengeStore
	totpPending    *totpPendingStore
	logOnce        sync.Once
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

// New creates the API server and registers every route.
func New(opts Options) *Server {
	log := opts.Log.Logger().With("component", "api")
	s := &Server{
		opts:           opts,
		log:            log,
		loginLimiter:   security.NewLimiter(opts.Cfg.Snapshot().System.LoginMaxFail, time.Duration(opts.Cfg.Snapshot().System.LoginLockMin)*time.Minute, 30*time.Minute),
		apiLimiter:     security.NewRateLimiter(50, 100),
		events:         newEventHub(),
		totpChallenges: security.NewChallengeStore(totpChallengeTTL),
		totpPending:    newTOTPPendingStore(),
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
	// Metrics live outside /api but behind the same authentication, so they are
	// only reachable with a signed in browser session.
	root.Handle("/metrics", apiHandler)
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

// IdentityKind distinguishes how the caller authenticated. Only browser
// sessions exist today; the type keeps the JSON shape stable.
type IdentityKind string

// Identity kinds.
const (
	IdentitySession IdentityKind = "session"
)

// Identity is the authenticated caller.
type Identity struct {
	Kind     IdentityKind `json:"kind"`
	UserID   string       `json:"userId,omitempty"`
	Username string       `json:"username"`
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

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookie)
		if err != nil || cookie.Value == "" {
			rest.FailCode(w, http.StatusUnauthorized, "unauthorized", "需要先登录")
			return
		}
		token := cookie.Value

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

// isAdmin reports whether the caller may change configuration. Every
// authenticated caller is an administrator: the console is single-admin.
func isAdmin(r *http.Request) bool {
	_, ok := IdentityFrom(r.Context())
	return ok
}

func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !isAdmin(r) {
		rest.FailCode(w, http.StatusForbidden, "forbidden", "需要管理员权限")
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
	s.registerSystemHealth()
	s.registerBackup()
	s.mux.Get("/metrics", s.handleMetrics)
	s.registerLogs()
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
