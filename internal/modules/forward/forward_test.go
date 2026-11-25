package forward

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func testDeps(t *testing.T) (*module.Deps, *config.Store) {
	t.Helper()
	dir := t.TempDir()
	store, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	hub := logging.New("error", "")
	t.Cleanup(hub.Close)
	deps := &module.Deps{
		Cfg:      store,
		Log:      hub,
		DataDir:  dir,
		Registry: module.NewRegistry(),
	}
	return deps, store
}

// freePort reserves a port and returns it. The socket is closed immediately;
// the port stays free long enough for a test.
func freePort(t *testing.T, network string) int {
	t.Helper()
	var ln net.Listener
	var err error
	// net.Listen returns a UDP address for a packet network, so the listener is
	// opened through the matching helper.
	if network == "udp" {
		pc, perr := net.ListenPacket("udp", "127.0.0.1:0")
		if perr != nil {
			t.Fatalf("reserve udp port: %v", perr)
		}
		port := pc.LocalAddr().(*net.UDPAddr).Port
		if cerr := pc.Close(); cerr != nil {
			t.Fatalf("release udp port: %v", cerr)
		}
		return port
	}
	ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatalf("release port: %v", err)
	}
	return port
}

// echoTCP starts a TCP echo server on 127.0.0.1 and returns its address.
func echoTCP(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen echo: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	return ln.Addr().String()
}

// echoUDP starts a UDP echo server on 127.0.0.1 and returns its address.
func echoUDP(t *testing.T) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp echo: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	return pc.LocalAddr().String()
}

func setRules(t *testing.T, store *config.Store, rules ...model.ForwardRule) {
	t.Helper()
	err := store.Update(func(c *model.Config) error {
		c.Forward.Rules = rules
		c.Forward.AccessLog = true
		return nil
	})
	if err != nil {
		t.Fatalf("update config: %v", err)
	}
}

// reloadRules writes the rules and applies them to the module, mimicking what
// the API wiring does through config.Subscribe.
func reloadRules(t *testing.T, f *Forward, store *config.Store, rules ...model.ForwardRule) {
	t.Helper()
	setRules(t, store, rules...)
	f.Reload(store.Snapshot())
}

// ---------------------------------------------------------------------------
// TCP
// ---------------------------------------------------------------------------

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
		Access:   model.Access{Mode: model.AccessDeny, IPs: []string{"127.0.0.1/32"}},
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

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// access log
// ---------------------------------------------------------------------------

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
	m := loadAccess(model.Access{Mode: model.AccessAllow, IPs: []string{"not-an-ip"}}, nil)
	if ok, _ := m.allows(net.ParseIP("127.0.0.1")); ok {
		t.Fatal("an unparsable allow list must reject every address")
	}
	off := loadAccess(model.Access{Mode: model.AccessOff}, nil)
	if ok, _ := off.allows(net.ParseIP("127.0.0.1")); !ok {
		t.Fatal("mode off must allow every address")
	}
}

func TestValidateRule(t *testing.T) {
	base := model.ForwardRule{Protocol: protoTCP, SrcAddr: "127.0.0.1:8080", DstAddr: "127.0.0.1:80"}
	if err := validateRule(base); err != nil {
		t.Fatalf("valid rule rejected: %v", err)
	}
	bad := base
	bad.Protocol = "icmp"
	if err := validateRule(bad); err == nil {
		t.Fatal("an unsupported protocol must be rejected")
	}
	bad = base
	bad.DstAddr = "no-port"
	if err := validateRule(bad); err == nil {
		t.Fatal("a destination without a port must be rejected")
	}
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

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

func pingForwarder(port int) error {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.Write([]byte("ping")); err != nil {
		return err
	}
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return err
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

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

func TestRuleViewsCarryCounters(t *testing.T) {
	deps, store := testDeps(t)
	target := echoTCP(t)
	srcPort := freePort(t, "tcp")
	setRules(t, store, model.ForwardRule{
		ID: "r1", Name: "counted", Enable: true, Protocol: protoTCP,
		SrcAddr: fmt.Sprintf("127.0.0.1:%d", srcPort), DstAddr: target,
	})

	f := New(deps)
	if err := f.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = f.Stop(context.Background()) }()

	if err := pingForwarder(srcPort); err != nil {
		t.Fatalf("forwarder not reachable: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		views := f.ruleViews()
		if len(views) == 1 && views[0].TotalConns > 0 && views[0].UpBytes > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("counters did not move: %+v", views)
		}
		time.Sleep(10 * time.Millisecond)
	}

	views := f.ruleViews()
	if !views[0].Listening {
		t.Fatal("the rule is not reported as listening")
	}

	// Listing through the handler must return the same enriched view.
	rec := httptest.NewRecorder()
	f.handleListRules(rec, httptest.NewRequest(http.MethodGet, "/api/v1/forward/rules", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	var listed []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("listed %d rules, want 1", len(listed))
	}
	if _, ok := listed[0]["activeConns"]; !ok {
		t.Fatalf("the list response has no per rule counters: %v", listed[0])
	}
	if _, ok := listed[0]["srcAddr"]; !ok {
		t.Fatalf("the embedded rule fields were lost: %v", listed[0])
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
		Access:   model.Access{Mode: model.AccessDeny, IPs: []string{"127.0.0.1/32"}},
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

// dualEcho serves TCP and UDP on the same port and echoes whatever it receives,
// which is what a single "both" rule needs as a destination.
func dualEcho(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp echo: %v", err)
	}
	pc, err := net.ListenPacket("udp", ln.Addr().String())
	if err != nil {
		_ = ln.Close()
		t.Fatalf("listen udp echo on the same port: %v", err)
	}
	t.Cleanup(func() {
		_ = ln.Close()
		_ = pc.Close()
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	return ln.Addr().String()
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

// A rule whose source port is taken is switched off and persisted as disabled,
// so a reload does not retry the bind on every configuration change.
func TestReloadAutoDisablesBusyPort(t *testing.T) {
	deps, store := testDeps(t)
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("blocker: %v", err)
	}
	defer func() { _ = blocker.Close() }()
	addr := blocker.Addr().String()

	if err := store.Update(func(c *model.Config) error {
		c.Forward.Rules = []model.ForwardRule{{
			ID: "busy", Name: "busy", Enable: true, Protocol: "tcp",
			SrcAddr: addr, DstAddr: "127.0.0.1:9",
		}}
		return nil
	}); err != nil {
		t.Fatalf("seed rule: %v", err)
	}
	f := New(deps)
	f.Reload(store.Snapshot())

	rule := store.Snapshot().Forward.Rules[0]
	if !rule.Disabled {
		t.Fatal("the busy rule must be marked disabled")
	}
	if f.Stats()["listening"].(int) != 0 {
		t.Fatalf("stats: %v", f.Stats())
	}

	// Freeing the port and turning the switch on binds it again.
	_ = blocker.Close()
	if err := store.Update(func(c *model.Config) error {
		c.Forward.Rules[0].Enable = true
		c.Forward.Rules[0].Disabled = false
		return nil
	}); err != nil {
		t.Fatalf("enable rule: %v", err)
	}
	f.Reload(store.Snapshot())
	rule = store.Snapshot().Forward.Rules[0]
	if rule.Disabled {
		t.Fatalf("the rule must start once the port is free: %+v", rule)
	}
	if got := f.Stats()["listening"].(int); got != 1 {
		t.Fatalf("listening = %d, want 1", got)
	}
	f.Stop(context.Background())
}
