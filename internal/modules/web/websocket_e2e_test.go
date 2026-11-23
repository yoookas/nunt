package web

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/mounts"
)

// wsEchoUpstream answers the upgrade handshake by hand and then echoes every
// byte it receives, which is enough to prove that an upgraded tunnel survives
// the proxy.
func wsEchoUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expected an upgrade request", http.StatusBadRequest)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "hijacking is not supported", http.StatusInternalServerError)
			return
		}
		conn, buf, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buf.Flush()
		_, _ = io.Copy(conn, buf)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestWebSocketUpgradeIsProxied performs a real HTTP upgrade through the
// reverse proxy and checks that the tunnel is bidirectional. The rule has the
// WAF enabled on purpose: the firewall must not replace the ResponseWriter
// with one that cannot be hijacked.
func TestWebSocketUpgradeIsProxied(t *testing.T) {
	upstream := wsEchoUpstream(t)

	addr := freeAddr(t)
	rule := mkRule(t, "ws", "ws.example.com", "/", 0, model.WebTypeProxy)
	rule.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, Balance: "roundrobin"}
	rule.WAF = true

	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), rule)
	deps := &module.Deps{
		Cfg:      store,
		Mounts:   mounts.New(store),
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })

	conn, err := net.DialTimeout("tcp", "127.0.0.1"+addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	handshake := "GET /socket HTTP/1.1\r\n" +
		"Host: ws.example.com\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	if _, err := io.WriteString(conn, handshake); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status = %d, want 101", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		t.Fatalf("upgrade header = %q", resp.Header.Get("Upgrade"))
	}

	payload := []byte("hello-websocket-tunnel")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	echo := make([]byte, len(payload))
	if _, err := io.ReadFull(reader, echo); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(echo) != string(payload) {
		t.Fatalf("echo = %q, want %q", echo, payload)
	}

	second := []byte("second-frame")
	if _, err := conn.Write(second); err != nil {
		t.Fatalf("write second payload: %v", err)
	}
	echo2 := make([]byte, len(second))
	if _, err := io.ReadFull(reader, echo2); err != nil {
		t.Fatalf("read second echo: %v", err)
	}
	if string(echo2) != string(second) {
		t.Fatalf("second echo = %q", echo2)
	}

	if w.Status().Stats["requests"] == nil {
		t.Fatal("the upgraded request must be counted")
	}
}
