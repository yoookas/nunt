package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/nunt/nunt/internal/model"
)

// defaultCORSMethods is what a preflight is allowed to ask for when the rule
// does not restrict the methods.
var defaultCORSMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}

// corsPolicy is the compiled CORS configuration of one rule.
type corsPolicy struct {
	origins     []string
	allowAll    bool
	credentials bool
	methods     string
	headers     string
	maxAge      string
}

func newCORSPolicy(c *model.CORS) *corsPolicy {
	if c == nil {
		return nil
	}
	p := &corsPolicy{
		credentials: c.Credentials,
		methods:     strings.Join(normalizeList(c.Methods, defaultCORSMethods), ", "),
		headers:     strings.Join(normalizeList(c.Headers, nil), ", "),
	}
	if c.MaxAge > 0 {
		p.maxAge = strconv.Itoa(c.MaxAge)
	}
	for _, origin := range c.Origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		if origin == "*" {
			p.allowAll = true
			continue
		}
		p.origins = append(p.origins, strings.TrimSuffix(origin, "/"))
	}
	if !p.allowAll && len(p.origins) == 0 {
		return nil
	}
	return p
}

func normalizeList(in, fallback []string) []string {
	out := make([]string, 0, len(in))
	for _, item := range in {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}

// allowed reports whether an origin may read the response, and what value the
// Access-Control-Allow-Origin header has to carry. With credentials, "*" is
// not valid, so the concrete origin is echoed instead.
func (p *corsPolicy) allowed(origin string) (string, bool) {
	if p == nil || origin == "" {
		return "", false
	}
	if p.allowAll {
		if p.credentials {
			return origin, true
		}
		return "*", true
	}
	for _, candidate := range p.origins {
		if strings.EqualFold(candidate, origin) {
			return origin, true
		}
	}
	return "", false
}

// applyCORS writes the CORS headers and answers a preflight request. It reports
// whether the request was answered (and must not reach the upstream).
func (p *corsPolicy) applyCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	allowOrigin, ok := p.allowed(origin)
	if !ok {
		return false
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", allowOrigin)
	h.Add("Vary", "Origin")
	if p.credentials {
		h.Set("Access-Control-Allow-Credentials", "true")
	}
	if r.Method != http.MethodOptions || r.Header.Get("Access-Control-Request-Method") == "" {
		return false
	}

	h.Set("Access-Control-Allow-Methods", p.methods)
	requested := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers"))
	switch {
	case p.headers != "":
		h.Set("Access-Control-Allow-Headers", p.headers)
	case requested != "":
		h.Set("Access-Control-Allow-Headers", requested)
	}
	if p.maxAge != "" {
		h.Set("Access-Control-Max-Age", p.maxAge)
	}
	h.Add("Vary", "Access-Control-Request-Method")
	h.Add("Vary", "Access-Control-Request-Headers")
	w.WriteHeader(http.StatusNoContent)
	return true
}
