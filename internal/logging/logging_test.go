package logging

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// An error value used to reach the UI as "error={}" because the interface has
// no exported fields; the hub has to store its message instead.
func TestErrorAttributesAreStoredAsText(t *testing.T) {
	hub := New("debug", "")
	t.Cleanup(hub.Close)

	hub.Logger().Error("证书签发失败",
		"error", errors.New("create TXT record: no permission"),
		"duration", 1500*time.Millisecond,
		"when", time.Unix(1700000000, 0).UTC())

	entries := hub.Recent(1)
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	attrs := entries[0].Attrs
	if got, _ := attrs["error"].(string); got != "create TXT record: no permission" {
		t.Fatalf("error attribute = %#v", attrs["error"])
	}
	if got, _ := attrs["duration"].(string); got != "1.5s" {
		t.Fatalf("duration attribute = %#v", attrs["duration"])
	}
	if got, _ := attrs["when"].(string); got != "2023-11-14T22:13:20Z" {
		t.Fatalf("time attribute = %#v", attrs["when"])
	}

	raw, err := json.Marshal(entries[0])
	if err != nil {
		t.Fatalf("marshal entry: %v", err)
	}
	if !strings.Contains(string(raw), `"error":"create TXT record: no permission"`) {
		t.Fatalf("entry json lost the error text: %s", raw)
	}
}
