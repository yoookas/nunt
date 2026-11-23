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
// authentication and CSRF checks run in the admin API middleware; this helper
// only makes sure an authenticated caller reached the handler.
func requireAdmin(rw http.ResponseWriter, req *http.Request) bool {
	if _, ok := api.IdentityFrom(req.Context()); !ok {
		rest.FailCode(rw, http.StatusUnauthorized, "unauthorized", "authentication required")
		return false
	}
	return true
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
