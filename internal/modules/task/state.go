package task

import (
	"sync"
	"time"
)

// State is the runtime state of one task. It lives in memory only: it is
// recreated when the service restarts.
type State struct {
	Running      bool       `json:"running"`
	Runs         uint64     `json:"runs"`
	Successes    uint64     `json:"successes"`
	Failures     uint64     `json:"failures"`
	LastRun      *time.Time `json:"lastRun,omitempty"`
	LastDuration int64      `json:"lastDurationMs,omitempty"`
	LastResult   string     `json:"lastResult,omitempty"`
	Preview      string     `json:"preview,omitempty"`
	Logs         []LogEntry `json:"logs,omitempty"`
}

// LogEntry is one finished run of a task.
type LogEntry struct {
	Time     time.Time   `json:"time"`
	OK       bool        `json:"ok"`
	Duration int64       `json:"durationMs"`
	Error    string      `json:"error,omitempty"`
	Preview  string      `json:"preview,omitempty"`
	Actions  []ActionLog `json:"actions,omitempty"`
}

// ActionLog is the outcome of a single action inside a run.
type ActionLog struct {
	Index    int           `json:"index"`
	Type     string        `json:"type"`
	Target   string        `json:"target,omitempty"`
	OK       bool          `json:"ok"`
	Error    string        `json:"error,omitempty"`
	Output   string        `json:"output,omitempty"`
	Duration time.Duration `json:"duration"`
	Time     time.Time     `json:"time"`
}

// taskState holds the runtime flags of one task; every field is guarded by mu.
type taskState struct {
	mu      sync.Mutex
	name    string
	running bool
	runs    uint64
	ok      uint64
	failed  uint64
	lastRun time.Time
	lastDur time.Duration
	lastRes string
	preview string
	actions []ActionLog
	logs    []LogEntry
}

func newTaskState(name string) *taskState {
	return &taskState{name: name, logs: []LogEntry{}}
}

// start marks the beginning of a run.
func (s *taskState) start() {
	s.mu.Lock()
	s.running = true
	s.actions = nil
	s.mu.Unlock()
}

// addAction accumulates the outcome of one action of the current run.
func (s *taskState) addAction(entry ActionLog) {
	s.mu.Lock()
	s.actions = append(s.actions, entry)
	s.mu.Unlock()
}

// complete stores the outcome of a run, its output preview and the per-action
// log of the run in a bounded history.
func (s *taskState) complete(start time.Time, err error, preview string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	duration := time.Since(start)
	s.running = false
	s.runs++
	s.lastRun = time.Now()
	s.lastDur = duration
	s.preview = preview
	entry := LogEntry{
		Time:     s.lastRun,
		OK:       err == nil,
		Duration: duration.Milliseconds(),
		Preview:  preview,
		Actions:  append([]ActionLog{}, s.actions...),
	}
	if err != nil {
		s.failed++
		s.lastRes = "failed: " + err.Error()
		entry.Error = err.Error()
	} else {
		s.ok++
		s.lastRes = "success"
	}
	s.actions = nil
	s.logs = append(s.logs, entry)
	if len(s.logs) > maxLogEntries {
		s.logs = append([]LogEntry{}, s.logs[len(s.logs)-maxLogEntries:]...)
	}
}

func (s *taskState) close() {}

func (s *taskState) snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := State{
		Running:      s.running,
		Runs:         s.runs,
		Successes:    s.ok,
		Failures:     s.failed,
		LastDuration: s.lastDur.Milliseconds(),
		LastResult:   s.lastRes,
		Preview:      s.preview,
	}
	if !s.lastRun.IsZero() {
		t := s.lastRun
		st.LastRun = &t
	}
	if len(s.logs) > 0 {
		st.Logs = append([]LogEntry{}, s.logs...)
	}
	return st
}
