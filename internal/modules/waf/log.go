package waf

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// defaultEventKeep is the size of the interception ring buffer.
const defaultEventKeep = 500

// maxTrackedRules bounds the per rule counters so a hostile client cannot grow
// the bookkeeping maps without limit.
const maxTrackedRules = 512

// maxEventsPerRequest bounds how many ring entries one request may create.
const maxEventsPerRequest = 10

// Event is one intercepted (or detected) request shown in the UI.
type Event struct {
	Time     time.Time `json:"time"`
	RuleID   int       `json:"ruleId"`
	Message  string    `json:"message,omitempty"`
	ClientIP string    `json:"clientIp,omitempty"`
	Method   string    `json:"method,omitempty"`
	Host     string    `json:"host,omitempty"`
	URI      string    `json:"uri,omitempty"`
	// Rule is the web rule (site) that was protected.
	Rule     string   `json:"rule,omitempty"`
	Action   string   `json:"action"`
	Status   int      `json:"status,omitempty"`
	Severity string   `json:"severity,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	RuleIDs  []int    `json:"ruleIds,omitempty"`
	TxID     string   `json:"txId,omitempty"`
}

// ruleCount is one entry of the "top rules" list.
type ruleCount struct {
	ID      int    `json:"id"`
	Count   int64  `json:"count"`
	Message string `json:"message,omitempty"`
}

// ruleSiteCount is one entry of the "top web rules" list.
type ruleSiteCount struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// recorder keeps the rolling event buffer and every counter exposed by Stats.
type recorder struct {
	mu     sync.Mutex
	events []Event
	next   int
	full   bool
	byRule map[int]int64
	byMsg  map[int]string
	byWeb  map[string]int64

	requests atomic.Int64
	blocked  atomic.Int64
	detected atomic.Int64
	passed   atomic.Int64
	errors   atomic.Int64
	tests    atomic.Int64
}

func newRecorder(size int) *recorder {
	if size <= 0 {
		size = defaultEventKeep
	}
	return &recorder{
		events: make([]Event, size),
		byRule: map[int]int64{},
		byMsg:  map[int]string{},
		byWeb:  map[string]int64{},
	}
}

// add stores one event, overwriting the oldest entry when the buffer is full.
func (r *recorder) add(ev Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events[r.next] = ev
	r.next = (r.next + 1) % len(r.events)
	if r.next == 0 {
		r.full = true
	}
	if ev.RuleID != 0 {
		if _, seen := r.byRule[ev.RuleID]; seen || len(r.byRule) < maxTrackedRules {
			r.byRule[ev.RuleID]++
			if ev.Message != "" {
				r.byMsg[ev.RuleID] = ev.Message
			}
		}
	}
	if ev.Rule != "" {
		if _, seen := r.byWeb[ev.Rule]; seen || len(r.byWeb) < maxTrackedRules {
			r.byWeb[ev.Rule]++
		}
	}
}

// list returns up to limit events, newest first.
func (r *recorder) list(limit int) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	size := r.next
	if r.full {
		size = len(r.events)
	}
	if limit <= 0 || limit > size {
		limit = size
	}
	out := make([]Event, 0, limit)
	for i := 0; i < limit; i++ {
		idx := (r.next - 1 - i + len(r.events)*2) % len(r.events)
		out = append(out, r.events[idx])
	}
	return out
}

// clear drops the buffered events and the per rule counters.
func (r *recorder) clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = make([]Event, len(r.events))
	r.next = 0
	r.full = false
	r.byRule = map[int]int64{}
	r.byMsg = map[int]string{}
	r.byWeb = map[string]int64{}
}

// topRules returns the most frequently hit rules.
func (r *recorder) topRules(n int) []ruleCount {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ruleCount, 0, len(r.byRule))
	for id, count := range r.byRule {
		out = append(out, ruleCount{ID: id, Count: count, Message: r.byMsg[id]})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].ID < out[j].ID
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

// topWebRules returns the most frequently hit web rules.
func (r *recorder) topWebRules(n int) []ruleSiteCount {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ruleSiteCount, 0, len(r.byWeb))
	for name, count := range r.byWeb {
		out = append(out, ruleSiteCount{Name: name, Count: count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

// size reports how many events are buffered.
func (r *recorder) size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.full {
		return len(r.events)
	}
	return r.next
}
