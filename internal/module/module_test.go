package module

import (
	"testing"

	"github.com/nunt/nunt/internal/logging"
)

// The run log page has a component column and reads it from this attribute;
// a module logger that tagged "module" instead left the column empty.
func TestDepsLoggerTagsComponent(t *testing.T) {
	hub := logging.New("debug", "")
	defer hub.Close()
	deps := &Deps{Log: hub}

	// The text handler writes to the process output during the test; the ring
	// keeps the same record for the API and the page.
	deps.Logger("web").Info("hello")

	entries := hub.Recent(1)
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	if got := entries[0].Attrs["component"]; got != "web" {
		t.Fatalf("component = %v, want web: %+v", got, entries[0].Attrs)
	}
	if _, ok := entries[0].Attrs["module"]; ok {
		t.Fatalf("the old attribute is still there: %+v", entries[0].Attrs)
	}
}
