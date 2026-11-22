package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/rest"
)

// maxSubscribers bounds the number of concurrent event streams. Every stream
// holds a goroutine and a buffer, so an unreasonable number of open tabs must
// not be able to exhaust the process.
const maxSubscribers = 64

// eventHub fans out log lines and module events to the UI over SSE.
type eventHub struct {
	mu   sync.Mutex
	subs map[int]chan []byte
	id   int
}

type envelope struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

func newEventHub() *eventHub {
	return &eventHub{subs: map[int]chan []byte{}}
}

// sseWriteTimeout bounds one write to an event stream.
const sseWriteTimeout = 10 * time.Second

// Publish sends an event to every subscriber.
func (h *eventHub) Publish(eventType string, data any) {
	payload, err := json.Marshal(envelope{Type: eventType, Data: data})
	if err != nil {
		return
	}
	h.mu.Lock()
	subs := make([]chan []byte, 0, len(h.subs))
	for _, c := range h.subs {
		subs = append(subs, c)
	}
	h.mu.Unlock()
	for _, c := range subs {
		select {
		case c <- payload:
		default:
		}
	}
}

// PublishLog forwards a log entry.
func (h *eventHub) PublishLog(e logging.Entry) { h.Publish("log", e) }

// subscribe registers one stream. It reports false when the hub is full, so the
// caller can answer 503 instead of piling up another goroutine.
func (h *eventHub) subscribe() (<-chan []byte, func(), bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subs) >= maxSubscribers {
		return nil, nil, false
	}
	h.id++
	id := h.id
	ch := make(chan []byte, 128)
	h.subs[id] = ch
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		// The payload channel is deliberately left open. Publish copies the
		// subscriber list under the lock and sends outside of it, so closing
		// the channel here would race with a send that already holds the copy
		// and panic with "send on closed channel" whenever a browser
		// disconnects while a log line is being fanned out. The reader leaves
		// on the request context instead, and the buffered channel is
		// reclaimed once no sender references it any more.
		delete(h.subs, id)
	}, true
}

// Broadcast publishes an event from other packages.
func (s *Server) Broadcast(eventType string, data any) { s.events.Publish(eventType, data) }

// BroadcastLogs starts forwarding the log hub into the SSE stream. Calling it
// more than once is harmless.
func (s *Server) BroadcastLogs() {
	s.logOnce.Do(func() {
		ch, _ := s.opts.Log.Subscribe()
		go func() {
			for entry := range ch {
				s.events.PublishLog(entry)
			}
		}()
	})
}

func (s *Server) registerEvents() {
	s.mux.Get("/api/v1/events", s.handleEvents)
	// Keep the browser session alive while the stream is open.
	s.mux.Get("/api/v1/events/ping", func(w http.ResponseWriter, r *http.Request) {
		rest.OK(w, map[string]any{"time": time.Now()})
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		rest.Fail(w, http.StatusInternalServerError, "当前连接不支持流式响应")
		return
	}
	// Reserve the slot before the stream headers are written: once 200 is on
	// the wire a 503 can no longer be sent.
	ch, cancel, subscribed := s.events.subscribe()
	if !subscribed {
		rest.Fail(w, http.StatusServiceUnavailable, "事件流连接数已达上限，请关闭多余的页面后重试")
		return
	}
	defer cancel()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// A slow client must not pin a goroutine forever: every write gets a
	// deadline instead of the default (which is none for a stream).
	rc := http.NewResponseController(w)
	send := func(payload []byte) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Send the recent backlog so a freshly opened page is not empty.
	for _, entry := range s.opts.Log.Recent(100) {
		if payload, err := json.Marshal(envelope{Type: "log", Data: entry}); err == nil {
			if !send(payload) {
				return
			}
		}
	}

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case payload, ok := <-ch:
			if !ok {
				return
			}
			if !send(payload) {
				return
			}
		}
	}
}
