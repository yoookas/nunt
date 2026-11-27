package netutil

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseIPListAndAllowed(t *testing.T) {
	nets, err := ParseIPList([]string{"192.168.1.0/24", "10.0.0.5", "2001:db8::/32"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !IPAllowed(AccessAllow, nets, net.ParseIP("192.168.1.42")) {
		t.Fatal("expected 192.168.1.42 to be allowed")
	}
	if IPAllowed(AccessAllow, nets, net.ParseIP("192.168.2.1")) {
		t.Fatal("expected 192.168.2.1 to be denied by the allow list")
	}
	if IPAllowed(AccessDeny, nets, net.ParseIP("10.0.0.5")) {
		t.Fatal("expected 10.0.0.5 to be denied by the deny list")
	}
	if !IPAllowed(AccessOff, nil, net.ParseIP("8.8.8.8")) {
		t.Fatal("mode off must allow everything")
	}
	if IPAllowed(AccessAllow, nil, net.ParseIP("8.8.8.8")) {
		t.Fatal("an empty allow list must deny everything")
	}
	if _, err := ParseIPList([]string{"not-an-ip"}); err == nil {
		t.Fatal("expected an error for an invalid address")
	}
}

const (
	AccessOff   = "off"
	AccessAllow = "allow"
	AccessDeny  = "deny"
)

func TestUAAllowed(t *testing.T) {
	if !UAAllowed(AccessOff, nil, "curl/8") {
		t.Fatal("off must allow")
	}
	if UAAllowed(AccessDeny, []string{"curl"}, "curl/8.0") {
		t.Fatal("expected curl to be denied")
	}
	if !UAAllowed(AccessDeny, []string{"curl"}, "Mozilla/5.0") {
		t.Fatal("expected a browser to pass the deny list")
	}
	if !UAAllowed(AccessAllow, []string{"Mozilla"}, "mozilla/5.0") {
		t.Fatal("matching must be case insensitive")
	}
}

func TestMatchDomain(t *testing.T) {
	cases := []struct {
		patterns []string
		host     string
		want     bool
	}{
		{nil, "anything.local", true},
		{[]string{"example.com"}, "example.com", true},
		{[]string{"example.com"}, "EXAMPLE.com:8443", true},
		{[]string{"*.example.com"}, "a.example.com", true},
		{[]string{"*.example.com"}, "a.b.example.com", true},
		{[]string{"*.example.com"}, "example.com", false},
		{[]string{"*"}, "whatever", true},
		{[]string{"other.com"}, "example.com", false},
	}
	for _, c := range cases {
		if got := MatchDomain(c.patterns, c.host); got != c.want {
			t.Fatalf("MatchDomain(%v, %q) = %v, want %v", c.patterns, c.host, got, c.want)
		}
	}
}

func TestNormalizeListen(t *testing.T) {
	if got, err := NormalizeListen(":443"); err != nil || got != ":443" {
		t.Fatalf("NormalizeListen(:443) = %q, %v", got, err)
	}
	if got, err := NormalizeListen("127.0.0.1:8080"); err != nil || got != "127.0.0.1:8080" {
		t.Fatalf("unexpected result %q %v", got, err)
	}
	if _, err := NormalizeListen("8080"); err == nil {
		t.Fatal("a missing colon must be rejected")
	}
	if _, err := NormalizeListen(":abc"); err == nil {
		t.Fatal("a non numeric port must be rejected")
	}
	if !SameListen(":80", "0.0.0.0:80") {
		t.Fatal("wildcard hosts must compare equal")
	}
	if SameListen(":80", ":81") {
		t.Fatal("different ports must not compare equal")
	}
}

func TestTargetAllowed(t *testing.T) {
	for _, ok := range []string{"http://127.0.0.1:8080", "https://example.com", "10.0.0.1:3306", "[::1]:80"} {
		if err := TargetAllowed(ok); err != nil {
			t.Fatalf("TargetAllowed(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "ftp://example.com", "example.com"} {
		if err := TargetAllowed(bad); err == nil {
			t.Fatalf("TargetAllowed(%q) must fail", bad)
		}
	}
}

func mustTrust(t *testing.T, enabled bool, proxies ...string) TrustPolicy {
	t.Helper()
	p, err := ParseTrustPolicy(enabled, proxies)
	if err != nil {
		t.Fatalf("ParseTrustPolicy: %v", err)
	}
	return p
}

func TestTrustPolicyIgnoresForwardedHeadersFromAnUntrustedPeer(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.9:5555"
	r.Header.Set("X-Forwarded-For", "10.9.9.9")
	r.Header.Set("X-Real-IP", "10.9.9.9")

	// Disabled, and enabled without a proxy list, both ignore the headers.
	for name, p := range map[string]TrustPolicy{
		"disabled":      mustTrust(t, false),
		"empty-proxies": mustTrust(t, true),
	} {
		if got := p.ClientIP(r); got == nil || got.String() != "203.0.113.9" {
			t.Fatalf("%s: ClientIP = %v, want the peer", name, got)
		}
	}

	// The peer itself is not in the list: the forged header must not win.
	p := mustTrust(t, true, "10.0.0.2/32")
	if got := p.ClientIP(r); got == nil || got.String() != "203.0.113.9" {
		t.Fatalf("untrusted peer: ClientIP = %v, want the peer", got)
	}
}

func TestTrustPolicyAcceptsForwardedHeadersFromATrustedPeer(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "203.0.113.7")
	p := mustTrust(t, true, "10.0.0.2/32")
	if got := p.ClientIP(r); got == nil || got.String() != "203.0.113.7" {
		t.Fatalf("ClientIP = %v, want 203.0.113.7", got)
	}
}

// The nearest proxy appends the address it saw last; a value the client
// prepended sits to its left and must never win.
func TestTrustPolicyIgnoresASpoofedPrefix(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "10.9.9.9, 198.51.100.9")
	r.Header.Set("X-Real-IP", "10.9.9.9")
	p := mustTrust(t, true, "10.0.0.2/32")
	if got := p.ClientIP(r); got == nil || got.String() != "198.51.100.9" {
		t.Fatalf("ClientIP = %v, want 198.51.100.9", got)
	}
}

// With two proxies in the chain the rightmost entry is the inner proxy, not
// the client, so trusted hops are skipped until the first foreign address.
func TestTrustPolicySkipsTrustedHops(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.3")
	p := mustTrust(t, true, "10.0.0.2/32", "10.0.0.3/32")
	if got := p.ClientIP(r); got == nil || got.String() != "203.0.113.7" {
		t.Fatalf("ClientIP = %v, want 203.0.113.7", got)
	}
}

// A client that is itself inside the trusted range is still reported: when the
// whole chain is trusted the leftmost entry is the best answer.
func TestTrustPolicyKeepsATrustedClient(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "10.0.0.4")
	p := mustTrust(t, true, "10.0.0.0/24")
	if got := p.ClientIP(r); got == nil || got.String() != "10.0.0.4" {
		t.Fatalf("ClientIP = %v, want 10.0.0.4", got)
	}
}

func TestTrustPolicyFallsBackToRealIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Real-IP", "203.0.113.7")
	p := mustTrust(t, true, "10.0.0.2/32")
	if got := p.ClientIP(r); got == nil || got.String() != "203.0.113.7" {
		t.Fatalf("ClientIP = %v, want 203.0.113.7", got)
	}
}

// A link-local peer with a zone must still resolve to an address, otherwise
// deny rules see nil and let it through.
func TestPeerIPScopedIPv6(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "[fe80::1%eth0]:1234"
	ip := PeerIP(r)
	if ip == nil || ip.String() != "fe80::1" {
		t.Fatalf("PeerIP = %v, want fe80::1", ip)
	}
}

// HTTPS gates the Secure cookie flag, so it follows exactly the same trust rule
// as ClientIP: the forwarded header counts only from a configured proxy.
func TestTrustPolicyHTTPS(t *testing.T) {
	cases := []struct {
		name   string
		trust  bool
		peer   string
		proto  string
		expect bool
	}{
		{"no proxy configured", false, "10.0.0.2:5555", "https", false},
		{"proxy configured but peer is not one", true, "10.0.0.9:5555", "https", false},
		{"trusted proxy terminating TLS", true, "10.0.0.2:5555", "https", true},
		{"trusted proxy forwarding plain http", true, "10.0.0.2:5555", "http", false},
		{"trusted proxy forwarding a list", true, "10.0.0.2:5555", "https, http", true},
		{"trusted proxy without the header", true, "10.0.0.2:5555", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tc.peer
			if tc.proto != "" {
				r.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			var p TrustPolicy
			if tc.trust {
				p = mustTrust(t, true, "10.0.0.2/32")
			}
			if got := p.HTTPS(r); got != tc.expect {
				t.Fatalf("HTTPS = %v, want %v", got, tc.expect)
			}
		})
	}
}

// A connection that really is TLS needs no proxy at all.
func TestTrustPolicyHTTPSOnDirectTLS(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.TLS = &tls.ConnectionState{}
	if !(TrustPolicy{}).HTTPS(r) {
		t.Fatal("a request that arrived over TLS must count as https")
	}
}
