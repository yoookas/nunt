package forward

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// accessEntry is one line of the forwarder access log. Byte counters use the
// in/out naming of the web UI: in is client to target, out is target to client.
type accessEntry struct {
	Time     time.Time     `json:"time"`
	RuleID   string        `json:"ruleId"`
	Rule     string        `json:"rule"`
	Protocol string        `json:"protocol"`
	Client   string        `json:"client"`
	Target   string        `json:"target"`
	Result   string        `json:"result"`
	Duration time.Duration `json:"duration"`
	BytesIn  int64         `json:"bytesIn"`
	BytesOut int64         `json:"bytesOut"`
	Packets  uint64        `json:"packets,omitempty"`
}

// accessLogger keeps the most recent entries in a bounded ring. It is always
// safe to append: logging must never be able to block a relay goroutine.
type accessLogger struct {
	enabled atomic.Bool
	keep    atomic.Int64

	mu   sync.Mutex
	ring []accessEntry
}

func newAccessLogger(keep int) *accessLogger {
	l := &accessLogger{ring: []accessEntry{}}
	l.keep.Store(int64(normalizeKeep(keep)))
	return l
}

func normalizeKeep(keep int) int {
	switch {
	case keep <= 0:
		return defaultLogKeep
	case keep > maxLogKeep:
		return maxLogKeep
	default:
		return keep
	}
}

// apply enables or disables the access log. Existing entries are kept so that
// turning the log off does not wipe the history.
func (l *accessLogger) apply(enabled bool) { l.enabled.Store(enabled) }

func (l *accessLogger) enabledNow() bool { return l.enabled.Load() }

// SetKeep resizes the ring buffer, dropping the oldest entries if needed.
func (l *accessLogger) SetKeep(keep int) {
	n := normalizeKeep(keep)
	l.keep.Store(int64(n))
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.ring) > n {
		l.ring = append([]accessEntry{}, l.ring[len(l.ring)-n:]...)
	}
}

// append records one entry when the access log is enabled.
func (l *accessLogger) append(e accessEntry) {
	if !l.enabled.Load() {
		return
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	limit := int(l.keep.Load())
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ring = append(l.ring, e)
	if len(l.ring) > limit {
		l.ring = append([]accessEntry{}, l.ring[len(l.ring)-limit:]...)
	}
}

// list returns up to limit entries, newest first, optionally filtered by rule.
func (l *accessLogger) list(ruleID string, limit int) []accessEntry {
	if limit <= 0 || limit > maxLogKeep {
		limit = defaultLogKeep
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]accessEntry, 0, limit)
	for i := len(l.ring) - 1; i >= 0 && len(out) < limit; i-- {
		if ruleID != "" && l.ring[i].RuleID != ruleID {
			continue
		}
		out = append(out, l.ring[i])
	}
	return out
}

// clear drops every entry.
func (l *accessLogger) clear() {
	l.mu.Lock()
	l.ring = []accessEntry{}
	l.mu.Unlock()
}

// accessMatcher is a compiled model.Access rule.
type accessMatcher struct {
	mode string
	nets []*net.IPNet
	err  error
}

var accessCache sync.Map // fingerprint string -> *accessMatcher

// loadAccess compiles (and caches) an access rule. An invalid list makes the
// rule fail closed: a typo must never silently expose a port.
func loadAccess(a model.Access) *accessMatcher {
	if a.Mode == "" || a.Mode == model.AccessOff {
		return &accessMatcher{mode: model.AccessOff}
	}
	key := accessFingerprint(a)
	if cached, ok := accessCache.Load(key); ok {
		return cached.(*accessMatcher)
	}
	m := &accessMatcher{mode: a.Mode}
	nets, err := netutil.ParseIPList(a.IPs)
	if err != nil {
		m.err = err
	} else {
		m.nets = nets
	}
	accessCache.Store(key, m)
	return m
}

func (m *accessMatcher) allows(ip net.IP) bool {
	if m == nil {
		return true
	}
	if m.err != nil {
		return false
	}
	return netutil.IPAllowed(m.mode, m.nets, ip)
}

// allow evaluates the access rule of the rule for a peer address and reports
// refusals.
func (f *Forward) allow(r model.ForwardRule, remote net.Addr) bool {
	ip := clientIP(remote)
	m := loadAccess(r.Access)
	if m.allows(ip) {
		return true
	}
	f.log.Warn("forward: source address rejected",
		"rule", ruleLabel(r), "client", addrString(remote), "mode", r.Access.Mode, "error", m.err)
	return false
}
