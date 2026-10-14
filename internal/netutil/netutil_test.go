package netutil

import (
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

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.9:5555"
	if got := ClientIP(r, false); got.String() != "203.0.113.9" {
		t.Fatalf("ClientIP = %v", got)
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.1")
	if got := ClientIP(r, false); got.String() != "203.0.113.9" {
		t.Fatalf("X-Forwarded-For must be ignored without a trusted proxy, got %v", got)
	}
	if got := ClientIP(r, true); got.String() != "198.51.100.7" {
		t.Fatalf("ClientIP with trusted proxy = %v", got)
	}
}
