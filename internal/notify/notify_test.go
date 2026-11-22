package notify

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
)

func testService(t *testing.T, url string) *Service {
	t.Helper()
	dir := t.TempDir()
	cfg, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if err := cfg.Update(func(c *model.Config) error {
		c.Notify.Webhooks = []model.Webhook{{
			ID: "w1", Name: "test", Enable: true, URL: url,
		}}
		return nil
	}); err != nil {
		t.Fatalf("configure webhook: %v", err)
	}
	hub := logging.New("error", "")
	t.Cleanup(hub.Close)
	svc := New(cfg, hub.Logger())
	// Keep the test fast: the retry delays are the only slow part.
	svc.backoff = time.Millisecond
	return svc
}

// A transient failure is retried, and the payload still arrives.
func TestEmitRetriesTransientFailures(t *testing.T) {
	var attempts atomic.Int32
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n < 3 {
			http.Error(w, "try later", http.StatusServiceUnavailable)
			return
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["event"] != EventCertIssued {
			t.Errorf("event = %v", payload["event"])
		}
		close(done)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	svc := testService(t, server.URL)
	svc.Emit(EventCertIssued, "title", "body", nil)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the notification was not delivered, attempts = %d", attempts.Load())
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
}

// A permanent client error is not retried.
func TestEmitDoesNotRetryAClientError(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		http.Error(w, "invalid payload", http.StatusBadRequest)
	}))
	defer server.Close()

	svc := testService(t, server.URL)
	svc.Emit(EventCertIssued, "title", "body", nil)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if attempts.Load() > 0 {
			time.Sleep(100 * time.Millisecond) // give a retry a chance to show up
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, want exactly 1 for a 400", got)
	}
}
