package adminlisten

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// freePort reserves a port and releases it, so the test can bind it later.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port
}

func addrOf(port int) string { return fmt.Sprintf("127.0.0.1:%d", port) }

func newClient() *http.Client {
	return &http.Client{
		Timeout:   3 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true},
	}
}

// get returns the status and body of a request, or the transport error.
func get(url string) (int, string, error) {
	resp, err := newClient().Get(url)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(body), nil
}

func textHandler(text string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, text)
	})
}

// startServer serves text on a free port and returns the manager plus its
// address. The drain delay is shortened so tests stay fast.
func startServer(t *testing.T, info Info, handler http.Handler) (*Server, string) {
	t.Helper()
	if info.Listen == "" {
		info.Listen = addrOf(freePort(t))
	}
	if info.ConfigListen == "" {
		info.ConfigListen = info.Listen
	}
	srv := NewServer(handler, nil, info)
	srv.drain = 50 * time.Millisecond
	if err := srv.Serve(""); err != nil {
		t.Fatalf("Serve(%q): %v", info.Listen, err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv, info.Listen
}

// waitClosed waits until nothing answers on addr anymore.
func waitClosed(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, err := get("http://" + addr + "/"); err != nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("the listener on %s is still accepting connections", addr)
}

func TestRebindMovesTheListener(t *testing.T) {
	from := addrOf(freePort(t))
	to := addrOf(freePort(t))
	srv, _ := startServer(t, Info{Listen: from, Source: SourceConfig}, textHandler("admin"))

	if status, body, err := get("http://" + from + "/healthz"); err != nil || status != http.StatusOK || body != "admin" {
		t.Fatalf("old address before the rebind: status=%d body=%q err=%v", status, body, err)
	}
	if err := srv.Rebind(to); err != nil {
		t.Fatalf("Rebind(%q) = %v", to, err)
	}
	if status, body, err := get("http://" + to + "/healthz"); err != nil || status != http.StatusOK || body != "admin" {
		t.Fatalf("new address after the rebind: status=%d body=%q err=%v", status, body, err)
	}
	if info := srv.Info(); info.Listen != to {
		t.Fatalf("Info().Listen = %q, want %q", info.Listen, to)
	}
	waitClosed(t, from)
}

func TestRebindToSameAddressIsANoOp(t *testing.T) {
	addr := addrOf(freePort(t))
	srv, _ := startServer(t, Info{Listen: addr, Source: SourceConfig}, textHandler("same"))

	if err := srv.Rebind("  " + addr + " "); err != nil {
		t.Fatalf("Rebind to the current address = %v, want nil", err)
	}
	if status, _, err := get("http://" + addr + "/"); err != nil || status != http.StatusOK {
		t.Fatalf("the listener must stay reachable: status=%d err=%v", status, err)
	}
}

func TestRebindOccupiedPortKeepsTheOldListener(t *testing.T) {
	oldAddr := addrOf(freePort(t))
	busyPort := freePort(t)
	blocker, err := net.Listen("tcp", addrOf(busyPort))
	if err != nil {
		t.Fatalf("occupy the target port: %v", err)
	}
	defer func() { _ = blocker.Close() }()

	srv, _ := startServer(t, Info{Listen: oldAddr, Source: SourceConfig}, textHandler("still-here"))

	err = srv.Rebind(addrOf(busyPort))
	if err == nil {
		t.Fatal("Rebind to an occupied port must fail")
	}
	var rebindErr *RebindError
	if !errors.As(err, &rebindErr) {
		t.Fatalf("error %T is not a *RebindError: %v", err, err)
	}
	if rebindErr.Kind != KindInUse {
		t.Fatalf("error kind = %q, want %q (%v)", rebindErr.Kind, KindInUse, err)
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("端口 %d 已被占用", busyPort)) {
		t.Fatalf("error message = %q, want it to name the occupied port", err)
	}
	if info := srv.Info(); info.Listen != oldAddr {
		t.Fatalf("Info().Listen = %q, want the old address %q", info.Listen, oldAddr)
	}
	if status, body, err := get("http://" + oldAddr + "/"); err != nil || status != http.StatusOK || body != "still-here" {
		t.Fatalf("the old listener must keep serving: status=%d body=%q err=%v", status, body, err)
	}
}

func TestRebindRejectedWhenTheEnvironmentControlsTheAddress(t *testing.T) {
	from := addrOf(freePort(t))
	to := addrOf(freePort(t))
	srv, _ := startServer(t, Info{Listen: from, ConfigListen: from, Source: SourceEnv, EnvVar: EnvListen}, textHandler("env"))

	err := srv.Rebind(to)
	if err == nil {
		t.Fatal("a rebind must be rejected while the environment controls the address")
	}
	var rebindErr *RebindError
	if !errors.As(err, &rebindErr) {
		t.Fatalf("error %T is not a *RebindError: %v", err, err)
	}
	if rebindErr.Kind != KindEnv {
		t.Fatalf("error kind = %q, want %q (%v)", rebindErr.Kind, KindEnv, err)
	}
	for _, want := range []string{"NUNT_ADMIN_LISTEN", "环境变量", "修改配置不会生效"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error message = %q, want it to contain %q", err, want)
		}
	}
	if status, _, err := get("http://" + from + "/"); err != nil || status != http.StatusOK {
		t.Fatalf("the old listener must keep serving: status=%d err=%v", status, err)
	}
	if _, _, err := get("http://" + to + "/"); err == nil {
		t.Fatal("nothing may be listening on the rejected address")
	}
}

func TestRebindRejectsInvalidAddresses(t *testing.T) {
	addr := addrOf(freePort(t))
	srv, _ := startServer(t, Info{Listen: addr, Source: SourceConfig}, textHandler("valid"))

	for _, bad := range []string{"", "abc", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000"} {
		err := srv.Rebind(bad)
		if err == nil {
			t.Fatalf("Rebind(%q) must fail", bad)
		}
		var rebindErr *RebindError
		if !errors.As(err, &rebindErr) {
			t.Fatalf("Rebind(%q) error %T is not a *RebindError: %v", bad, err, err)
		}
		if rebindErr.Kind != KindInvalid {
			t.Fatalf("Rebind(%q) kind = %q, want %q", bad, rebindErr.Kind, KindInvalid)
		}
	}
	if status, _, err := get("http://" + addr + "/"); err != nil || status != http.StatusOK {
		t.Fatalf("the listener must survive invalid values: status=%d err=%v", status, err)
	}
}

func TestServeReportsInvalidAddress(t *testing.T) {
	srv := NewServer(textHandler("x"), nil, Info{Listen: "abc"})
	err := srv.Serve("")
	var rebindErr *RebindError
	if !errors.As(err, &rebindErr) || rebindErr.Kind != KindInvalid {
		t.Fatalf("Serve with an invalid address = %v, want a KindInvalid RebindError", err)
	}
}

// TestRebindKeepsTheInFlightResponse proves the ordering guarantee: a request
// that is still being handled on the old listener when the rebind happens
// receives its complete response, so saving the new address from the old port
// is not a blind write.
func TestRebindKeepsTheInFlightResponse(t *testing.T) {
	from := addrOf(freePort(t))
	to := addrOf(freePort(t))
	entered := make(chan struct{})
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			close(entered)
			<-release
			_, _ = io.WriteString(w, "saved")
			return
		}
		_, _ = io.WriteString(w, "ok")
	})
	srv := NewServer(handler, nil, Info{Listen: from, Source: SourceConfig})
	srv.drain = 100 * time.Millisecond
	if err := srv.Serve(""); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })

	type result struct {
		status int
		body   string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		status, body, err := get("http://" + from + "/slow")
		done <- result{status: status, body: body, err: err}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the slow request never reached the handler")
	}

	if err := srv.Rebind(to); err != nil {
		t.Fatalf("Rebind: %v", err)
	}
	if status, _, err := get("http://" + to + "/"); err != nil || status != http.StatusOK {
		t.Fatalf("the new listener must serve right away: status=%d err=%v", status, err)
	}
	// Let the drain window elapse: Shutdown is already waiting for the active
	// request and must not cut its response.
	time.Sleep(250 * time.Millisecond)
	close(release)

	select {
	case got := <-done:
		if got.err != nil || got.status != http.StatusOK || got.body != "saved" {
			t.Fatalf("the in-flight response was lost: status=%d body=%q err=%v", got.status, got.body, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight request never completed")
	}
	waitClosed(t, from)
}

func TestCloseStopsTheListenerAndIsIdempotent(t *testing.T) {
	addr := addrOf(freePort(t))
	srv, _ := startServer(t, Info{Listen: addr, Source: SourceConfig}, textHandler("bye"))
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	waitClosed(t, addr)
	if err := srv.Close(); err != nil {
		t.Fatalf("the second Close must be a no-op, got %v", err)
	}
	if err := srv.Serve(addr); err == nil {
		t.Fatal("Serve after Close must fail")
	}
}
