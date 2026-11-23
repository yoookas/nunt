package forward

import (
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nunt/nunt/internal/ipfilter"
	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
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

// persist copies a connection entry to the persistent access log. It honours
// the same enable switch as the in memory ring.
func (f *Forward) persist(e accessEntry) {
	if f.deps == nil || f.deps.Logs == nil || !f.access.enabledNow() {
		return
	}
	f.deps.Logs.Append(logstore.Entry{
		Time:       e.Time,
		Source:     logstore.SourceForward,
		RuleID:     e.RuleID,
		Rule:       e.Rule,
		Protocol:   e.Protocol,
		ClientIP:   bareHost(e.Client),
		Upstream:   e.Target,
		Result:     e.Result,
		DurationMs: e.Duration.Milliseconds(),
		Bytes:      e.BytesIn + e.BytesOut,
		BytesIn:    e.BytesIn,
		BytesOut:   e.BytesOut,
	})
}

// bareHost strips the port of a "host:port" peer address so the stored client
// matches the shape the web and WAF records use (and the IP filter works the
// same way for every source).
func bareHost(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
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
	mode   string
	filter *ipfilter.Filter
	err    error
}

var accessCache sync.Map // fingerprint string -> *accessMatcher

// loadAccess compiles (and caches) an access rule. An invalid list makes the
// rule fail closed: a typo must never silently expose a port.
func loadAccess(a model.Access, geo ipfilter.Lookup) *accessMatcher {
	if a.Mode == "" || a.Mode == model.AccessOff {
		return &accessMatcher{mode: model.AccessOff}
	}
	key := accessFingerprint(a) + "|geo=" + fmt.Sprintf("%p", geo)
	if cached, ok := accessCache.Load(key); ok {
		return cached.(*accessMatcher)
	}
	m := &accessMatcher{mode: a.Mode}
	filter, err := ipfilter.Compile(a, geo)
	if err != nil {
		m.err = err
	} else {
		m.filter = filter
	}
	accessCache.Store(key, m)
	return m
}

func (m *accessMatcher) allows(ip net.IP) (bool, string) {
	if m == nil {
		return true, ""
	}
	if m.err != nil {
		return false, "invalid-access"
	}
	return m.filter.Allowed(ip)
}

// allow evaluates the access rule of the rule for a peer address and reports
// refusals.
func (f *Forward) allow(r model.ForwardRule, remote net.Addr) bool {
	ip := clientIP(remote)
	m := loadAccess(r.Access, f.deps.Geo)
	allowed, reason := m.allows(ip)
	if allowed {
		return true
	}
	f.log.Warn("forward: source address rejected",
		"rule", ruleLabel(r), "client", addrString(remote), "mode", r.Access.Mode,
		"reason", reason, "error", m.err)
	return false
}
