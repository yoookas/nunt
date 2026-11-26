// Package reqmeta carries request-scoped values that more than one module
// needs to add to the access log. The web module creates it for every request;
// the WAF fills in its verdict so a blocked request is logged once instead of
// twice.
package reqmeta

import (
	"context"
	"sync"
)

// WAFVerdict is the WAF decision for one request.
type WAFVerdict struct {
	Action  string
	RuleID  int
	Message string
}

// Info is the per-request metadata shared through the request context.
type Info struct {
	mu        sync.Mutex
	requestID string
	waf       *WAFVerdict
}

// New creates the metadata of one request.
func New(requestID string) *Info {
	return &Info{requestID: requestID}
}

// RequestID returns the correlation id of the request.
func (i *Info) RequestID() string {
	if i == nil {
		return ""
	}
	return i.requestID
}

// SetWAF records the first WAF verdict of the request; later hits do not
// overwrite it, the WAF event ring keeps the full list.
func (i *Info) SetWAF(action string, ruleID int, message string) {
	if i == nil {
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.waf == nil {
		i.waf = &WAFVerdict{Action: action, RuleID: ruleID, Message: message}
	}
}

// WAF returns the recorded verdict, if any.
func (i *Info) WAF() (WAFVerdict, bool) {
	if i == nil {
		return WAFVerdict{}, false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.waf == nil {
		return WAFVerdict{}, false
	}
	return *i.waf, true
}

type ctxKey struct{}

// With attaches the metadata to a request context.
func With(ctx context.Context, info *Info) context.Context {
	return context.WithValue(ctx, ctxKey{}, info)
}

// From returns the metadata of a request, or nil when the request did not come
// through the web module (for example the admin WAF).
func From(ctx context.Context) *Info {
	info, _ := ctx.Value(ctxKey{}).(*Info)
	return info
}
