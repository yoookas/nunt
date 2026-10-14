package api

import (
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
)

// adminGuardExemptPaths lists the paths that stay reachable even when the
// admin IP allow list rejects every other address. The container health check
// connects from inside the container, so /healthz must never be filtered.
var adminGuardExemptPaths = map[string]bool{
	"/healthz": true,
}

// ipAllowList is an immutable snapshot of the parsed admin IP allow list
// (SystemConfig.AdminAllowIPs). It is rebuilt by the configuration subscriber
// so that no request ever parses the list itself.
type ipAllowList struct {
	trustProxy bool         // honour X-Forwarded-For / X-Real-IP
	entries    int          // configured, non blank entries
	nets       []*net.IPNet // successfully parsed entries
	failClosed bool         // entries > 0 but not a single entry parsed
}

// restricted reports whether the allow list limits access at all.
func (a *ipAllowList) restricted() bool { return a != nil && a.entries > 0 }

// allow reports whether ip may reach the admin interface.
func (a *ipAllowList) allow(ip net.IP) bool {
	if !a.restricted() {
		// An empty list keeps the historical behaviour: no restriction.
		return true
	}
	if a.failClosed {
		// Every configured entry is invalid: refuse every caller instead of
		// silently behaving as if no restriction had been configured.
		return false
	}
	return netutil.IPAllowed(model.AccessAllow, a.nets, ip)
}

// newIPAllowList parses the configured list. Blank entries are ignored,
// invalid entries are dropped with a warning, and a non empty list without a
// single valid entry fails closed (reported as an error).
func newIPAllowList(log *slog.Logger, sys model.SystemConfig) *ipAllowList {
	list := &ipAllowList{trustProxy: sys.TrustProxy}
	for _, raw := range sys.AdminAllowIPs {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		list.entries++
		nets, err := netutil.ParseIPList([]string{item})
		if err != nil || len(nets) == 0 {
			if log != nil {
				log.Warn("ignoring invalid admin ip allow list entry", "entry", item, "error", err)
			}
			continue
		}
		list.nets = append(list.nets, nets...)
	}
	list.failClosed = list.entries > 0 && len(list.nets) == 0
	if list.failClosed && log != nil {
		log.Error("admin ip allow list has no valid entry, every admin request will be denied",
			"entries", list.entries)
	}
	return list
}

// adminAllowList returns the cached list, never nil.
func (s *Server) adminAllowList() *ipAllowList {
	if list := s.allowList.Load(); list != nil {
		return list
	}
	return &ipAllowList{}
}

// adminGuard enforces the admin IP allow list. It wraps the whole admin
// surface — the REST API including the public sign in route, the UI and its
// static assets — and only lets the health check through.
func (s *Server) adminGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if adminGuardExemptPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		list := s.adminAllowList()
		ip := netutil.ClientIP(r, list.trustProxy)
		if list.allow(ip) {
			next.ServeHTTP(w, r)
			return
		}
		s.allowDenied.Add(1)
		s.log.Warn("admin request denied by ip allow list",
			"ip", ipString(ip), "method", r.Method, "path", r.URL.Path)
		rest.FailCode(w, http.StatusForbidden, "ip_not_allowed", "当前 IP 不在管理后台白名单内")
	})
}

// adminAllowListInfo describes the effective allow list for /system/info.
func (s *Server) adminAllowListInfo() map[string]any {
	list := s.adminAllowList()
	return map[string]any{
		"restricted": list.restricted(),
		"entries":    list.entries,
		"valid":      len(list.nets),
		"failClosed": list.failClosed,
		"trustProxy": list.trustProxy,
		"blocked":    s.allowDenied.Load(),
	}
}

func ipString(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}
