package web

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// requestNote collects the details of one request that only the handlers know
// (why it was refused, what the upstream answered, how many attempts) so the
// access log can store them.
type requestNote struct {
	mu             sync.Mutex
	reason         string
	err            string
	upstreamStatus int
	attempts       int
}

func (n *requestNote) setReason(reason string) {
	if n == nil || reason == "" {
		return
	}
	n.mu.Lock()
	if n.reason == "" {
		n.reason = reason
	}
	n.mu.Unlock()
}

func (n *requestNote) setError(err error) {
	if n == nil || err == nil {
		return
	}
	n.mu.Lock()
	n.err = err.Error()
	n.mu.Unlock()
}

func (n *requestNote) setAttempts(count int) {
	if n == nil || count <= 0 {
		return
	}
	n.mu.Lock()
	n.attempts = count
	n.mu.Unlock()
}

func (n *requestNote) setUpstreamStatus(status int) {
	if n == nil || status <= 0 {
		return
	}
	n.mu.Lock()
	n.upstreamStatus = status
	n.mu.Unlock()
}

func (n *requestNote) snapshot() (reason, errText string, upstreamStatus, attempts int) {
	if n == nil {
		return "", "", 0, 0
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.reason, n.err, n.upstreamStatus, n.attempts
}

type requestIDKey struct{}
type requestNoteKey struct{}

func withRequestInfo(ctx context.Context) (context.Context, string, *requestNote) {
	id := newRequestID()
	note := &requestNote{}
	ctx = context.WithValue(ctx, requestIDKey{}, id)
	ctx = context.WithValue(ctx, requestNoteKey{}, note)
	return ctx, id, note
}

func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func noteFrom(ctx context.Context) *requestNote {
	note, _ := ctx.Value(requestNoteKey{}).(*requestNote)
	return note
}

func newRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(buf[:])
}
