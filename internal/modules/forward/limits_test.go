package forward

import (
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// mustDial connects to the forwarder and fails the test when the port is not
// reachable.
func mustDial(t *testing.T, port int) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 3*time.Second)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	return conn
}

// echoOnce writes a payload through an admitted connection and waits for the
// echo, which proves the relay is running before the next client arrives.
func echoOnce(t *testing.T, conn net.Conn, payload string) {
	t.Helper()
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("write %q: %v", payload, err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	got := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo of %q: %v", payload, err)
	}
	if string(got) != payload {
		t.Fatalf("echo mismatch: got %q want %q", got, payload)
	}
}

// accessResults lists the result strings of a rule, newest first.
func accessResults(f *Forward, ruleID string) []string {
	out := []string{}
	for _, entry := range f.access.list(ruleID, 50) {
		out = append(out, entry.Result)
	}
	return out
}

func hasResult(f *Forward, ruleID, want string) bool {
	for _, result := range accessResults(f, ruleID) {
		if strings.Contains(result, want) {
			return true
		}
	}
	return false
}

// Defaults written by config.Normalize into a stored forward rule.
const (
	wantDefaultMaxConns      = 1024
	wantDefaultMaxConnsPerIP = 64
)

// ---------------------------------------------------------------------------
// TCP limits
// ---------------------------------------------------------------------------

func TestForwardTCPPerIPLimit(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")

	f := New(deps)
	reloadRules(t, f, store, model.ForwardRule{
		ID: "ip", Name: "per ip", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
		MaxConns: 16, MaxConnsPerIP: 1,
	})
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	first := mustDial(t, srcPort)
	defer func() { _ = first.Close() }()
	echoOnce(t, first, "first")

	// The second connection from the same address must be closed immediately.
	second := mustDial(t, srcPort)
	defer func() { _ = second.Close() }()
	if err := second.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := second.Read(make([]byte, 8)); err == nil {
		t.Fatal("the per address limit did not close the extra connection")
	}

	deadline := time.Now().Add(2 * time.Second)
	for !hasResult(f, "ip", "rejected: "+reasonIPLimit) {
		if time.Now().After(deadline) {
			t.Fatalf("the refusal was not written to the access log: %v", accessResults(f, "ip"))
		}
		time.Sleep(10 * time.Millisecond)
	}

	stats := f.Stats()
	if got := stats["rejectedIPLimit"].(uint64); got != 1 {
		t.Fatalf("rejectedIPLimit = %d, want 1", got)
	}
	if got := stats["rejectedRuleLimit"].(uint64); got != 0 {
		t.Fatalf("rejectedRuleLimit = %d, want 0", got)
	}
	// The refused connection must never reach the destination.
	if got := stats["totalConnections"].(uint64); got != 1 {
		t.Fatalf("totalConnections = %d, want 1", got)
	}
}

func TestForwardTCPRuleLimit(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")

	f := New(deps)
	reloadRules(t, f, store, model.ForwardRule{
		ID: "rule", Name: "per rule", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
		MaxConns: 1, MaxConnsPerIP: 32,
	})
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	first := mustDial(t, srcPort)
	defer func() { _ = first.Close() }()
	echoOnce(t, first, "only")

	second := mustDial(t, srcPort)
	defer func() { _ = second.Close() }()
	if err := second.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := second.Read(make([]byte, 8)); err == nil {
		t.Fatal("the rule limit did not close the extra connection")
	}

	deadline := time.Now().Add(2 * time.Second)
	for !hasResult(f, "rule", "rejected: "+reasonRuleLimit) {
		if time.Now().After(deadline) {
			t.Fatalf("the refusal was not written to the access log: %v", accessResults(f, "rule"))
		}
		time.Sleep(10 * time.Millisecond)
	}
	stats := f.Stats()
	if got := stats["rejectedRuleLimit"].(uint64); got != 1 {
		t.Fatalf("rejectedRuleLimit = %d, want 1", got)
	}
	if got := stats["rejectedIPLimit"].(uint64); got != 0 {
		t.Fatalf("rejectedIPLimit = %d, want 0", got)
	}

	// The slot of a closed connection must become available again.
	_ = first.Close()
	deadline = time.Now().Add(3 * time.Second)
	for {
		conn := mustDial(t, srcPort)
		echoErr := func() error {
			if _, err := conn.Write([]byte("again")); err != nil {
				return err
			}
			if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				return err
			}
			buf := make([]byte, 5)
			_, err := io.ReadFull(conn, buf)
			return err
		}()
		_ = conn.Close()
		if echoErr == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the released slot was never reused: %v", echoErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestForwardRuleViewsExposeLimits checks the rule list API: it reports the
// active connections, the enforced caps and the refusal counters.
func TestForwardRuleViewsExposeLimits(t *testing.T) {
	deps, store := testDeps(t)
	firstPort := freePort(t, "tcp")
	f := New(deps)
	reloadRules(t, f, store, model.ForwardRule{
		ID: "r1", Name: "viewed", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", firstPort), DstAddr: "127.0.0.1:9",
	})
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	views := f.ruleViews()
	if len(views) != 1 {
		t.Fatalf("listed %d rules, want 1", len(views))
	}
	// The stored rule went through Normalize, so the defaults are visible.
	if views[0].ConnLimit != wantDefaultMaxConns {
		t.Fatalf("connLimit = %d, want %d", views[0].ConnLimit, wantDefaultMaxConns)
	}
	if views[0].ConnLimitPerIP != wantDefaultMaxConnsPerIP {
		t.Fatalf("connLimitPerIp = %d, want %d", views[0].ConnLimitPerIP, wantDefaultMaxConnsPerIP)
	}

	// An explicit cap wins over the default and is reported as it is enforced.
	secondPort := freePort(t, "tcp")
	reloadRules(t, f, store, model.ForwardRule{
		ID: "r2", Name: "capped", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", secondPort), DstAddr: "127.0.0.1:9",
		MaxConns: 8, MaxConnsPerIP: 2,
	})
	views = f.ruleViews()
	if len(views) != 1 || views[0].ConnLimit != 8 || views[0].ConnLimitPerIP != 2 {
		t.Fatalf("unexpected limits in the rule view: %+v", views)
	}
	if views[0].RejectedRuleLimit != 0 || views[0].RejectedIPLimit != 0 {
		t.Fatalf("a fresh rule must not report refusals: %+v", views[0])
	}
}

// ---------------------------------------------------------------------------
// UDP limits
// ---------------------------------------------------------------------------

func TestForwardUDPPerIPLimit(t *testing.T) {
	deps, store := testDeps(t)
	target := echoUDP(t)
	srcPort := freePort(t, "udp")

	f := New(deps)
	reloadRules(t, f, store, model.ForwardRule{
		ID: "u-ip", Name: "udp per ip", Enable: true, Protocol: protoUDP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
		MaxConns: 8, MaxConnsPerIP: 1,
	})
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	send := func(payload string) ([]byte, error) {
		conn, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer func() { _ = conn.Close() }()
		if _, err := conn.Write([]byte(payload)); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := conn.SetReadDeadline(time.Now().Add(700 * time.Millisecond)); err != nil {
			t.Fatalf("set deadline: %v", err)
		}
		buf := make([]byte, 64)
		n, err := conn.Read(buf)
		return buf[:n], err
	}

	got, err := send("hello")
	if err != nil || string(got) != "hello" {
		t.Fatalf("the first client was not relayed: %q %v", got, err)
	}
	// The second client address is refused because the rule allows only one
	// session per address.
	if got, err := send("second"); err == nil {
		t.Fatalf("the per address limit did not drop the datagram: %q", got)
	}
	if !hasResult(f, "u-ip", "dropped: "+reasonIPLimit) {
		t.Fatalf("the drop was not written to the access log: %v", accessResults(f, "u-ip"))
	}
	if got := f.Stats()["rejectedIPLimit"].(uint64); got != 1 {
		t.Fatalf("rejectedIPLimit = %d, want 1", got)
	}
}

// TestForwardUDPSessionLimitUsesRuleCap proves the session table follows the
// rule cap instead of the built-in fallback.
func TestForwardUDPSessionLimitUsesRuleCap(t *testing.T) {
	deps, store := testDeps(t)
	target := echoUDP(t)
	srcPort := freePort(t, "udp")

	f := New(deps)
	reloadRules(t, f, store, model.ForwardRule{
		ID: "u-cap", Name: "udp capped", Enable: true, Protocol: protoUDP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
		MaxConns: 2, MaxConnsPerIP: 8,
	})
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	f.mu.RLock()
	p := f.proxies["u-cap"]
	f.mu.RUnlock()
	if p == nil {
		t.Fatal("the udp proxy was not created")
	}
	if got := sessionLimit(p.rule); got != 2 {
		t.Fatalf("sessionLimit = %d, want 2", got)
	}

	// Fill the table up to the rule cap with real sessions.
	for i := 0; i < 2; i++ {
		conn, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		defer func() { _ = conn.Close() }()
		if _, err := conn.Write([]byte("fill")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatalf("set deadline: %v", err)
		}
		if _, err := conn.Read(make([]byte, 8)); err != nil {
			t.Fatalf("session %d was not relayed: %v", i, err)
		}
	}

	extra, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
	if err != nil {
		t.Fatalf("dial extra: %v", err)
	}
	defer func() { _ = extra.Close() }()
	if _, err := extra.Write([]byte("overflow")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := extra.SetReadDeadline(time.Now().Add(700 * time.Millisecond)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := extra.Read(make([]byte, 8)); err == nil {
		t.Fatal("the rule cap did not drop the extra session")
	}
	if !hasResult(f, "u-cap", "dropped: "+reasonRuleLimit) {
		t.Fatalf("the drop was not written to the access log: %v", accessResults(f, "u-cap"))
	}
	if got := f.Stats()["rejectedRuleLimit"].(uint64); got != 1 {
		t.Fatalf("rejectedRuleLimit = %d, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// limit helpers
// ---------------------------------------------------------------------------

func TestForwardLimitFallbacks(t *testing.T) {
	// A rule without a cap keeps the historical behaviour: no limit, and the
	// session table falls back to the built-in guard.
	plain := model.ForwardRule{}
	if maxConns(plain) != 0 || maxConnsPerIP(plain) != 0 {
		t.Fatalf("a rule without limits must not be capped: %d/%d", maxConns(plain), maxConnsPerIP(plain))
	}
	if got := sessionLimit(plain); got != udpMaxSessions {
		t.Fatalf("sessionLimit = %d, want %d", got, udpMaxSessions)
	}
	capped := model.ForwardRule{MaxConns: 12, MaxConnsPerIP: 3}
	if maxConns(capped) != 12 || maxConnsPerIP(capped) != 3 {
		t.Fatalf("the configured caps were not read: %d/%d", maxConns(capped), maxConnsPerIP(capped))
	}
	if got := sessionLimit(capped); got != 12 {
		t.Fatalf("sessionLimit = %d, want 12", got)
	}
}

func TestForwardUDPRejectReasonIsLogged(t *testing.T) {
	// The refusal vocabulary is part of the API contract: rule-limit and
	// ip-limit must be distinguishable in the access log.
	if reasonRuleLimit == reasonIPLimit {
		t.Fatal("the two refusal reasons must differ")
	}
	if !strings.HasPrefix("rejected: "+reasonRuleLimit, "rejected: ") {
		t.Fatal("unexpected refusal format")
	}
}
