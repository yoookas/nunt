package forward

import (
	"context"
	"fmt"
	"github.com/nunt/nunt/internal/model"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestForwardTCPRelay(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")

	rule := model.ForwardRule{
		ID:       "r1",
		Name:     "tcp echo",
		Enable:   true,
		Protocol: protoTCP,
		SrcAddr:  fmt.Sprintf("127.0.0.1:%d", srcPort),
		DstAddr:  target,
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() {
		if err := f.Stop(context.Background()); err != nil {
			t.Errorf("stop: %v", err)
		}
	}()

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", srcPort), 3*time.Second)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer func() { _ = conn.Close() }()

	payload := []byte("hello port forward")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(payload))
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo mismatch: got %q want %q", got, payload)
	}

	// Closing the client ends the relay, which is when the byte counters are
	// published.
	_ = conn.Close()
	time.Sleep(100 * time.Millisecond)

	stats := f.Stats()
	if stats["rules"].(int) != 1 {
		t.Fatalf("rules stat = %v, want 1", stats["rules"])
	}
	if stats["enabled"].(int) != 1 {
		t.Fatalf("enabled stat = %v, want 1", stats["enabled"])
	}
	if stats["totalConnections"].(uint64) < 1 {
		t.Fatalf("totalConnections stat = %v, want >= 1", stats["totalConnections"])
	}
	if stats["upBytes"].(uint64) < uint64(len(payload)) {
		t.Fatalf("upBytes stat = %v, want >= %d", stats["upBytes"], len(payload))
	}
}

func TestForwardTCPAccessDenied(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")

	rule := model.ForwardRule{
		ID:       "r1",
		Name:     "denied",
		Enable:   true,
		Protocol: protoTCP,
		SrcAddr:  fmt.Sprintf("127.0.0.1:%d", srcPort),
		DstAddr:  target,
		Access:   model.Access{Mode: model.AccessRules, IP: model.AccessList{Rest: model.AccessAllow, Entries: []model.AccessEntry{{Action: model.AccessDeny, Kind: model.AccessKindIP, Value: "127.0.0.1/32"}}}, UA: model.AccessList{Rest: model.AccessAllow}},
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", srcPort), 3*time.Second)
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := conn.Read(make([]byte, 8)); err == nil {
		t.Fatal("expected the connection to be closed by the access rule")
	}

	logs := f.access.list("", 50)
	if len(logs) == 0 {
		t.Fatal("expected a denial entry in the access log")
	}
	if logs[0].Result != "denied" {
		t.Fatalf("access log result = %q, want denied", logs[0].Result)
	}
}

func TestForwardUDPRelay(t *testing.T) {
	deps, store := testDeps(t)
	target := echoUDP(t)
	srcPort := freePort(t, "udp")

	rule := model.ForwardRule{
		ID:       "u1",
		Name:     "udp echo",
		Enable:   true,
		Protocol: protoUDP,
		SrcAddr:  fmt.Sprintf("127.0.0.1:%d", srcPort),
		DstAddr:  target,
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	client, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer func() { _ = client.Close() }()

	if _, err := client.Write([]byte("datagram")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := client.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	got := make([]byte, 64)
	n, err := client.Read(got)
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got[:n]) != "datagram" {
		t.Fatalf("echo mismatch: got %q", got[:n])
	}

	if stats := f.Stats(); stats["activeConnections"].(int) < 1 {
		t.Fatalf("activeConnections stat = %v, want >= 1", stats["activeConnections"])
	}

	// Stopping must close the session and every listener without waiting for
	// the session timeout.
	stopped := make(chan error, 1)
	go func() { stopped <- f.Stop(context.Background()) }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("stop: %v", err)
		}
	case <-time.After(4 * time.Second):
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("stop did not finish promptly after a udp session was opened:\n%s", buf[:n])
	}
	if stats := f.Stats(); stats["listening"].(int) != 0 {
		t.Fatalf("listening stat after stop = %v, want 0", stats["listening"])
	}
}

func TestForwardReloadDiff(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	firstPort := freePort(t, "tcp")
	secondPort := freePort(t, "tcp")

	first := model.ForwardRule{
		ID: "a", Name: "first", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", firstPort), DstAddr: target,
	}
	setRules(t, store, first)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	if err := pingForwarder(firstPort); err != nil {
		t.Fatalf("first rule not forwarding: %v", err)
	}

	// Replacing the rule must free the old port and open the new one.
	second := first
	second.ID = "b"
	second.SrcAddr = fmt.Sprintf("127.0.0.1:%d", secondPort)
	reloadRules(t, f, store, second)

	deadline := time.Now().Add(2 * time.Second)
	for {
		err := pingForwarder(secondPort)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("second rule not forwarding: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := pingForwarder(firstPort); err == nil {
		t.Fatal("the removed rule still forwards traffic")
	}

	// Disabling everything must close the listeners.
	reloadRules(t, f, store, model.ForwardRule{
		ID: "b", Name: "second", Enable: false, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", secondPort), DstAddr: target,
	})
	deadline = time.Now().Add(2 * time.Second)
	for {
		if err := pingForwarder(secondPort); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the disabled rule still forwards traffic")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestForwardPortConflictDoesNotPanic(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)

	// Occupy the port so the rule cannot bind it.
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("blocker listen: %v", err)
	}
	defer func() { _ = blocker.Close() }()
	port := blocker.Addr().(*net.TCPAddr).Port

	setRules(t, store, model.ForwardRule{
		ID: "busy", Name: "busy", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", port), DstAddr: target,
	})

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start must not fail on a busy port: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	if stats := f.Stats(); stats["listening"].(int) != 0 {
		t.Fatalf("listening stat = %v, want 0 for a busy port", stats["listening"])
	}
}

func TestAccessLoggerRing(t *testing.T) {
	l := newAccessLogger(3)
	if l.enabledNow() {
		t.Fatal("the access log must start disabled")
	}
	l.append(accessEntry{RuleID: "x", Result: "closed"})
	if entries := l.list("", 10); len(entries) != 0 {
		t.Fatalf("disabled log recorded %d entries", len(entries))
	}

	l.apply(true)
	for i := 0; i < 5; i++ {
		l.append(accessEntry{RuleID: "x", Result: fmt.Sprintf("r%d", i)})
	}
	entries := l.list("", 10)
	if len(entries) != 3 {
		t.Fatalf("ring kept %d entries, want 3", len(entries))
	}
	if entries[0].Result != "r4" || entries[2].Result != "r2" {
		t.Fatalf("ring order is wrong: %+v", entries)
	}
	if filtered := l.list("other", 10); len(filtered) != 0 {
		t.Fatalf("rule filter returned %d entries", len(filtered))
	}
	if filtered := l.list("x", 1); len(filtered) != 1 {
		t.Fatalf("limit was not applied: %d entries", len(filtered))
	}

	l.apply(false)
	l.append(accessEntry{RuleID: "x", Result: "ignored"})
	if entries := l.list("x", 10); len(entries) != 3 {
		t.Fatalf("disabled log grew to %d entries", len(entries))
	}
}

func TestAccessMatcherFailsClosed(t *testing.T) {
	m := loadAccess(model.Access{Mode: model.AccessRules, IP: model.AccessList{Rest: model.AccessDeny, Entries: []model.AccessEntry{{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "not-an-ip"}}}, UA: model.AccessList{Rest: model.AccessAllow}}, nil)
	if ok, _ := m.allows(net.ParseIP("127.0.0.1")); ok {
		t.Fatal("an unparsable allow list must reject every address")
	}
	off := loadAccess(model.Access{Mode: model.AccessOff}, nil)
	if ok, _ := off.allows(net.ParseIP("127.0.0.1")); !ok {
		t.Fatal("mode off must allow every address")
	}
}

func TestProtoList(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"tcp", 1},
		{"udp", 1},
		{"both", 2},
		{"", 2},
		{"TCP", 1},
	}
	for _, tc := range cases {
		if got := len(protoList(tc.in)); got != tc.want {
			t.Errorf("protoList(%q) = %d protocols, want %d", tc.in, got, tc.want)
		}
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}

func TestToggleWithoutBody(t *testing.T) {
	deps, store := testDeps(t)
	rule := model.ForwardRule{
		ID: "r1", Name: "toggle me", Enable: false, Protocol: protoTCP,
		SrcAddr: "127.0.0.1:18099", DstAddr: "127.0.0.1:18098",
	}
	setRules(t, store, rule)

	f := New(deps)
	toggle := func(body string) *httptest.ResponseRecorder {
		var req *http.Request
		if body == "" {
			req = httptest.NewRequest(http.MethodPost, "/api/v1/forward/rules/r1/toggle", nil)
		} else {
			req = httptest.NewRequest(http.MethodPost, "/api/v1/forward/rules/r1/toggle", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
		}
		req.SetPathValue("id", "r1")
		rec := httptest.NewRecorder()
		f.handleToggleRule(rec, req)
		return rec
	}

	if rec := toggle(""); rec.Code != http.StatusOK {
		t.Fatalf("toggle status = %d (%s)", rec.Code, rec.Body.String())
	}
	if !store.Snapshot().Forward.Rules[0].Enable {
		t.Fatal("the rule was not enabled by a bodyless toggle")
	}
	if rec := toggle(""); rec.Code != http.StatusOK {
		t.Fatalf("second toggle status = %d (%s)", rec.Code, rec.Body.String())
	}
	if store.Snapshot().Forward.Rules[0].Enable {
		t.Fatal("the rule was not disabled by the second toggle")
	}
	if rec := toggle(`{"enable":true}`); rec.Code != http.StatusOK {
		t.Fatalf("explicit toggle status = %d (%s)", rec.Code, rec.Body.String())
	}
	if !store.Snapshot().Forward.Rules[0].Enable {
		t.Fatal("the explicit enable value was ignored")
	}
}

func TestForwardUDPSessionLimit(t *testing.T) {
	deps, store := testDeps(t)
	target := echoUDP(t)
	srcPort := freePort(t, "udp")
	setRules(t, store, model.ForwardRule{
		ID: "u2", Name: "udp limited", Enable: true, Protocol: protoUDP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
	})

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	p := f.proxy("u2", protoUDP)
	if p == nil {
		t.Fatal("the udp proxy was not created")
	}

	// Fill the session table beyond the configured cap and check that the
	// forwarder refuses the extra client instead of amplifying traffic.
	for i := 0; i < udpMaxSessions; i++ {
		addr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 30000 + i}
		conn, derr := net.Dial("udp", target)
		if derr != nil {
			t.Fatalf("seed session: %v", derr)
		}
		p.mu.Lock()
		p.sessions[addr.String()] = &udpSession{conn: conn, client: addr, created: time.Now(), lastSeen: time.Now()}
		p.mu.Unlock()
	}

	client, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = client.Close() }()
	if _, err := client.Write([]byte("flood")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := client.SetReadDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}
	if _, err := client.Read(make([]byte, 8)); err == nil {
		t.Fatal("the session limit did not drop the extra client")
	}

	found := false
	for _, entry := range f.access.list("u2", 20) {
		// The refusal reason distinguishes the rule cap from the per address cap.
		if strings.Contains(entry.Result, reasonRuleLimit) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("the dropped session was not written to the access log: %v", accessResults(f, "u2"))
	}
}

// A UDP session is published in the table before its target connection exists,
// so an access rule that refuses the first packet releases a session that never
// dialled. That release used to close a nil connection, panic inside the read
// loop goroutine and take the whole process down with it.
func TestForwardUDPAccessDeniedDoesNotPanic(t *testing.T) {
	deps, store := testDeps(t)
	target := echoUDP(t)
	srcPort := freePort(t, "udp")

	rule := model.ForwardRule{
		ID:       "u-deny",
		Name:     "udp denied",
		Enable:   true,
		Protocol: protoUDP,
		SrcAddr:  fmt.Sprintf("127.0.0.1:%d", srcPort),
		DstAddr:  target,
		Access:   model.Access{Mode: model.AccessRules, IP: model.AccessList{Rest: model.AccessAllow, Entries: []model.AccessEntry{{Action: model.AccessDeny, Kind: model.AccessKindIP, Value: "127.0.0.1/32"}}}, UA: model.AccessList{Rest: model.AccessAllow}},
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	client, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", srcPort))
	if err != nil {
		t.Fatalf("dial forwarder: %v", err)
	}
	defer func() { _ = client.Close() }()
	if _, err := client.Write([]byte("datagram")); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The refusal happens in the read loop, out of band: a panic there aborts
	// the test binary instead of failing one assertion, which is exactly the
	// regression this test guards against.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		logs := f.access.list("", 50)
		if len(logs) > 0 && logs[0].Result == "denied" {
			if stats := f.Stats(); stats["listening"].(int) != 1 {
				t.Fatalf("listener stopped after a denied datagram: %v", stats)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no denial entry was recorded for the denied udp datagram")
}

// A rule that declares "both" used to start only the first protocol of the list
// (TCP) while the UI kept offering TCP and UDP, so its UDP side silently did
// nothing.
func TestForwardBothProtocolListensOnTCPAndUDP(t *testing.T) {
	deps, store := testDeps(t)
	target := dualEcho(t)
	srcPort := freePort(t, "tcp")
	addr := fmt.Sprintf("127.0.0.1:%d", srcPort)

	rule := model.ForwardRule{
		ID: "b1", Name: "both", Enable: true, Protocol: protoBoth,
		SrcAddr: addr, DstAddr: target,
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	// TCP side.
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial tcp: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("tcp")); err != nil {
		t.Fatalf("tcp write: %v", err)
	}
	if got := make([]byte, 8); true {
		n, err := conn.Read(got)
		if err != nil || string(got[:n]) != "tcp" {
			t.Fatalf("tcp echo = %q, %v", got[:n], err)
		}
	}

	// UDP side.
	client, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatalf("dial udp: %v", err)
	}
	defer func() { _ = client.Close() }()
	if _, err := client.Write([]byte("udp")); err != nil {
		t.Fatalf("udp write: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 8)
	n, err := client.Read(buf)
	if err != nil || string(buf[:n]) != "udp" {
		t.Fatalf("udp echo = %q, %v", buf[:n], err)
	}

	if got := f.Stats()["listening"]; got != 2 {
		t.Fatalf("listening = %v, want two listeners (tcp and udp)", got)
	}
}

// The configured timeout is an idle timeout: an active connection must outlive
// it, while a silent one is still closed.
func TestForwardTCPIdleTimeoutKeepsActiveConnections(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")
	addr := fmt.Sprintf("127.0.0.1:%d", srcPort)

	rule := model.ForwardRule{
		ID: "i1", Name: "idle", Enable: true, Protocol: protoTCP,
		SrcAddr: addr, DstAddr: target, TimeoutSec: 1,
	}
	setRules(t, store, rule)

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	// Keep talking for well over the one second timeout.
	for i := 0; i < 8; i++ {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write([]byte("ping")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		if _, err := conn.Read(make([]byte, 4)); err != nil {
			t.Fatalf("the relay closed an active connection after %d pings: %v", i, err)
		}
		time.Sleep(250 * time.Millisecond)
	}

	// Now go silent: the idle timeout has to fire.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 8)); err == nil {
		t.Fatal("the idle timeout left a silent connection open")
	}
}

// The datagram relay is bounded: when the queue is full the packet is dropped
// instead of spawning another goroutine.
func TestUDPQueueDropsWhenFull(t *testing.T) {
	p := &proxy{
		f:        &Forward{},
		udpQueue: make(chan udpPacket, 1),
	}
	if !p.enqueue(nil, nil, []byte("first")) {
		t.Fatal("the first datagram was not queued")
	}
	if p.enqueue(nil, nil, []byte("second")) {
		t.Fatal("a datagram was queued past the bound")
	}
	if got := p.rejectedQueue.Load(); got != 1 {
		t.Fatalf("rejectedQueue = %d, want 1", got)
	}
}
