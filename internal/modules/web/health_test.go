package web

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

func TestBalancerTakesAnUpstreamOutOfRotation(t *testing.T) {
	b, err := newBalancer("roundrobin", []string{"http://127.0.0.1:1", "http://127.0.0.1:2"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	b.now = func() time.Time { return now }

	for i := 0; i < upstreamFailThreshold; i++ {
		b.report("http://127.0.0.1:1", false)
	}
	for i := 0; i < 6; i++ {
		if up := b.pick("192.0.2.1"); up.target != "http://127.0.0.1:2" {
			t.Fatalf("picked %s while the other upstream is down", up.target)
		}
	}

	// After the cooldown the upstream gets traffic again.
	now = now.Add(upstreamCooldown + time.Second)
	seen := map[string]bool{}
	for i := 0; i < 10; i++ {
		seen[b.pick("192.0.2.1").target] = true
	}
	if len(seen) != 2 {
		t.Fatalf("after the cooldown only %v were picked", seen)
	}

	// One success closes the circuit immediately.
	b.report("http://127.0.0.1:1", false)
	b.report("http://127.0.0.1:1", false)
	b.report("http://127.0.0.1:1", true)
	if up, ok := b.pickExcept("192.0.2.1", ""); !ok || up.target != "http://127.0.0.1:1" && up.target != "http://127.0.0.1:2" {
		t.Fatalf("unexpected pick %+v ok=%v", up, ok)
	}
	for i := 0; i < 4; i++ {
		if up := b.pick("192.0.2.1"); up.target != "http://127.0.0.1:1" && up.target != "http://127.0.0.1:2" {
			t.Fatalf("unexpected %s", up.target)
		}
	}
}

func TestBalancerKeepsTryingWhenEverythingIsDown(t *testing.T) {
	b, _ := newBalancer("roundrobin", []string{"http://127.0.0.1:1", "http://127.0.0.1:2"})
	now := time.Now()
	b.now = func() time.Time { return now }
	for i := 0; i < upstreamFailThreshold; i++ {
		b.report("http://127.0.0.1:1", false)
		b.report("http://127.0.0.1:2", false)
	}
	for i := 0; i < 4; i++ {
		if up := b.pick("192.0.2.1"); up.target == "" {
			t.Fatal("with every upstream down pick must still return a candidate")
		}
	}
	if _, ok := b.pickExcept("192.0.2.1", "http://127.0.0.1:1"); ok {
		t.Fatal("pickExcept must not return a down upstream")
	}
}

// startLBTest builds a rule with the given targets and returns the listener
// address plus a cleanup function.
func startLBTest(t *testing.T, targets []string) string {
	t.Helper()
	raw := mkRule(t, "lb", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: targets, Balance: "roundrobin"}

	addr := freeAddr(t)
	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), raw)
	w := New(&module.Deps{Cfg: store, DataDir: t.TempDir(), Registry: module.NewRegistry()})
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })
	return addr
}

func getThrough(t *testing.T, addr, method string) int {
	t.Helper()
	req, err := http.NewRequest(method, "http://127.0.0.1"+addr+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "example.com"
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestProxyRetriesIdempotentRequestsOnAnotherUpstream(t *testing.T) {
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer live.Close()

	// The first target is a port nothing listens on; round robin starts there.
	dead := "http://127.0.0.1" + freeAddr(t)
	addr := startLBTest(t, []string{dead, live.URL})

	if status := getThrough(t, addr, http.MethodGet); status != http.StatusOK {
		t.Fatalf("GET = %d, want the retry to reach the live upstream", status)
	}
}

func TestProxyDoesNotRetryUnsafeMethods(t *testing.T) {
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer live.Close()

	dead := "http://127.0.0.1" + freeAddr(t)
	addr := startLBTest(t, []string{dead, live.URL})

	if status := getThrough(t, addr, http.MethodPost); status != http.StatusBadGateway {
		t.Fatalf("POST = %d, want 502 without a retry", status)
	}
}
