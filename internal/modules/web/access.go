package web

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/security"
)

// clientIPString renders the caller address for logging and balancing. The
// X-Forwarded-For header is only honoured when the administrator declared a
// trusted proxy in front of the service.
func clientIPString(r *http.Request, trustProxy bool) string {
	ip := netutil.ClientIP(r, trustProxy)
	if ip == nil {
		return ""
	}
	return ip.String()
}

// accessHandler enforces the IP and User-Agent filter of a rule.
func (w *Web) accessHandler(r *rule, next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		trustProxy := w.trustProxy(w.cfg)
		ip := netutil.ClientIP(req, trustProxy)
		if !netutil.IPAllowed(r.spec.Access.Mode, r.ipNets, ip) {
			w.logger().Warn("web: client rejected by ip filter", "rule", r.name, "mode", r.spec.Access.Mode, "ip", ipString(ip))
			http.Error(rw, "forbidden", http.StatusForbidden)
			return
		}
		if !netutil.UAAllowed(r.spec.Access.UAMode, r.spec.Access.UAs, req.UserAgent()) {
			w.logger().Warn("web: client rejected by user agent filter", "rule", r.name, "mode", r.spec.Access.UAMode, "ua", req.UserAgent())
			http.Error(rw, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(rw, req)
	})
}

func ipString(ip net.IP) string {
	if ip == nil {
		return ""
	}
	return ip.String()
}

// basicAuthHandler guards a rule with HTTP basic authentication. Every
// configured user is verified without an early exit and the password check
// itself compares the derived key in constant time.
func (w *Web) basicAuthHandler(r *rule, next http.Handler) http.Handler {
	users := r.spec.BasicAuth.Users
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		username, password, ok := req.BasicAuth()
		if ok && verifyUser(users, username, password) {
			next.ServeHTTP(rw, req)
			return
		}
		w.logger().Warn("web: basic authentication failed", "rule", r.name, "user", username,
			"ip", clientIPString(req, w.trustProxy(w.cfg)))
		realm := r.spec.Name
		if realm == "" {
			realm = "restricted"
		}
		rw.Header().Set("WWW-Authenticate", fmt.Sprintf("Basic realm=%q, charset=\"UTF-8\"", realm))
		http.Error(rw, "unauthorized", http.StatusUnauthorized)
	})
}

// verifyUser checks the credentials against every configured user.
func verifyUser(users []model.BasicAuthUser, username, password string) bool {
	granted := false
	matched := false
	for i := range users {
		u := users[i]
		if subtle.ConstantTimeCompare([]byte(u.Username), []byte(username)) == 1 {
			matched = true
			if u.Password != "" && security.VerifyPassword(u.Password, password) {
				granted = true
			}
		}
	}
	// Run one dummy verification when no user matched to keep the timing of
	// unknown users close to the timing of a wrong password.
	if !matched {
		_ = security.VerifyPassword(dummyHash, password)
	}
	return granted
}

// dummyHash is a valid argon2id hash of a random value; it is only used to
// equalise the response time of unknown user names.
const dummyHash = "$argon2id$v=19$m=65536,t=2,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// wafHandler wraps a site with the WAF engine when the rule enables it.
func (w *Web) wafHandler(r *rule, next http.Handler) http.Handler {
	if !r.spec.WAF || w.waf == nil {
		return next
	}
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				w.logger().Error("web: waf middleware panicked", "rule", r.name, "panic", rec)
				http.Error(rw, "internal server error", http.StatusInternalServerError)
			}
		}()
		w.waf.Middleware(r.name, next).ServeHTTP(rw, req)
	})
}

// hstsHandler adds the Strict-Transport-Security header of a rule.
func (w *Web) hstsHandler(r *rule, next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		rw.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(rw, req)
	})
}
