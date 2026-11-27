// Package netutil implements the address, domain and access list helpers
// shared by the web service, the port forwarder and the WAF.
package netutil

import (
	"fmt"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// ParseIPList converts a list of IPs and CIDRs into networks. A bare IP
// becomes a /32 or /128 network.
func ParseIPList(list []string) ([]*net.IPNet, error) {
	out := make([]*net.IPNet, 0, len(list))
	for _, raw := range list {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			ip := net.ParseIP(item)
			if ip == nil {
				return nil, fmt.Errorf("invalid ip address %q", item)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			item = fmt.Sprintf("%s/%d", ip.String(), bits)
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			return nil, fmt.Errorf("invalid cidr %q: %w", raw, err)
		}
		out = append(out, network)
	}
	return out, nil
}

// IPAllowed applies an access rule (off / allow / deny) to an address.
func IPAllowed(mode string, nets []*net.IPNet, ip net.IP) bool {
	switch mode {
	case "allow":
		if len(nets) == 0 {
			return false
		}
		return matchAny(nets, ip)
	case "deny":
		if len(nets) == 0 {
			return true
		}
		return !matchAny(nets, ip)
	default:
		return true
	}
}

func matchAny(nets []*net.IPNet, ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// UAAllowed applies a user agent rule (off / allow / deny). Matching is
// case insensitive substring matching, so "curl" also matches "curl/8.0".
func UAAllowed(mode string, patterns []string, ua string) bool {
	if mode == "" || mode == "off" {
		return true
	}
	hit := false
	lower := strings.ToLower(ua)
	for _, p := range patterns {
		p = strings.ToLower(strings.TrimSpace(p))
		if p == "" {
			continue
		}
		if strings.Contains(lower, p) {
			hit = true
			break
		}
	}
	if mode == "allow" {
		return hit
	}
	return !hit
}

// TrustPolicy decides when the X-Forwarded-For and X-Real-IP headers may be
// believed. Proxies lists the addresses allowed to assert a client address; an
// empty list ignores the headers even when Enabled is set, so a leftover
// "trust proxy" flag can never silently trust every caller.
type TrustPolicy struct {
	Enabled bool
	Proxies []*net.IPNet
}

// ParseTrustPolicy builds the policy from the configured proxy addresses.
func ParseTrustPolicy(enabled bool, proxies []string) (TrustPolicy, error) {
	if !enabled {
		return TrustPolicy{}, nil
	}
	nets, err := ParseIPList(proxies)
	if err != nil {
		return TrustPolicy{}, err
	}
	return TrustPolicy{Enabled: true, Proxies: nets}, nil
}

// Active reports whether forwarded headers can ever be trusted.
func (p TrustPolicy) Active() bool { return p.Enabled && len(p.Proxies) > 0 }

// TrustsPeer reports whether the direct peer of the request is a configured
// proxy. Only such a peer may speak for the client.
func (p TrustPolicy) TrustsPeer(r *http.Request) bool {
	if !p.Active() || r == nil {
		return false
	}
	return matchAny(p.Proxies, PeerIP(r))
}

// ClientIP returns the address the request should be attributed to. Forwarded
// headers are used only when the direct peer is a trusted proxy; otherwise the
// connection address wins, so a client that writes its own X-Forwarded-For can
// never choose the address seen by access rules, limits or the access log.
func (p TrustPolicy) ClientIP(r *http.Request) net.IP {
	if r == nil {
		return nil
	}
	if p.TrustsPeer(r) {
		if ip := forwardedClientIP(r, p); ip != nil {
			return ip
		}
	}
	return PeerIP(r)
}

// PeerIP returns the address of the TCP peer, without consulting any header.
func PeerIP(r *http.Request) net.IP {
	if r == nil {
		return nil
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	host = strings.Trim(host, "[]")
	// A link-local peer may carry a zone ("fe80::1%eth0"); net.ParseIP does
	// not accept it, and a nil address would make deny rules fail open.
	if i := strings.LastIndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	return net.ParseIP(host)
}

// forwardedClientIP reads the client address out of the forwarded headers of a
// request whose peer is trusted. The chain is walked from the right: the
// nearest proxy appended the address it saw, so the first entry that is not
// another trusted proxy is the client. Anything further left was written by
// the client or an earlier hop and only wins when the whole chain is trusted.
func forwardedClientIP(r *http.Request, p TrustPolicy) net.IP {
	var leftmost net.IP
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := net.ParseIP(strings.TrimSpace(parts[i]))
			if ip == nil {
				continue
			}
			leftmost = ip
			if !matchAny(p.Proxies, ip) {
				return ip
			}
		}
	}
	if leftmost != nil {
		return leftmost
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		if ip := net.ParseIP(xr); ip != nil {
			return ip
		}
	}
	return nil
}

// HostOnly strips the port and normalises a Host header value.
func HostOnly(host string) string {
	host = strings.TrimSpace(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	host = strings.TrimSuffix(host, ".")
	return strings.ToLower(host)
}

// MatchDomain reports whether host matches one of the patterns. Supported
// forms: "example.com", "*.example.com" (any sub domain), "*" (any host) and
// a leading "~" for a regular expression.
func MatchDomain(patterns []string, host string) bool {
	host = HostOnly(host)
	if len(patterns) == 0 {
		return true
	}
	for _, raw := range patterns {
		p := strings.ToLower(strings.TrimSpace(raw))
		if p == "" {
			continue
		}
		switch {
		case p == "*":
			return true
		case strings.HasPrefix(p, "*."):
			suffix := p[1:] // ".example.com"
			if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
				return true
			}
		case strings.HasPrefix(p, "~"):
			if ok, err := path.Match(strings.TrimPrefix(p, "~"), host); err == nil && ok {
				return true
			}
		default:
			if host == strings.TrimSuffix(p, ".") {
				return true
			}
		}
	}
	return false
}

// NormalizeListen validates a listen address and returns it in canonical
// form. An empty host means "all interfaces".
func NormalizeListen(addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", fmt.Errorf("empty listen address")
	}
	if !strings.Contains(addr, ":") {
		return "", fmt.Errorf("listen address %q must include a port", addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", addr, err)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return "", fmt.Errorf("listen address %q must use a numeric port between 1 and 65535", addr)
	}
	return net.JoinHostPort(host, strconv.Itoa(number)), nil
}

// SameListen reports whether two listen addresses refer to the same socket.
func SameListen(a, b string) bool {
	an, errA := NormalizeListen(a)
	bn, errB := NormalizeListen(b)
	if errA != nil || errB != nil {
		return a == b
	}
	_, ap, _ := net.SplitHostPort(an)
	_, bp, _ := net.SplitHostPort(bn)
	if ap != bp {
		return false
	}
	ah, _, _ := net.SplitHostPort(an)
	bh, _, _ := net.SplitHostPort(bn)
	// Treat 0.0.0.0/::/empty as the same wildcard host.
	wild := func(h string) bool { return h == "" || h == "0.0.0.0" || h == "::" || h == "[::]" }
	if wild(ah) && wild(bh) {
		return true
	}
	return ah == bh
}

// TargetAllowed validates an upstream address for the reverse proxy and the
// port forwarder: http, https, tcp and udp targets are accepted.
func TargetAllowed(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("empty target")
	}
	if strings.Contains(raw, "://") {
		switch {
		case strings.HasPrefix(raw, "http://"), strings.HasPrefix(raw, "https://"):
			return nil
		default:
			return fmt.Errorf("unsupported scheme in %q", raw)
		}
	}
	if _, _, err := net.SplitHostPort(raw); err != nil {
		return fmt.Errorf("target %q must be host:port", raw)
	}
	return nil
}
