package api

import "testing"

// The subscriber channel must stay open after the subscriber leaves. Publish
// copies the subscriber list under the lock and sends outside of it, so closing
// a channel during unsubscribe races with a send that already holds the copied
// reference and panics with "send on closed channel" whenever a browser
// disconnects while a log line is fanned out.
func TestEventHubUnsubscribeLeavesChannelOpen(t *testing.T) {
	h := newEventHub()
	ch, cancel := h.subscribe()
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
