package security

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestPasswordSlotSerialises proves that only one caller can hold the hashing
// slot at a time: the second acquire must wait for the first release.
func TestPasswordSlotSerialises(t *testing.T) {
	release, err := AcquirePasswordSlot(context.Background())
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	acquired := make(chan struct{})
	go func() {
		second, err := AcquirePasswordSlot(context.Background())
		if err != nil {
			t.Errorf("second acquire: %v", err)
			close(acquired)
			return
		}
		close(acquired)
		second()
	}()

	select {
	case <-acquired:
		t.Fatal("a second caller acquired the slot while it was held")
	case <-time.After(50 * time.Millisecond):
	}

	release()

	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("the queued caller did not get the slot after release")
	}
}

// TestPasswordSlotCancelledContext makes sure a caller that gives up while
// queueing never takes the slot, so it cannot block the next request.
func TestPasswordSlotCancelledContext(t *testing.T) {
	release, err := AcquirePasswordSlot(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := AcquirePasswordSlot(ctx); err == nil {
		release()
		t.Fatal("acquire with a cancelled context must fail")
	}

	// The slot is still held by this test; a fresh acquire must block and then
	// succeed after release, which proves the cancelled attempt did not steal
	// it.
	release()
	done := make(chan struct{})
	go func() {
		r, err := AcquirePasswordSlot(context.Background())
		if err == nil {
			r()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the slot was lost after a cancelled acquire")
	}
}

// TestHashPasswordRouteParameters pins the cheaper parameter set of route
// level basic auth users and checks that the hash still verifies.
func TestHashPasswordRouteParameters(t *testing.T) {
	hash, err := HashPasswordRoute("route secret")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected route hash parameters: %q", hash)
	}
	if !VerifyPassword(hash, "route secret") {
		t.Fatal("the route hash must verify its password")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("a wrong password must not verify")
	}
}

// TestVerifyPasswordHeldMatchesVerify documents that the "_Held" variant is
// the same check, for callers that already own the slot.
func TestVerifyPasswordHeldMatchesVerify(t *testing.T) {
	hash, err := HashPasswordRoute("held secret")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	release, err := AcquirePasswordSlot(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	ok := VerifyPasswordHeld(hash, "held secret")
	release()
	if !ok {
		t.Fatal("VerifyPasswordHeld rejected the correct password")
	}
}
