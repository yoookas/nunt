package forward

import (
	"fmt"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/testutil"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func testDeps(t *testing.T) (*module.Deps, *config.Store) {
	t.Helper()
	dir := t.TempDir()
	store := testutil.Config(t, filepath.Join(dir, "config.json"), testutil.Password)
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

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// access log
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

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
