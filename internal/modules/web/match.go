package web

import (
	"net"
	"path"
	"strings"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// normalizeListen canonicalises an address so that addresses referring to the
// same socket ("80", ":80", "0.0.0.0:80", "[::]:80") compare equal.
func normalizeListen(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	if !strings.Contains(addr, ":") {
		if _, err := net.LookupPort("tcp", addr); err == nil {
			addr = ":" + addr
		}
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return strings.ToLower(addr)
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

// listenerAddr normalises the address a server socket is bound to.
func listenerAddr(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return strings.ToLower(addr.String())
	}
	return strings.ToLower(net.JoinHostPort(host, port))
}

// matchAddr reports whether a rule listen address covers a socket address.
// A rule bound to a wildcard host also serves the concrete addresses of the
// host, so ":80" receives traffic for "127.0.0.1:80" as well.
func matchAddr(listen, local string) bool {
	if listen == "" || local == "" {
		return false
	}
	if listen == local {
		return true
	}
	lh, lp, err1 := net.SplitHostPort(listen)
	sh, sp, err2 := net.SplitHostPort(local)
	if err1 != nil || err2 != nil || lp != sp {
		return false
	}
	if isWildcardHost(lh) {
		return true
	}
	if lh == sh {
		return true
	}
	// A wildcard rule host also matches when the socket reports the loopback
	// address of a specific interface.
	if ip := net.ParseIP(sh); ip != nil && ip.IsLoopback() && (lh == "localhost" || lh == "127.0.0.1") {
		return true
	}
	return false
}

func isWildcardHost(host string) bool {
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		return true
	default:
		return false
	}
}

// matchPath reports whether a request path is covered by a rule path prefix.
func matchPath(rulePath, reqPath string) bool {
	rulePath = model.NormalizePath(rulePath)
	if rulePath == "/" {
		return true
	}
	if !strings.HasPrefix(reqPath, rulePath) {
		return false
	}
	if len(reqPath) == len(rulePath) {
		return true
	}
	return reqPath[len(rulePath)] == '/'
}

// betterRule reports whether candidate a should be preferred over b. The
// longest path wins; ties are broken by the higher priority and finally by the
// rule order in the configuration, so the result stays deterministic.
func betterRule(a *rule, b *rule) bool {
	if b == nil {
		return true
	}
	if len(a.path) != len(b.path) {
		return len(a.path) > len(b.path)
	}
	if a.priority != b.priority {
		return a.priority > b.priority
	}
	return a.index < b.index
}

// matcher resolves a request to the rule that should serve it inside one
// listener. It is immutable once built, so requests may read it concurrently.
type matcher struct {
	addr  string
	rules []*rule
	tls   listenerTLS
	// hosts maps literal domains of TLS routes to their rule.
	hosts map[string]*rule
	// wildcards holds the routes with a "*.domain" pattern.
	wildcards []*rule
	// tlsDomains is the certificate domain list of an automatic TLS listener.
	tlsDomains []string
}

func newMatcher(addr string, rules []*rule, tls listenerTLS) *matcher {
	m := &matcher{addr: addr, rules: rules, tls: tls, hosts: map[string]*rule{}}
	if tls.mode != model.TLSModeAuto {
		return m
	}
	seen := map[string]bool{}
	wildcardSeen := map[*rule]bool{}
	for _, r := range rules {
		for _, raw := range r.domains {
			d := netutil.HostOnly(raw)
			if d == "" || d == "*" || strings.HasPrefix(d, "~") {
				continue
			}
			if strings.HasPrefix(d, "*.") {
				if !wildcardSeen[r] {
					wildcardSeen[r] = true
					m.wildcards = append(m.wildcards, r)
				}
			} else if _, ok := m.hosts[d]; !ok {
				m.hosts[d] = r
			}
			if !seen[d] {
				seen[d] = true
				m.tlsDomains = append(m.tlsDomains, d)
			}
		}
	}
	return m
}

// Match returns the rule serving a host and path, or nil when the listener has
// no matching rule.
func (m *matcher) Match(host, reqPath string) *rule {
	if m == nil || len(m.rules) == 0 {
		return nil
	}
	var best *rule
	for _, r := range m.rules {
		if !netutil.MatchDomain(r.domains, host) {
			continue
		}
		if !matchPath(r.path, reqPath) {
			continue
		}
		if betterRule(r, best) {
			best = r
		}
	}
	return best
}

// wildcardMatches reports whether host matches a "*.example.com" pattern.
func wildcardMatches(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if !strings.HasPrefix(pattern, "*.") {
		return false
	}
	suffix := pattern[1:]
	return strings.HasSuffix(host, suffix) && len(host) > len(suffix)
}

// spaCandidate reports whether an unknown path may be answered with the SPA
// entry document. Requests that clearly ask for an asset keep their 404.
func spaCandidate(p string) bool {
	if path.Ext(p) != "" {
		return false
	}
	return !strings.HasPrefix(path.Base(p), ".")
}

// hiddenPath reports whether any segment of a slash path starts with a dot.
func hiddenPath(p string) bool {
	for _, part := range strings.Split(path.Clean(p), "/") {
		if len(part) > 1 && strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}
