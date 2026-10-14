// Package notify delivers outbound notifications to the configured webhooks.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/httpc"
	"github.com/nunt/nunt/internal/model"
)

// Event names used across the service.
const (
	EventCertIssued = "cert.issued"
	EventCertFailed = "cert.failed"
	EventDDNSUpdate = "ddns.update"
	EventDDNSError  = "ddns.error"
	EventTest       = "notify.test"
	EventAlert      = "system.alert"
)

// Service sends notifications.
type Service struct {
	cfg    *config.Store
	log    *slog.Logger
	client *http.Client
	wg     sync.WaitGroup
}

// New creates the notification service.
func New(cfg *config.Store, log *slog.Logger) *Service {
	return &Service{cfg: cfg, log: log, client: httpc.New(15*time.Second, false)}
}

// Emit sends an event to every matching webhook. Delivery happens in the
// background so a slow endpoint can never stall a module.
func (s *Service) Emit(event, title, message string, fields map[string]any) {
	webhooks := s.cfg.Snapshot().Notify.Webhooks
	for _, wh := range webhooks {
		if !wh.Enable || wh.URL == "" {
			continue
		}
		if len(wh.Events) > 0 && !contains(wh.Events, event) {
			continue
		}
		payload := map[string]any{
			"event":   event,
			"title":   title,
			"message": message,
			"time":    time.Now().Format(time.RFC3339),
		}
		if len(fields) > 0 {
			payload["fields"] = fields
		}
		body, err := json.Marshal(payload)
		if err != nil {
			continue
		}
		wh := wh
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			method := wh.Method
			if method == "" {
				method = http.MethodPost
			}
			req, err := http.NewRequestWithContext(ctx, method, wh.URL, bytes.NewReader(body))
			if err != nil {
				s.log.Warn("notify: bad webhook request", "webhook", wh.Name, "error", err)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			for k, v := range wh.Headers {
				req.Header.Set(k, v)
			}
			resp, err := s.client.Do(req)
			if err != nil {
				s.log.Warn("notify: delivery failed", "webhook", wh.Name, "error", err)
				return
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode >= 300 {
				s.log.Warn("notify: endpoint returned an error", "webhook", wh.Name, "status", resp.StatusCode)
			}
		}()
	}
}

// SendTest delivers a test payload and returns the delivery error, if any.
func (s *Service) SendTest(wh model.Webhook) error {
	body, _ := json.Marshal(map[string]any{
		"event":   EventTest,
		"title":   "nunt test notification",
		"message": "If you can read this, the webhook works.",
		"time":    time.Now().Format(time.RFC3339),
	})
	method := wh.Method
	if method == "" {
		method = http.MethodPost
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, wh.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range wh.Headers {
		req.Header.Set(k, v)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return &StatusError{Code: resp.StatusCode}
	}
	return nil
}

// StatusError reports a non 2xx webhook response.
type StatusError struct{ Code int }

func (e *StatusError) Error() string { return "endpoint returned HTTP " + http.StatusText(e.Code) }

// Close waits for in-flight deliveries.
func (s *Service) Close() {
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
