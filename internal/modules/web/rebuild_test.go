package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
)

// A reconfiguration that gives up waiting must not take the rebuild slot. The
// old implementation took a mutex from a helper goroutine, so a caller that was
// cancelled or timed out left that goroutine behind: it acquired the mutex later
// and never released it, which blocked every following reload for its full
// configWait budget and made Stop hang forever.
func TestRebuildGateSurvivesACancelledApply(t *testing.T) {
	store := testConfigStore(t)
	w := New(testDeps(t, store))

	// Simulate a reconfiguration that is already running and holds the slot.
	w.rebuildSem <- struct{}{}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.apply(ctx, w.snapshot()) }()

	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a cancelled apply returned no error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("apply did not return after its context was cancelled")
	}

	// Release the simulated rebuild. The cancelled caller must not have left
	// anything behind that grabs the slot afterwards.
	<-w.rebuildSem

	// A later rebuild has to run right away instead of waiting for the 30s
	// timeout that the leaked lock used to cause.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	if err := w.apply(ctx2, w.snapshot()); err != nil {
		t.Fatalf("apply after a cancelled one: %v", err)
	}

	// And a shutdown must still finish promptly.
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	if err := w.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

// http.MaxBytesReader flags the response through an interface with an
// unexported method, so it must be handed the real writer instead of a
// middleware wrapper; otherwise the server drains an oversized upload.
func TestUnderlyingWriterReachesTheRealWriter(t *testing.T) {
	base := httptest.NewRecorder()
	wrapped := &accessRecorder{ResponseWriter: base}
	if got := underlyingWriter(wrapped); got != http.ResponseWriter(base) {
		t.Fatalf("underlyingWriter returned %T, want the recorder", got)
	}
	if got := underlyingWriter(base); got != base {
		t.Fatalf("underlyingWriter changed a plain writer: %T", got)
	}
}

// A rule whose upstream changed must not keep the proxy (and its idle
// connections) of the old upstream in the global cache forever.
func TestProxyCacheIsPrunedOnReload(t *testing.T) {
	store := testConfigStore(t)
	w := New(testDeps(t, store))

	oldTarget := &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9001"}}
	oldURL, err := parseTarget(oldTarget.Targets[0])
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}
	oldKey := proxyCacheKey("r1", oldURL.Scheme+"://"+oldURL.Host, oldTarget)
	oldRule := &rule{id: "r1", name: "old", spec: &model.WebRule{ID: "r1", Proxy: oldTarget}}
	proxyFor(w, oldRule, upstream{url: oldURL, target: oldURL.Scheme + "://" + oldURL.Host}, oldTarget)
	if _, ok := proxyCache.Load(oldKey); !ok {
		t.Fatal("the proxy was not cached")
	}

	newTarget := &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9002"}}
	newRule := &rule{id: "r1", name: "new", spec: &model.WebRule{ID: "r1", Proxy: newTarget}}
	pruneProxyCache([]*rule{newRule})

	if _, ok := proxyCache.Load(oldKey); ok {
		t.Fatal("the proxy of the replaced upstream is still cached")
	}

	// A rule that is still configured keeps its entry.
	newURL, err := parseTarget(newTarget.Targets[0])
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}
	newKey := proxyCacheKey("r1", newURL.Scheme+"://"+newURL.Host, newTarget)
	proxyFor(w, newRule, upstream{url: newURL, target: newURL.Scheme + "://" + newURL.Host}, newTarget)
	pruneProxyCache([]*rule{newRule})
	if _, ok := proxyCache.Load(newKey); !ok {
		t.Fatal("a proxy that is still in use was pruned")
	}
}
