package web

import (
	"context"
	"errors"
	"net"
	"net/http"

	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/rest"
)

// errNotFound marks a rule that vanished between two configuration reads.
var errNotFound = errors.New("not found")

// requireAdmin rejects callers that may not change the configuration. The
// authentication and CSRF checks themselves run in the admin API middleware;
// this helper only verifies the scope of an open API token.
func requireAdmin(rw http.ResponseWriter, req *http.Request) bool {
	id, ok := api.IdentityFrom(req.Context())
	if !ok {
		rest.FailCode(rw, http.StatusUnauthorized, "unauthorized", "authentication required")
		return false
	}
	if id.Kind == api.IdentitySession {
		return true
	}
	for _, scope := range id.Scopes {
		if scope == "*" || scope == "admin" {
			return true
		}
	}
	if len(id.Scopes) == 0 {
		return true
	}
	rest.FailCode(rw, http.StatusForbidden, "forbidden", "this api token is not allowed to change the configuration")
	return false
}

type upstreamKey struct{}

// withUpstream records the upstream that served a request for the access log.
func withUpstream(ctx context.Context, target string) context.Context {
	return context.WithValue(ctx, upstreamKey{}, target)
}

// upstreamFrom extracts the recorded upstream.
func upstreamFrom(ctx context.Context) string {
	if v, ok := ctx.Value(upstreamKey{}).(string); ok {
		return v
	}
	return ""
}

// requestListenAddr returns the address of the socket that accepted a request.
func requestListenAddr(r *http.Request) string {
	if r == nil {
		return ""
	}
	addr, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok || addr == nil {
		return ""
	}
	return listenerAddr(addr)
}
