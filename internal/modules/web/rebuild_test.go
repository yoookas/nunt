package web

import (
	"context"
	"testing"
	"time"
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
