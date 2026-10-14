package waf

import (
	"sync"
	"sync/atomic"
	"time"
)

// defaultWouldRejectKeep is the size of the "would reject" ring buffer.
const defaultWouldRejectKeep = 500

// Violation is one request the body policy refused, or would have refused while
// the module runs in observe mode. It is what an operator reads to find the
// routes whose body declaration has to be fixed before switching to enforce.
type Violation struct {
	Time     time.Time `json:"time"`
	Rule     string    `json:"rule,omitempty"`
	ClientIP string    `json:"clientIp,omitempty"`
	Method   string    `json:"method,omitempty"`
	Host     string    `json:"host,omitempty"`
	URI      string    `json:"uri,omitempty"`
	// Reason names the decision that refused the request.
	Reason string `json:"reason"`
	// Status is the HTTP status the request would have received. A gRPC request
	// is answered with HTTP 200 and a gRPC status, which is what Status holds
	// for it.
	Status int `json:"status"`
	// GRPCStatus is the gRPC status of the refusal, zero for a plain HTTP
	// request.
	GRPCStatus int `json:"grpcStatus,omitempty"`
	// Policy is the body policy that was applied.
	Policy string `json:"policy"`
	// State is what the module did with the body instead.
	State string `json:"bodyState,omitempty"`
	// Message is the text the client would have been shown.
	Message string `json:"message,omitempty"`
	// Enforced is false when observe mode let the request through.
	Enforced bool `json:"enforced"`
}

// bodyRecorder keeps the request body counters of the module: the bodyState
// distribution, the "would reject" ring buffer and the gRPC counters.
type bodyRecorder struct {
	mu          sync.Mutex
	states      map[bodyState]int64
	violations  []Violation
	next        int
	full        bool
	wouldReject atomic.Int64
	refused     atomic.Int64

	grpcRequests    atomic.Int64
	grpcUnary       atomic.Int64
	grpcStream      atomic.Int64
	grpcServerFirst atomic.Int64
	grpcFrameErrors atomic.Int64
	grpcSecondMsg   atomic.Int64
	grpcMessages    atomic.Int64
	grpcCompressed  atomic.Int64
}

func newBodyRecorder() *bodyRecorder {
	return &bodyRecorder{
		states:     map[bodyState]int64{},
		violations: make([]Violation, defaultWouldRejectKeep),
	}
}

// note records what the policy did with the body of one request.
func (r *bodyRecorder) note(state bodyState) {
	r.mu.Lock()
	r.states[state]++
	r.mu.Unlock()
}

// counts returns the bodyState distribution.
func (r *bodyRecorder) counts() map[string]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]int64, len(bodyStates))
	for _, s := range bodyStates {
		out[string(s)] = r.states[s]
	}
	return out
}

// add stores one refusal, overwriting the oldest entry when the buffer is full.
func (r *bodyRecorder) add(v Violation) {
	if v.Time.IsZero() {
		v.Time = time.Now()
	}
	if v.Enforced {
		r.refused.Add(1)
	} else {
		r.wouldReject.Add(1)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.violations[r.next] = v
	r.next = (r.next + 1) % len(r.violations)
	if r.next == 0 {
		r.full = true
	}
}

// list returns up to limit refusals, newest first.
func (r *bodyRecorder) list(limit int) []Violation {
	r.mu.Lock()
	defer r.mu.Unlock()
	size := r.next
	if r.full {
		size = len(r.violations)
	}
	if limit <= 0 || limit > size {
		limit = size
	}
	out := make([]Violation, 0, limit)
	for i := 0; i < limit; i++ {
		idx := (r.next - 1 - i + len(r.violations)*2) % len(r.violations)
		out = append(out, r.violations[idx])
	}
	return out
}

// clear drops the buffered refusals.
func (r *bodyRecorder) clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.violations = make([]Violation, len(r.violations))
	r.next, r.full = 0, false
}

// size reports how many refusals are buffered.
func (r *bodyRecorder) size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.full {
		return len(r.violations)
	}
	return r.next
}

// stats exposes the body policy counters to the UI.
func (r *bodyRecorder) stats() map[string]any {
	states := r.counts()
	full := states[string(stateFull)]
	var total int64
	for _, n := range states {
		total += n
	}
	other := total - full
	ratio := float64(0)
	if total > 0 {
		ratio = float64(other) / float64(total)
	}
	return map[string]any{
		"bodyStates":        states,
		"bodyRequests":      total,
		"bodyFull":          full,
		"bodyNonFull":       other,
		"bodyNonFullRatio":  ratio,
		"wouldReject":       r.wouldReject.Load(),
		"refused":           r.refused.Load(),
		"wouldRejectKept":   r.size(),
		"wouldRejectLimit":  defaultWouldRejectKeep,
		"grpcRequests":      r.grpcRequests.Load(),
		"grpcUnary":         r.grpcUnary.Load(),
		"grpcStream":        r.grpcStream.Load(),
		"grpcServerFirst":   r.grpcServerFirst.Load(),
		"grpcFrameErrors":   r.grpcFrameErrors.Load(),
		"grpcSecondMessage": r.grpcSecondMsg.Load(),
		"grpcMessages":      r.grpcMessages.Load(),
		"grpcCompressed":    r.grpcCompressed.Load(),
	}
}
