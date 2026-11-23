// Package logging provides the process logger.
//
// Logs are written to stdout and (optionally) to a size rotated file, and the
// last entries are kept in memory so the web UI can display them without
// shell access. Subscribers receive entries in real time (used by the SSE
// endpoint of the admin API).
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/store"
)

// Entry is a single log record as exposed to the UI.
type Entry struct {
	Time  time.Time      `json:"time"`
	Level string         `json:"level"`
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

const (
	ringSize     = 1000
	maxFileSize  = 8 << 20
	maxFileKeep  = 3
	subChanDepth = 256
)

// Options controls the rotation of the log file.
type Options struct {
	// MaxFileMB is the size at which the file is rotated (default 8).
	MaxFileMB int
	// KeepFiles is how many rotated files are kept (default 3).
	KeepFiles int
}

func (o Options) normalize() Options {
	if o.MaxFileMB <= 0 {
		o.MaxFileMB = maxFileSize >> 20
	}
	if o.MaxFileMB > 1024 {
		o.MaxFileMB = 1024
	}
	if o.KeepFiles <= 0 {
		o.KeepFiles = maxFileKeep
	}
	if o.KeepFiles > 10 {
		o.KeepFiles = 10
	}
	return o
}

// Hub owns the logger and the in-memory ring buffer.
type Hub struct {
	mu       sync.RWMutex
	ring     []Entry
	next     int
	full     bool
	subs     map[int]chan Entry
	subID    int
	level    slog.LevelVar
	out      io.Writer
	file     *os.File
	filePath string
	fileSize int64
	maxBytes int64
	keep     int
}

var _ slog.Handler = (*handler)(nil)

// New creates a hub with the default rotation settings.
func New(level string, filePath string) *Hub {
	return NewWithOptions(level, filePath, Options{})
}

// NewWithOptions creates a hub whose log file rotates at the given size and
// keeps the given number of rotations. level accepts debug/info/warn/error;
// filePath may be empty to disable file logging.
func NewWithOptions(level string, filePath string, opts Options) *Hub {
	opts = opts.normalize()
	h := &Hub{
		ring:     make([]Entry, ringSize),
		maxBytes: int64(opts.MaxFileMB) << 20,
		keep:     opts.KeepFiles,
		subs:     map[int]chan Entry{},
		out:      os.Stdout,
	}
	h.SetLevel(level)
	if filePath != "" {
		if err := store.EnsureDir(filepath.Dir(filePath), 0o750); err == nil {
			h.filePath = filePath
			h.openFile()
		}
	}
	return h
}

// ParseLevel converts a textual level to slog.Level.
func ParseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// SetLevel updates the minimum level.
func (h *Hub) SetLevel(level string) { h.level.Set(ParseLevel(level)) }

// Level returns the current minimum level as text.
func (h *Hub) Level() string {
	switch h.level.Level() {
	case slog.LevelDebug:
		return "debug"
	case slog.LevelWarn:
		return "warn"
	case slog.LevelError:
		return "error"
	default:
		return "info"
	}
}

// Logger returns a logger writing to the hub.
func (h *Hub) Logger() *slog.Logger {
	return slog.New(&handler{hub: h})
}

func (h *Hub) openFile() {
	f, err := os.OpenFile(h.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		fmt.Fprintf(os.Stderr, "logging: cannot open %s: %v\n", h.filePath, err)
		return
	}
	info, err := f.Stat()
	if err == nil {
		h.fileSize = info.Size()
	}
	h.file = f
}

func (h *Hub) rotateLocked() {
	if h.file == nil {
		return
	}
	_ = h.file.Close()
	h.file = nil
	for i := h.keep - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", h.filePath, i), fmt.Sprintf("%s.%d", h.filePath, i+1))
	}
	_ = os.Rename(h.filePath, h.filePath+".1")
	h.fileSize = 0
	h.openFile()
}

func (h *Hub) writeFileLocked(line string) {
	if h.file == nil {
		return
	}
	n, err := h.file.WriteString(line)
	if err != nil {
		return
	}
	h.fileSize += int64(n)
	if h.fileSize > h.maxBytes {
		h.rotateLocked()
	}
}

// SetLimits applies new rotation settings. The new size takes effect on the
// next write; rotations beyond the new count are removed.
func (h *Hub) SetLimits(opts Options) {
	opts = opts.normalize()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.maxBytes = int64(opts.MaxFileMB) << 20
	h.keep = opts.KeepFiles
	if h.filePath == "" {
		return
	}
	// Drop rotations that a previous, larger setting left behind.
	for i := h.keep + 1; i <= 10; i++ {
		_ = os.Remove(fmt.Sprintf("%s.%d", h.filePath, i))
	}
}

// Recent returns up to n most recent entries, oldest first.
func (h *Hub) Recent(n int) []Entry {
	h.mu.RLock()
	defer h.mu.RUnlock()
	size := h.next
	if h.full {
		size = ringSize
	}
	if n <= 0 || n > size {
		n = size
	}
	out := make([]Entry, 0, n)
	start := (h.next - n + ringSize) % ringSize
	for i := 0; i < n; i++ {
		out = append(out, h.ring[(start+i)%ringSize])
	}
	return out
}

// Subscribe returns a channel of live entries and an unsubscribe function.
func (h *Hub) Subscribe() (<-chan Entry, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subID++
	id := h.subID
	ch := make(chan Entry, subChanDepth)
	h.subs[id] = ch
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if c, ok := h.subs[id]; ok {
			delete(h.subs, id)
			close(c)
		}
	}
}

func (h *Hub) push(e Entry) {
	h.mu.Lock()
	h.ring[h.next] = e
	h.next = (h.next + 1) % ringSize
	if h.next == 0 {
		h.full = true
	}
	line := format(e)
	h.writeFileLocked(line)
	subs := make([]chan Entry, 0, len(h.subs))
	for _, c := range h.subs {
		subs = append(subs, c)
	}
	h.mu.Unlock()

	for _, c := range subs {
		select {
		case c <- e:
		default: // slow consumer: drop rather than block the logger
		}
	}
}

// Close flushes and releases the log file.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.file != nil {
		_ = h.file.Sync()
		_ = h.file.Close()
		h.file = nil
	}
}

func format(e Entry) string {
	var b strings.Builder
	b.WriteString(e.Time.Format("2006-01-02 15:04:05.000"))
	b.WriteByte(' ')
	b.WriteString(strings.ToUpper(e.Level))
	b.WriteByte(' ')
	b.WriteString(e.Msg)
	keys := make([]string, 0, len(e.Attrs))
	for k := range e.Attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, " %s=%v", k, e.Attrs[k])
	}
	b.WriteByte('\n')
	return b.String()
}

type handler struct {
	hub   *Hub
	attrs map[string]any
}

func (hh *handler) Enabled(_ context.Context, lvl slog.Level) bool {
	return lvl >= hh.hub.level.Level()
}

func (hh *handler) Handle(_ context.Context, r slog.Record) error {
	e := Entry{
		Time:  r.Time,
		Level: levelString(r.Level),
		Msg:   r.Message,
	}
	if len(hh.attrs) > 0 || r.NumAttrs() > 0 {
		e.Attrs = make(map[string]any, len(hh.attrs)+r.NumAttrs())
		for k, v := range hh.attrs {
			e.Attrs[k] = v
		}
	}
	r.Attrs(func(a slog.Attr) bool {
		if e.Attrs == nil {
			e.Attrs = map[string]any{}
		}
		e.Attrs[a.Key] = a.Value.Any()
		return true
	})
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	hh.hub.push(e)
	if hh.hub.out != nil {
		_, _ = io.WriteString(hh.hub.out, format(e))
	}
	return nil
}

func (hh *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := &handler{hub: hh.hub, attrs: map[string]any{}}
	for k, v := range hh.attrs {
		next.attrs[k] = v
	}
	for _, a := range attrs {
		next.attrs[a.Key] = a.Value.Any()
	}
	return next
}

func (hh *handler) WithGroup(string) slog.Handler { return hh }

func levelString(l slog.Level) string {
	switch {
	case l < slog.LevelInfo:
		return "debug"
	case l < slog.LevelWarn:
		return "info"
	case l < slog.LevelError:
		return "warn"
	default:
		return "error"
	}
}
