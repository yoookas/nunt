package api

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/model"
)

// freePort reserves a port for a test that will bind it later.
//
// Asking the kernel for :0 hands back a port from the ephemeral range; another
// package running in parallel can be given the same port the moment this
// listener closes, which made the rebind tests flaky. Ports below the usual
// ephemeral window (32768+) are not handed out by :0 and are still
// unprivileged, so a bounded random search is both stable and portable.
func freePort(t *testing.T) int {
	t.Helper()
	for attempt := 0; attempt < 50; attempt++ {
		port := 20000 + rand.IntN(12000)
		ln, err := net.Listen("tcp", addrOf(port))
		if err != nil {
			continue
		}
		_ = ln.Close()
		return port
	}
	t.Fatal("no free port in 20000-31999")
	return 0
}

func addrOf(port int) string { return fmt.Sprintf("127.0.0.1:%d", port) }

// login performs the browser login flow and returns the session cookie and the
// CSRF token.
func login(t *testing.T, env *testEnv) ([]*http.Cookie, string) {
	t.Helper()
	rec := env.do(t, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"password": testPassword,
	}, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		CSRF string `json:"csrf"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode login: %v", err)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 || payload.CSRF == "" {
		t.Fatal("login must return a session cookie and a csrf token")
	}
	return cookies, payload.CSRF
}

// startAdminListener attaches a real listener manager to the API server, as the
// application does, and returns it with its address.
func startAdminListener(t *testing.T, env *testEnv, source adminlisten.Source, envVar string) (*adminlisten.Server, string) {
	t.Helper()
	addr := addrOf(freePort(t))
	info := adminlisten.Info{Listen: addr, ConfigListen: ":3113", Source: source, EnvVar: envVar}
	srv := adminlisten.NewServer(env.server.Handler(), nil, info)
	if err := srv.Serve(""); err != nil {
		t.Fatalf("serve %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	env.server.SetAdminListener(srv)
	return srv, addr
}

// currentSettings returns a copy of the stored system settings so a test can
// change one field and send the whole object back.
func currentSettings(env *testEnv) model.SystemConfig {
	return env.store.Snapshot().System
}

func getURL(t *testing.T, url string) (int, error) {
	t.Helper()
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(url)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// waitHTTP waits until url answers with want.
func waitHTTP(t *testing.T, url string, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		status, err := getURL(t, url)
		if err == nil && status == want {
			return
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never answered %d (last error: %v)", url, want, lastErr)
}

// waitUnreachable waits until nothing listens on url anymore.
func waitUnreachable(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := getURL(t, url); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s is still reachable", url)
}

func errorMessage(t *testing.T, rec interface{ Result() *http.Response }) string {
	t.Helper()
	body, _ := io.ReadAll(rec.Result().Body)
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &payload)
	return payload.Error.Message
}

func TestUpdateSettingsRebindsAndReturnsTheEffectiveAddress(t *testing.T) {
	env := newTestEnv(t)
	srv, oldAddr := startAdminListener(t, env, adminlisten.SourceConfig, "")
	cookies, csrf := login(t, env)
	target := addrOf(freePort(t))

	settings := currentSettings(env)
	settings.AdminListen = target
	rec := env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /system/settings = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		AdminListen        string `json:"adminListen"`
		AdminListenConfig  string `json:"adminListenConfig"`
		AdminListenSource  string `json:"adminListenSource"`
		AdminListenApplied bool   `json:"adminListenApplied"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.AdminListen != target {
		t.Fatalf("the response must carry the effective address %q, got %q", target, body.AdminListen)
	}
	if body.AdminListenConfig != target || body.AdminListenSource != "config" || !body.AdminListenApplied {
		t.Fatalf("unexpected listen state: config=%q source=%q applied=%v",
			body.AdminListenConfig, body.AdminListenSource, body.AdminListenApplied)
	}
	if stored := env.store.Snapshot().System.AdminListen; stored != target {
		t.Fatalf("the stored adminListen = %q, want %q", stored, target)
	}
	if info := srv.Info(); info.Listen != target {
		t.Fatalf("the listener is on %q, want %q", info.Listen, target)
	}

	// The new socket answers, the old one is gone and the browser session is
	// still valid on the new port.
	waitHTTP(t, "http://"+target+"/healthz", http.StatusOK)
	waitUnreachable(t, "http://"+oldAddr+"/healthz")
	req, _ := http.NewRequest(http.MethodGet, "http://"+target+"/api/v1/modules", nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("modules on the new port: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the session must survive the rebind, modules = %d", resp.StatusCode)
	}
}

func TestUpdateSettingsRejectsListenChangesControlledByTheEnvironment(t *testing.T) {
	env := newTestEnv(t)
	srv, addr := startAdminListener(t, env, adminlisten.SourceEnv, adminlisten.EnvListen)
	cookies, csrf := login(t, env)

	// Changing the address is refused with the environment variable named.
	settings := currentSettings(env)
	settings.AdminListen = addrOf(freePort(t))
	rec := env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusConflict {
		t.Fatalf("changing the address under an env override = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	message := errorMessage(t, rec)
	for _, want := range []string{"NUNT_ADMIN_LISTEN", "环境变量", "修改配置不会生效"} {
		if !strings.Contains(message, want) {
			t.Fatalf("message = %q, want it to contain %q", message, want)
		}
	}
	if stored := env.store.Snapshot().System.AdminListen; stored != ":3113" {
		t.Fatalf("the configuration must not change, adminListen = %q", stored)
	}
	if info := srv.Info(); info.Listen != addr {
		t.Fatalf("the listener must stay on %q, got %q", addr, info.Listen)
	}
	if status, err := getURL(t, "http://"+addr+"/healthz"); err != nil || status != http.StatusOK {
		t.Fatalf("the old listener must keep serving: status=%d err=%v", status, err)
	}

	// Unrelated settings still save: sending back the stored address is not a
	// listen change.
	settings = currentSettings(env)
	settings.LogLevel = "debug"
	rec = env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("an unrelated settings save = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if stored := env.store.Snapshot().System.LogLevel; stored != "debug" {
		t.Fatalf("logLevel = %q, want debug", stored)
	}
}

func TestUpdateSettingsKeepsTheOldListenerWhenThePortIsOccupied(t *testing.T) {
	env := newTestEnv(t)
	srv, addr := startAdminListener(t, env, adminlisten.SourceConfig, "")
	cookies, csrf := login(t, env)

	busyPort := freePort(t)
	blocker, err := net.Listen("tcp", addrOf(busyPort))
	if err != nil {
		t.Fatalf("occupy %d: %v", busyPort, err)
	}
	defer func() { _ = blocker.Close() }()

	settings := currentSettings(env)
	settings.AdminListen = addrOf(busyPort)
	rec := env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusConflict {
		t.Fatalf("saving an occupied port = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	message := errorMessage(t, rec)
	if !strings.Contains(message, fmt.Sprintf("端口 %d 已被占用", busyPort)) {
		t.Fatalf("message = %q, want it to name the occupied port", message)
	}
	if stored := env.store.Snapshot().System.AdminListen; stored != ":3113" {
		t.Fatalf("the configuration must not change, adminListen = %q", stored)
	}
	if info := srv.Info(); info.Listen != addr {
		t.Fatalf("the listener must stay on %q, got %q", addr, info.Listen)
	}
	if status, err := getURL(t, "http://"+addr+"/healthz"); err != nil || status != http.StatusOK {
		t.Fatalf("the old listener must keep serving: status=%d err=%v", status, err)
	}
}

func TestUpdateSettingsRejectsInvalidListenAddresses(t *testing.T) {
	env := newTestEnv(t)
	_, addr := startAdminListener(t, env, adminlisten.SourceConfig, "")
	cookies, csrf := login(t, env)

	for _, bad := range []string{"abc", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000"} {
		settings := currentSettings(env)
		settings.AdminListen = bad
		rec := env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
			map[string]string{"X-CSRF-Token": csrf})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("saving %q = %d, want 400: %s", bad, rec.Code, rec.Body.String())
		}
		if !strings.Contains(errorMessage(t, rec), "监听地址") {
			t.Fatalf("saving %q must explain the invalid listen address: %s", bad, rec.Body.String())
		}
	}
	if status, err := getURL(t, "http://"+addr+"/healthz"); err != nil || status != http.StatusOK {
		t.Fatalf("the listener must stay reachable: status=%d err=%v", status, err)
	}
}

func TestImportConfigRebindsAndReturnsTheEffectiveAddress(t *testing.T) {
	env := newTestEnv(t)
	srv, oldAddr := startAdminListener(t, env, adminlisten.SourceConfig, "")
	cookies, csrf := login(t, env)
	target := addrOf(freePort(t))

	cfg := env.store.Snapshot()
	cfg.System.AdminListen = target
	rec := env.do(t, http.MethodPut, "/api/v1/system/config", map[string]any{"config": cfg}, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /system/config = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Status      string `json:"status"`
		AdminListen string `json:"adminListen"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Status != "imported" || body.AdminListen != target {
		t.Fatalf("import response = %+v, want imported and adminListen %q", body, target)
	}
	if info := srv.Info(); info.Listen != target {
		t.Fatalf("the listener is on %q, want %q", info.Listen, target)
	}
	waitHTTP(t, "http://"+target+"/healthz", http.StatusOK)
	waitUnreachable(t, "http://"+oldAddr+"/healthz")
}
