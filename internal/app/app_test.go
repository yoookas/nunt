package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/store"
	"github.com/nunt/nunt/internal/testutil"
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

	hash := testutil.PasswordHash(adminPassword)

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
			PasswordHash: hash,
			CreatedAt:    time.Now(),
		}},
		Web: model.WebConfig{
			AccessLog: true,
			LogKeep:   50,
			Listeners: []model.WebListener{{
				ID: "l1", Name: "http", Listen: []string{fmt.Sprintf("127.0.0.1:%d", webPort)},
			}},
			Rules: []model.WebRule{{
				ID:         "web1",
				Name:       "static site",
				Enable:     true,
				Type:       model.WebTypeStatic,
				ListenerID: "l1",
				Path:       "/",
				Static: &model.StaticTgt{
					Root:    wwwDir,
					Index:   []string{"index.html"},
					Listing: true,
				},
				Access: model.Access{Mode: model.AccessOff},
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
	loginBody := strings.NewReader(fmt.Sprintf("{\"password\":%q}", adminPassword))
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

// TestDefaultAdminListen pins the admin listen default: a fresh configuration
// listens on :3113 and an empty value in an existing file is repaired to the
// same address.
func TestDefaultAdminListen(t *testing.T) {
	if got := config.Default().System.AdminListen; got != ":3113" {
		t.Fatalf("config.Default().System.AdminListen = %q, want %q", got, ":3113")
	}
	if config.DefaultAdminListen != ":3113" {
		t.Fatalf("config.DefaultAdminListen = %q, want %q", config.DefaultAdminListen, ":3113")
	}
	empty := &model.Config{}
	config.Normalize(empty)
	if empty.System.AdminListen != ":3113" {
		t.Fatalf("Normalize filled the admin listen address with %q, want %q", empty.System.AdminListen, ":3113")
	}
}

// TestAdminListenRebindKeepsSession moves the admin console with the settings
// endpoint (the same call the settings page makes), then checks that the old
// port is gone, the new port answers and the browser session survived the move.
func TestAdminListenRebindKeepsSession(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the end to end test in short mode")
	}
	dir := t.TempDir()
	portA := freePort(t)
	portB := freePort(t)
	addrA := fmt.Sprintf("127.0.0.1:%d", portA)
	addrB := fmt.Sprintf("127.0.0.1:%d", portB)

	hash := testutil.PasswordHash(adminPassword)
	cfg := model.Config{
		Version: 1,
		System: model.SystemConfig{
			AdminListen:     addrA,
			LogLevel:        "error",
			SessionTTLHours: 1,
			LoginMaxFail:    5,
			LoginLockMin:    1,
			Theme:           "dark",
		},
		Users: []model.User{{
			ID:           "u1",
			PasswordHash: hash,
			CreatedAt:    time.Now(),
		}},
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

	waitFor(t, "http://"+addrA+"/healthz")

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	client := &http.Client{Timeout: 10 * time.Second, Jar: jar}
	resp, err := client.Post("http://"+addrA+"/api/v1/auth/login", "application/json",
		strings.NewReader(fmt.Sprintf("{\"password\":%q}", adminPassword)))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	var login struct {
		CSRF string `json:"csrf"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&login); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || login.CSRF == "" {
		t.Fatalf("login status %d csrf %q", resp.StatusCode, login.CSRF)
	}

	// The session works on the current port before the move.
	if status := sessionGet(t, client, addrA); status != http.StatusOK {
		t.Fatalf("GET modules before the move = %d, want 200", status)
	}

	// Read the current settings and change only the listen address.
	resp, err = client.Get("http://" + addrA + "/api/v1/system/settings")
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var settings model.SystemConfig
	if err := json.NewDecoder(resp.Body).Decode(&settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	_ = resp.Body.Close()
	settings.AdminListen = addrB
	body, _ := json.Marshal(settings)
	req, _ := http.NewRequest(http.MethodPut, "http://"+addrA+"/api/v1/system/settings", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", login.CSRF)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("save settings: %v", err)
	}
	var updated struct {
		AdminListen       string `json:"adminListen"`
		AdminListenConfig string `json:"adminListenConfig"`
		AdminListenSource string `json:"adminListenSource"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&updated); err != nil {
		t.Fatalf("decode the settings response: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save settings = %d, want 200", resp.StatusCode)
	}
	if updated.AdminListen != addrB || updated.AdminListenConfig != addrB || updated.AdminListenSource != "config" {
		t.Fatalf("the response must carry the new address (adminListen=%q config=%q source=%q)",
			updated.AdminListen, updated.AdminListenConfig, updated.AdminListenSource)
	}

	// The old port must disappear, the new one must answer with the same jar
	// (the cookie is not port scoped, the server keeps the session in memory).
	waitUnreachable(t, "http://"+addrA+"/healthz")
	wantFor(t, "http://"+addrB+"/healthz")
	if status := sessionGet(t, client, addrB); status != http.StatusOK {
		t.Fatalf("GET modules on the new port = %d, want 200 with the same session", status)
	}

	// And back again, using the new port as the origin of the save.
	resp, err = client.Get("http://" + addrB + "/api/v1/system/settings")
	if err != nil {
		t.Fatalf("read settings on the new port: %v", err)
	}
	if err := json.NewDecoder(resp.Body).Decode(&settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	_ = resp.Body.Close()
	settings.AdminListen = addrA
	body, _ = json.Marshal(settings)
	req, _ = http.NewRequest(http.MethodPut, "http://"+addrB+"/api/v1/system/settings", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", login.CSRF)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("save settings back: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save settings back = %d, want 200", resp.StatusCode)
	}
	wantFor(t, "http://"+addrA+"/healthz")
	if status := sessionGet(t, client, addrA); status != http.StatusOK {
		t.Fatalf("GET modules after moving back = %d, want 200", status)
	}
}

func sessionGet(t *testing.T, client *http.Client, addr string) int {
	t.Helper()
	resp, err := client.Get("http://" + addr + "/api/v1/modules")
	if err != nil {
		return 0
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// waitUnreachable waits until the URL stops answering (the listener is closed).
func waitUnreachable(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		client := &http.Client{Timeout: time.Second}
		resp, err := client.Get(url)
		if err != nil {
			return
		}
		_ = resp.Body.Close()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s is still reachable", url)
}

// wantFor waits until the URL answers with a non 5xx status.
func wantFor(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		client := &http.Client{Timeout: time.Second}
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 500 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s did not become reachable", url)
}
