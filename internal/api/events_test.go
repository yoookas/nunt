package api

import "testing"

// The subscriber channel must stay open after the subscriber leaves. Publish
// copies the subscriber list under the lock and sends outside of it, so closing
// a channel during unsubscribe races with a send that already holds the copied
// reference and panics with "send on closed channel" whenever a browser
// disconnects while a log line is fanned out.
func TestEventHubUnsubscribeLeavesChannelOpen(t *testing.T) {
	h := newEventHub()
	ch, cancel, ok := h.subscribe()
	if !ok {
		t.Fatal("the first subscriber was refused")
	}
	cancel()

	select {
	case _, ok := <-ch:
		if !ok {
			t.Fatal("cancel closed the subscriber channel")
		}
	default:
	}

	// Publishing after the subscriber is gone has to be a harmless no-op.
	h.Publish("log", map[string]any{"message": "after unsubscribe"})
	if got := len(h.subs); got != 0 {
		t.Fatalf("subscriptions after cancel = %d, want 0", got)
	}
}

// Event streams hold a goroutine and a buffer each, so the hub refuses the
// connection that would exceed the bound instead of piling up another one.
func TestEventHubBoundsSubscribers(t *testing.T) {
	h := newEventHub()
	cancels := make([]func(), 0, maxSubscribers)
	for i := 0; i < maxSubscribers; i++ {
		_, cancel, ok := h.subscribe()
		if !ok {
			t.Fatalf("subscriber %d was refused below the limit", i)
		}
		cancels = append(cancels, cancel)
	}
	if _, _, ok := h.subscribe(); ok {
		t.Fatal("the hub accepted a subscriber past the limit")
	}

	// A stream that goes away frees its slot.
	cancels[0]()
	if _, cancel, ok := h.subscribe(); !ok {
		t.Fatal("the slot was not released when a subscriber left")
	} else {
		cancel()
	}
}
