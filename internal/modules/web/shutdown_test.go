package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// A hanging request must not keep Stop alive after its context expired: docker
// sends SIGKILL when the grace period ends, so the drain has to be bounded by
// the caller's budget instead of a fixed timeout per listener.
func TestStopIsBoundedByContext(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	defer close(release)

	addr := freeAddr(t)
	raw := mkRule(t, "slow", "example.com", "/", 0, model.WebTypeProxy)
	raw.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, Balance: "roundrobin"}

	store := testConfigStoreWithListener(t, testListener("l1", []string{addr}, model.TLSModeOff), raw)
	w := New(&module.Deps{Cfg: store, DataDir: t.TempDir(), Registry: module.NewRegistry()})
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Open one request and wait until it reaches the upstream, so the listener
	// really has something in flight when Stop runs.
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1"+addr+"/", nil)
		if err != nil {
			return
		}
		req.Host = "example.com"
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			return
		}
		_ = resp.Body.Close()
	}()
	time.Sleep(200 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := w.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Fatalf("Stop waited %v for a hanging request; the shutdown must follow its context", elapsed)
	}
	<-done
}
