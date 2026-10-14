package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"
)

const adminPassword = "integration-password-1"

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port
}

// TestEndToEnd boots the whole service and exercises the admin API, a static
// web rule and a port forward rule over real sockets.
func TestEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the end to end test in short mode")
	}
	dir := t.TempDir()
	wwwDir := filepath.Join(dir, "www")
	if err := store.EnsureDir(wwwDir, 0o750); err != nil {
		t.Fatalf("www dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wwwDir, "hello.txt"), []byte("hello from nunt"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	adminPort := freePort(t)
	webPort := freePort(t)
	fwdSrc := freePort(t)
	echoPort := freePort(t)

	echoLn, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", echoPort))
	if err != nil {
		t.Fatalf("echo listener: %v", err)
	}
	defer func() { _ = echoLn.Close() }()
	go func() {
		for {
			conn, err := echoLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()

	hash, err := security.HashPassword(adminPassword)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	cfg := model.Config{
		Version: 1,
		System: model.SystemConfig{
			AdminListen:     fmt.Sprintf("127.0.0.1:%d", adminPort),
			LogLevel:        "error",
			SessionTTLHours: 1,
			LoginMaxFail:    5,
			LoginLockMin:    1,
			Theme:           "dark",
		},
		Users: []model.User{{
			ID:           "u1",
			Username:     "admin",
			PasswordHash: hash,
			Role:         "admin",
			Enabled:      true,
			CreatedAt:    time.Now(),
		}},
		Web: model.WebConfig{
			AccessLog: true,
			LogKeep:   50,
			Rules: []model.WebRule{{
				ID:     "web1",
				Name:   "static site",
				Enable: true,
				Type:   model.WebTypeStatic,
				Listen: []string{fmt.Sprintf("127.0.0.1:%d", webPort)},
				Path:   "/",
				Static: &model.StaticTgt{
					Root:    wwwDir,
					Index:   []string{"index.html"},
					Listing: true,
				},
				TLS:    model.WebTLS{Mode: model.TLSModeOff},
				Access: model.Access{Mode: model.AccessOff, UAMode: model.AccessOff},
			}},
		},
		Forward: model.ForwardConfig{
			AccessLog: true,
			Rules: []model.ForwardRule{{
				ID:       "fwd1",
				Name:     "echo",
				Enable:   true,
				Protocol: "tcp",
				SrcAddr:  fmt.Sprintf("127.0.0.1:%d", fwdSrc),
				DstAddr:  fmt.Sprintf("127.0.0.1:%d", echoPort),
				Access:   model.Access{Mode: model.AccessOff},
			}},
		},
		WAF: model.WAFConfig{Mode: model.WAFModeDetect, BodyLimitKB: 64},
	}
	cfgPath := filepath.Join(dir, "config.json")
	if err := store.WriteJSONAtomic(cfgPath, &cfg, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	application, err := New(Options{ConfigPath: cfgPath, DataDir: dir, LogLevel: "error"})
	if err != nil {
		t.Fatalf("app.New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- application.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Error("the service did not shut down in time")
		}
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", adminPort)
	waitFor(t, base+"/healthz")

	client := &http.Client{Timeout: 10 * time.Second}
	loginBody := strings.NewReader(fmt.Sprintf("{\"username\":\"admin\",\"password\":%q}", adminPassword))
	resp, err := client.Post(base+"/api/v1/auth/login", "application/json", loginBody)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("login status %d: %s", resp.StatusCode, body)
	}
	var login struct {
		CSRF string `json:"csrf"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&login); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	_ = resp.Body.Close()
	cookies := resp.Cookies()
	if len(cookies) == 0 || login.CSRF == "" {
		t.Fatal("login must return a session cookie and a csrf token")
	}

	req, _ := http.NewRequest(http.MethodGet, base+"/api/v1/modules", nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("modules: %v", err)
	}
	var statuses []map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&statuses)
	_ = resp.Body.Close()
	if len(statuses) == 0 {
		t.Fatal("the module registry must not be empty")
	}

	waitFor(t, fmt.Sprintf("http://127.0.0.1:%d/hello.txt", webPort))
	resp, err = client.Get(fmt.Sprintf("http://127.0.0.1:%d/hello.txt", webPort))
	if err != nil {
		t.Fatalf("static fetch: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "hello from nunt" {
		t.Fatalf("static response %d %q", resp.StatusCode, body)
	}

	conn, err := dialWithRetry(fmt.Sprintf("127.0.0.1:%d", fwdSrc), 5*time.Second)
	if err != nil {
		t.Fatalf("forward dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("forward write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("forward read: %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("forward echo = %q", buf)
	}
}

func waitFor(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 500 {
				return
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("service did not become ready: %s", url)
}

func dialWithRetry(addr string, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			return conn, nil
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	return nil, lastErr
}
