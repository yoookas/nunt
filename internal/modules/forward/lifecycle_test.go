package forward

import (
	"context"
	"github.com/nunt/nunt/internal/model"
	"net"
	"testing"
)

// A rule whose source port is taken is switched off and persisted as disabled,
// so a reload does not retry the bind on every configuration change.
func TestReloadAutoDisablesBusyPort(t *testing.T) {
	deps, store := testDeps(t)
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("blocker: %v", err)
	}
	defer func() { _ = blocker.Close() }()
	addr := blocker.Addr().String()

	if err := store.Update(func(c *model.Config) error {
		c.Forward.Rules = []model.ForwardRule{{
			ID: "busy", Name: "busy", Enable: true, Protocol: "tcp",
			SrcAddr: addr, DstAddr: "127.0.0.1:9",
		}}
		return nil
	}); err != nil {
		t.Fatalf("seed rule: %v", err)
	}
	f := New(deps)
	f.Reload(store.Snapshot())

	rule := store.Snapshot().Forward.Rules[0]
	if !rule.Disabled {
		t.Fatal("the busy rule must be marked disabled")
	}
	if f.Stats()["listening"].(int) != 0 {
		t.Fatalf("stats: %v", f.Stats())
	}

	// Freeing the port and turning the switch on binds it again.
	_ = blocker.Close()
	if err := store.Update(func(c *model.Config) error {
		c.Forward.Rules[0].Enable = true
		c.Forward.Rules[0].Disabled = false
		return nil
	}); err != nil {
		t.Fatalf("enable rule: %v", err)
	}
	f.Reload(store.Snapshot())
	rule = store.Snapshot().Forward.Rules[0]
	if rule.Disabled {
		t.Fatalf("the rule must start once the port is free: %+v", rule)
	}
	if got := f.Stats()["listening"].(int); got != 1 {
		t.Fatalf("listening = %d, want 1", got)
	}
	f.Stop(context.Background())
}
