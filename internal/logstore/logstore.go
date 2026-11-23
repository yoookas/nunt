// Package logstore keeps the access log of the edge service on disk.
//
// Web requests, port forward connections and WAF interceptions are appended to
// newline delimited JSON files, one file per day (plus sequence suffixes when a
// day outgrows the size limit). Old files are pruned by age. The writer path is
// non blocking: entries go through a bounded queue and the request path is never
// waiting for the disk; when the queue is full the entry is dropped and counted.
package logstore

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Entry sources.
const (
	SourceWeb     = "web"
	SourceForward = "forward"
	SourceWAF     = "waf"
)

// File layout. The day and the sequence suffix are part of the name so that a
// directory listing is already ordered.
const (
	filePrefix = "access-"
	fileSuffix = ".jsonl"
	dayLayout  = "2006-01-02"
)

// Defaults and bounds of the writer.
const (
	// DefaultKeepDays is how long access records are kept when the
	// configuration does not say otherwise.
	DefaultKeepDays = 7
	// DefaultMaxFileMB is the size at which a day rolls over to a new file.
	DefaultMaxFileMB = 64
	// MaxKeepDays and MaxFileMB are the upper bounds accepted from the
	// configuration; they keep a typo from filling the disk.
	MaxKeepDays = 365
	MaxFileMB   = 1024

	queueDepth    = 8192
	flushInterval = time.Second
	pruneInterval = time.Hour
	// maxLineBytes bounds the memory a single malformed line can allocate
	// while reading backwards.
	maxLineBytes = 1 << 20
)

// Entry is one access log record. It is a superset of the fields the three
// producers fill in; source specific fields are omitted when empty.
type Entry struct {
	Time     time.Time `json:"time"`
	Source   string    `json:"source"`
	RuleID   string    `json:"ruleId,omitempty"`
	Rule     string    `json:"rule,omitempty"`
	Listen   string    `json:"listen,omitempty"`
	Host     string    `json:"host,omitempty"`
	Method   string    `json:"method,omitempty"`
	Path     string    `json:"path,omitempty"`
	Status   int       `json:"status,omitempty"`
	ClientIP string    `json:"clientIp,omitempty"`
	// UserAgent is stored for web and WAF records.
	UserAgent string `json:"userAgent,omitempty"`
	// Upstream is the proxy target of a web record or the destination of a
	// forward record.
	Upstream string `json:"upstream,omitempty"`
	// DurationMs is the wall clock time the request or connection took.
	DurationMs int64 `json:"durationMs,omitempty"`
	// Bytes is the total bytes moved; BytesIn/BytesOut split it for forwards.
	Bytes    int64 `json:"bytes,omitempty"`
	BytesIn  int64 `json:"bytesIn,omitempty"`
	BytesOut int64 `json:"bytesOut,omitempty"`
	// Protocol is tcp or udp for forward records.
	Protocol string `json:"protocol,omitempty"`
	// Result is the forward outcome (closed, denied, failed: ...) or the WAF
	// action (blocked, detected).
	Result string `json:"result,omitempty"`
	// WAFRuleID and Message describe a WAF verdict.
	WAFRuleID int    `json:"wafRuleId,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Options controls persistence and retention.
type Options struct {
	// Persist turns writing to disk on. Querying an existing directory still
	// works when it is off.
	Persist   bool `json:"persist"`
	KeepDays  int  `json:"keepDays"`
	MaxFileMB int  `json:"maxFileMb"`
}

// normalize repairs the zero and out of range values of Options.
func (o Options) normalize() Options {
	if o.KeepDays <= 0 {
		o.KeepDays = DefaultKeepDays
	}
	if o.KeepDays > MaxKeepDays {
		o.KeepDays = MaxKeepDays
	}
	if o.MaxFileMB <= 0 {
		o.MaxFileMB = DefaultMaxFileMB
	}
	if o.MaxFileMB > MaxFileMB {
		o.MaxFileMB = MaxFileMB
	}
	return o
}

func (o Options) maxBytes() int64 { return int64(o.MaxFileMB) << 20 }

// File describes one stored log file.
type File struct {
	Name    string    `json:"name"`
	Day     string    `json:"day"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

// Meta is the operational state shown on the logs page.
type Meta struct {
	Dir        string `json:"dir"`
	Persist    bool   `json:"persist"`
	KeepDays   int    `json:"keepDays"`
	MaxFileMB  int    `json:"maxFileMb"`
	Queued     int    `json:"queued"`
	Written    int64  `json:"written"`
	Dropped    int64  `json:"dropped"`
	TotalBytes int64  `json:"totalBytes"`
	Files      []File `json:"files"`
}

// Store appends records to disk and answers queries over the stored files.
type Store struct {
	dir string

	mu   sync.RWMutex
	opts Options

	queue chan Entry
	done  chan struct{}
	once  sync.Once
	wg    sync.WaitGroup

	// opMu serialises file mutations between the writer goroutine and
	// Clear/Prune/Query's flush. The writer state below is guarded by it.
	opMu    sync.Mutex
	file    *os.File
	buf     *bufio.Writer
	day     string
	seq     int
	size    int64
	closed  bool
	lastErr error

	dropped atomic.Int64
	written atomic.Int64
}

// Open creates the log directory if needed and starts the writer goroutine.
func Open(dir string, opts Options) (*Store, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("logstore: a directory is required")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create access log directory %s: %w", dir, err)
	}
	s := &Store{dir: dir, queue: make(chan Entry, queueDepth), done: make(chan struct{})}
	s.opts = opts.normalize()
	// Prune before serving so a long outage does not keep expired files until
	// the first hourly tick.
	s.prune()
	s.wg.Add(1)
	go s.loop()
	return s, nil
}

// Dir returns the directory holding the log files.
func (s *Store) Dir() string { return s.dir }

// Options returns the effective options.
func (s *Store) Options() Options {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.opts
}

// Configure applies new options at runtime. Retention is enforced immediately.
func (s *Store) Configure(opts Options) {
	opts = opts.normalize()
	s.mu.Lock()
	s.opts = opts
	s.mu.Unlock()
	s.prune()
}

// Enabled reports whether entries are written to disk.
func (s *Store) Enabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.opts.Persist
}

// Append queues one record. It never blocks the caller: when the queue is full
// the record is dropped and counted, which is visible through Meta.
func (s *Store) Append(e Entry) {
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	if e.Source == "" {
		e.Source = SourceWeb
	}
	if !s.Enabled() {
		return
	}
	select {
	case s.queue <- e:
	default:
		s.dropped.Add(1)
	}
}

// Close drains the queue, flushes the buffer and closes the file.
func (s *Store) Close() error {
	s.once.Do(func() { close(s.done) })
	s.wg.Wait()
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.closed = true
	s.closeFileLocked()
	return s.lastErr
}

// Clear removes every stored file. Recording resumes with the next entry.
func (s *Store) Clear() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.closeFileLocked()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return fmt.Errorf("read access log directory: %w", err)
	}
	var failed int
	for _, de := range entries {
		if de.IsDir() || !isAccessFile(de.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(s.dir, de.Name())); err != nil {
			failed++
		}
	}
	s.day, s.seq, s.size = "", 0, 0
	if failed > 0 {
		return fmt.Errorf("remove %d access log files: %w", failed, err)
	}
	return nil
}

// Meta reports the writer state and the stored files.
func (s *Store) Meta() Meta {
	opts := s.Options()
	files, _ := s.Files()
	m := Meta{
		Dir:       s.dir,
		Persist:   opts.Persist,
		KeepDays:  opts.KeepDays,
		MaxFileMB: opts.MaxFileMB,
		Queued:    len(s.queue),
		Written:   s.written.Load(),
		Dropped:   s.dropped.Load(),
		Files:     files,
	}
	for _, f := range files {
		m.TotalBytes += f.Size
	}
	return m
}

// Files lists the stored files, oldest first.
func (s *Store) Files() ([]File, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []File{}, nil
		}
		return nil, fmt.Errorf("read access log directory: %w", err)
	}
	out := make([]File, 0, len(entries))
	for _, de := range entries {
		if de.IsDir() || !isAccessFile(de.Name()) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		out = append(out, File{
			Name:    de.Name(),
			Day:     dayOf(de.Name()),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// prune deletes files that fell out of the retention window.
func (s *Store) prune() {
	keep := s.Options().KeepDays
	cutoff := time.Now().AddDate(0, 0, -(keep - 1))
	cutoffDay := time.Date(cutoff.Year(), cutoff.Month(), cutoff.Day(), 0, 0, 0, 0, time.Local)

	s.opMu.Lock()
	defer s.opMu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, de := range entries {
		if de.IsDir() || !isAccessFile(de.Name()) {
			continue
		}
		day, err := time.ParseInLocation(dayLayout, dayOf(de.Name()), time.Local)
		if err != nil {
			continue
		}
		// Never delete the file currently being written.
		if de.Name() == s.currentName() {
			continue
		}
		if day.Before(cutoffDay) {
			_ = os.Remove(filepath.Join(s.dir, de.Name()))
		}
	}
}

// ---------------------------------------------------------------------------
// writer
// ---------------------------------------------------------------------------

func (s *Store) loop() {
	defer s.wg.Done()
	flushTick := time.NewTicker(flushInterval)
	defer flushTick.Stop()
	pruneTick := time.NewTicker(pruneInterval)
	defer pruneTick.Stop()

	for {
		select {
		case e := <-s.queue:
			s.batch(e)
		case <-flushTick.C:
			s.flush()
		case <-pruneTick.C:
			s.prune()
		case <-s.done:
			s.drain()
			return
		}
	}
}

// batch writes first and then up to 63 more queued entries under one lock, so
// a burst costs one lock acquisition instead of one per record.
func (s *Store) batch(first Entry) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.writeLocked(first)
	for i := 0; i < 63; i++ {
		select {
		case e := <-s.queue:
			s.writeLocked(e)
		default:
			return
		}
	}
}

// drain writes everything still queued on shutdown.
func (s *Store) drain() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	for {
		select {
		case e := <-s.queue:
			s.writeLocked(e)
		default:
			s.closeFileLocked()
			return
		}
	}
}

// flush pushes the buffered bytes to the file.
func (s *Store) flush() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.flushLocked()
}

func (s *Store) flushLocked() {
	if s.buf == nil {
		return
	}
	if err := s.buf.Flush(); err != nil {
		s.lastErr = err
	}
}

func (s *Store) writeLocked(e Entry) {
	if s.closed {
		return
	}
	if !s.ensureFileLocked(e.Time) {
		return
	}
	line, err := json.Marshal(e)
	if err != nil {
		return
	}
	line = append(line, '\n')
	n, err := s.buf.Write(line)
	if err != nil {
		s.lastErr = err
		return
	}
	s.size += int64(n)
	s.written.Add(1)
	if s.size >= s.maxBytes() {
		// Roll over eagerly so the next record starts a fresh file instead of
		// writing one oversized record into the current one.
		s.flushLocked()
		s.closeFileLocked()
	}
}

// ensureFileLocked opens (or reopens) the file that should receive an entry
// with the given time.
func (s *Store) ensureFileLocked(t time.Time) bool {
	day := t.Local().Format(dayLayout)
	if s.file != nil && s.day == day && s.size < s.maxBytes() {
		return true
	}
	s.closeFileLocked()

	for seq := 0; seq < 1000; seq++ {
		path := filepath.Join(s.dir, fileName(day, seq))
		info, err := os.Stat(path)
		if err == nil && info.Size() >= s.maxBytes() {
			continue
		}
		flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
		f, err := os.OpenFile(path, flags, 0o640)
		if err != nil {
			s.lastErr = err
			return false
		}
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		s.file = f
		s.buf = bufio.NewWriterSize(f, 64<<10)
		s.day = day
		s.seq = seq
		s.size = size
		return true
	}
	s.lastErr = fmt.Errorf("logstore: no free file name for %s", day)
	return false
}

func (s *Store) closeFileLocked() {
	if s.file == nil {
		return
	}
	s.flushLocked()
	if err := s.file.Close(); err != nil && s.lastErr == nil {
		s.lastErr = err
	}
	s.file = nil
	s.buf = nil
}

func (s *Store) currentName() string {
	if s.file == nil || s.day == "" {
		return ""
	}
	return fileName(s.day, s.seq)
}

func (s *Store) maxBytes() int64 { return s.Options().maxBytes() }

// ---------------------------------------------------------------------------
// file naming
// ---------------------------------------------------------------------------

func fileName(day string, seq int) string {
	if seq <= 0 {
		return filePrefix + day + fileSuffix
	}
	return fmt.Sprintf("%s%s.%03d%s", filePrefix, day, seq, fileSuffix)
}

func isAccessFile(name string) bool {
	return strings.HasPrefix(name, filePrefix) && strings.HasSuffix(name, fileSuffix)
}

// dayOf returns the day encoded in a file name, or "" when it has none.
func dayOf(name string) string {
	rest := strings.TrimPrefix(name, filePrefix)
	rest = strings.TrimSuffix(rest, fileSuffix)
	if len(rest) < len(dayLayout) {
		return ""
	}
	return rest[:len(dayLayout)]
}
