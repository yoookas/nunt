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

// Delivery retry policy: three attempts with exponential backoff, capped at
// maxBackoff. Transient failures (network errors, 429 and 5xx) are retried;
// any other 4xx is final because the payload will never be accepted.
const (
	defaultMaxAttempts = 3
	defaultBackoff     = 500 * time.Millisecond
	maxBackoff         = 5 * time.Second
)

// Service sends notifications.
type Service struct {
	cfg    *config.Store
	log    *slog.Logger
	client *http.Client
	wg     sync.WaitGroup

	maxAttempts int
	backoff     time.Duration
	// sleep waits between two attempts; tests replace it to stay fast.
	sleep func(context.Context, time.Duration) bool
}

// New creates the notification service.
func New(cfg *config.Store, log *slog.Logger) *Service {
	return &Service{
		cfg:         cfg,
		log:         log,
		client:      httpc.New(15*time.Second, false),
		maxAttempts: defaultMaxAttempts,
		backoff:     defaultBackoff,
		sleep:       sleepContext,
	}
}

// sleepContext waits for d or until the context is done. It reports whether the
// wait completed.
func sleepContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
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
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			if err := s.deliver(ctx, wh, body); err != nil {
				s.log.Warn("notify: delivery failed", "webhook", wh.Name, "error", err)
			}
		}()
	}
}

// deliver posts one payload, retrying transient failures with exponential
// backoff. It returns the last error when every attempt failed.
func (s *Service) deliver(ctx context.Context, wh model.Webhook, body []byte) error {
	method := wh.Method
	if method == "" {
		method = http.MethodPost
	}
	delay := s.backoff
	var last error
	for attempt := 1; attempt <= s.maxAttempts; attempt++ {
		err, retryable := s.attempt(ctx, method, wh, body)
		if err == nil {
			return nil
		}
		last = err
		if !retryable || attempt == s.maxAttempts {
			break
		}
		if !s.sleep(ctx, delay) {
			break
		}
		delay *= 2
		if delay > maxBackoff {
			delay = maxBackoff
		}
	}
	return last
}

// attempt performs one delivery and reports whether a failure may be retried.
func (s *Service) attempt(ctx context.Context, method string, wh model.Webhook, body []byte) (error, bool) {
	req, err := http.NewRequestWithContext(ctx, method, wh.URL, bytes.NewReader(body))
	if err != nil {
		return err, false
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range wh.Headers {
		req.Header.Set(k, v)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err, true
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil, false
	}
	return &StatusError{Code: resp.StatusCode}, resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
}

// SendTest delivers a test payload and returns the delivery error, if any. It
// uses the same retry policy as a real notification, so the button tells the
// operator what a real event would experience.
func (s *Service) SendTest(wh model.Webhook) error {
	body, _ := json.Marshal(map[string]any{
		"event":   EventTest,
		"title":   "nunt test notification",
		"message": "If you can read this, the webhook works.",
		"time":    time.Now().Format(time.RFC3339),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.deliver(ctx, wh, body)
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
