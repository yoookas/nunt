// Package logstore keeps the access log of the edge service in SQLite.
//
// Web requests, port forward connections and WAF interceptions are appended to
// one table, filtered by source when read. The writer path is non blocking:
// entries go through a bounded queue and are committed in batches; when the
// queue is full the entry is dropped and counted. The SQLite file lives next to
// the old JSONL files, which are left untouched.
package logstore

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

// Entry sources.
const (
	SourceWeb     = "web"
	SourceForward = "forward"
	SourceWAF     = "waf"
)

// Defaults and bounds.
const (
	DefaultKeepDays  = 7
	DefaultMaxFileMB = 64
	MaxKeepDays      = 365
	MaxFileMB        = 4096

	queueDepth    = 8192
	batchSize     = 500
	flushInterval = time.Second
	pruneInterval = time.Hour
)

// Entry is one access log record shared by the three producers.
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
	// forward record; UpstreamStatus and Attempts describe the proxy exchange.
	Upstream       string `json:"upstream,omitempty"`
	UpstreamStatus int    `json:"upstreamStatus,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	// DurationMs is the wall clock time the request or connection took.
	DurationMs int64 `json:"durationMs,omitempty"`
	// Bytes is the total bytes moved; BytesIn/BytesOut split it for forwards
	// and for web records (request body / response body).
	Bytes    int64 `json:"bytes,omitempty"`
	BytesIn  int64 `json:"bytesIn,omitempty"`
	BytesOut int64 `json:"bytesOut,omitempty"`
	// Protocol is tcp or udp for forward records, the HTTP version for web.
	Protocol string `json:"protocol,omitempty"`
	// Proto and TLS describe the web request (HTTP/1.1, TLS 1.3, ...).
	Proto string `json:"proto,omitempty"`
	TLS   string `json:"tls,omitempty"`
	// RequestID ties one request across the web, WAF and process logs.
	RequestID string `json:"requestId,omitempty"`
	// Result is the forward outcome (closed, denied, failed: ...) or the WAF
	// action; Reason names the filter that refused the request and Error the
	// proxy failure.
	Result string `json:"result,omitempty"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
	// WAFAction, WAFRuleID and Message describe a WAF verdict.
	WAFAction string `json:"wafAction,omitempty"`
	WAFRuleID int    `json:"wafRuleId,omitempty"`
	Message   string `json:"message,omitempty"`
	// Country/Province/City are resolved from ClientIP when the address
	// database is loaded; they stay empty for private or reserved addresses.
	Country  string `json:"country,omitempty"`
	Province string `json:"province,omitempty"`
	City     string `json:"city,omitempty"`
}

// Options controls persistence and retention.
type Options struct {
	Persist bool `json:"persist"`
	// KeepDays is the age at which records are deleted.
	KeepDays int `json:"keepDays"`
	// MaxFileMB caps the database size; the oldest rows are deleted when the
	// file grows past it.
	MaxFileMB int `json:"maxFileMb"`
}

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

// File describes the database file for the storage panel.
type File struct {
	Name    string    `json:"name"`
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
	LastError  string `json:"lastError,omitempty"`
}

// Store appends records to SQLite and answers queries over them.
type Store struct {
	dir    string
	dbPath string
	db     *sql.DB

	mu   sync.RWMutex
	opts Options

	queue chan Entry
	flush chan chan struct{}
	done  chan struct{}
	once  sync.Once
	wg    sync.WaitGroup

	written atomic.Int64
	dropped atomic.Int64

	errMu   sync.Mutex
	lastErr string
}

// Open opens (or creates) the database under dir and starts the writer.
func Open(dir string, opts Options) (*Store, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("logstore: a directory is required")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create access log directory %s: %w", dir, err)
	}
	dbPath := filepath.Join(dir, "access.db")
	fresh := false
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		fresh = true
	}

	u := url.URL{Scheme: "file", Path: dbPath}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(DELETE)")
	q.Add("_pragma", "synchronous(NORMAL)")
	u.RawQuery = q.Encode()

	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, fmt.Errorf("open access database: %w", err)
	}
	db.SetMaxOpenConns(4)
	if fresh {
		// Incremental vacuum keeps deleting old rows from rewriting the file.
		if _, err := db.Exec("PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("configure access database: %w", err)
		}
	}
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := os.Chmod(dbPath, 0o640); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("chmod access database: %w", err)
	}

	s := &Store{
		dir:    dir,
		dbPath: dbPath,
		db:     db,
		queue:  make(chan Entry, queueDepth),
		flush:  make(chan chan struct{}),
		done:   make(chan struct{}),
	}
	s.opts = opts.normalize()
	s.prune()
	s.wg.Add(1)
	go s.loop()
	return s, nil
}

func migrate(db *sql.DB) error {
	const schema = `
CREATE TABLE IF NOT EXISTS access_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	source TEXT NOT NULL DEFAULT '',
	rule_id TEXT NOT NULL DEFAULT '',
	rule TEXT NOT NULL DEFAULT '',
	listen TEXT NOT NULL DEFAULT '',
	host TEXT NOT NULL DEFAULT '',
	method TEXT NOT NULL DEFAULT '',
	path TEXT NOT NULL DEFAULT '',
	status INTEGER NOT NULL DEFAULT 0,
	client_ip TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	upstream TEXT NOT NULL DEFAULT '',
	upstream_status INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER NOT NULL DEFAULT 0,
	bytes_in INTEGER NOT NULL DEFAULT 0,
	bytes_out INTEGER NOT NULL DEFAULT 0,
	proto TEXT NOT NULL DEFAULT '',
	tls TEXT NOT NULL DEFAULT '',
	request_id TEXT NOT NULL DEFAULT '',
	result TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	waf_rule_id INTEGER NOT NULL DEFAULT 0,
	message TEXT NOT NULL DEFAULT '',
	waf_action TEXT NOT NULL DEFAULT '',
	country TEXT NOT NULL DEFAULT '',
	province TEXT NOT NULL DEFAULT '',
	city TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_access_ts ON access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_source_ts ON access_log(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_status_ts ON access_log(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_rule_ts ON access_log(rule_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_client_ts ON access_log(client_ip, ts DESC);
`
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("create access log schema: %w", err)
	}
	// Databases created before these fields existed get them added in place;
	// SQLite has no IF NOT EXISTS for columns.
	for _, column := range []struct{ name, ddl string }{
		{"waf_action", "waf_action TEXT NOT NULL DEFAULT ''"},
		{"country", "country TEXT NOT NULL DEFAULT ''"},
		{"province", "province TEXT NOT NULL DEFAULT ''"},
		{"city", "city TEXT NOT NULL DEFAULT ''"},
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info('access_log') WHERE name = ?", column.name).Scan(&count); err != nil {
			return fmt.Errorf("inspect access log schema: %w", err)
		}
		if count == 0 {
			if _, err := db.Exec("ALTER TABLE access_log ADD COLUMN " + column.ddl); err != nil {
				return fmt.Errorf("add access log column %s: %w", column.name, err)
			}
		}
	}
	return nil
}

// Dir returns the directory holding the database.
func (s *Store) Dir() string { return s.dir }

// Options returns the effective options.
func (s *Store) Options() Options {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.opts
}

// Configure applies new options at runtime and enforces retention.
func (s *Store) Configure(opts Options) {
	opts = opts.normalize()
	s.mu.Lock()
	s.opts = opts
	s.mu.Unlock()
	// Enforce the new retention now; the hourly loop already runs once.
	s.pruneOnce()
}

// Enabled reports whether entries are written to the database.
func (s *Store) Enabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.opts.Persist
}

// Append queues one record without blocking the caller.
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

// Close drains the queue and closes the database.
func (s *Store) Close() error {
	s.once.Do(func() { close(s.done) })
	s.wg.Wait()
	return s.db.Close()
}

// Clear removes every record.
func (s *Store) Clear() error {
	s.requestFlush()
	if _, err := s.db.Exec("DELETE FROM access_log"); err != nil {
		return fmt.Errorf("clear access log: %w", err)
	}
	if _, err := s.db.Exec("PRAGMA incremental_vacuum"); err != nil {
		return fmt.Errorf("vacuum access log: %w", err)
	}
	return nil
}

// Meta reports the writer state and the database file.
func (s *Store) Meta() Meta {
	opts := s.Options()
	m := Meta{
		Dir:       s.dir,
		Persist:   opts.Persist,
		KeepDays:  opts.KeepDays,
		MaxFileMB: opts.MaxFileMB,
		Queued:    len(s.queue),
		Written:   s.written.Load(),
		Dropped:   s.dropped.Load(),
		Files:     []File{},
	}
	if info, err := os.Stat(s.dbPath); err == nil {
		m.TotalBytes = info.Size()
		m.Files = append(m.Files, File{Name: filepath.Base(s.dbPath), Size: info.Size(), ModTime: info.ModTime()})
	}
	s.errMu.Lock()
	m.LastError = s.lastErr
	s.errMu.Unlock()
	return m
}

// Files lists the database file.
func (s *Store) Files() ([]File, error) {
	return s.Meta().Files, nil
}

func (s *Store) setError(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	s.lastErr = err.Error()
	s.errMu.Unlock()
}

func (s *Store) loop() {
	defer s.wg.Done()
	batch := make([]Entry, 0, batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := s.write(batch); err != nil {
			s.setError(err)
		} else {
			s.written.Add(int64(len(batch)))
		}
		batch = batch[:0]
	}
	drain := func(limit int) {
		for len(batch) < limit {
			select {
			case e := <-s.queue:
				batch = append(batch, e)
			default:
				return
			}
		}
	}
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			drain(queueDepth)
			flush()
			return
		case e := <-s.queue:
			batch = append(batch, e)
			if len(batch) >= batchSize {
				flush()
			}
		case ch := <-s.flush:
			drain(batchSize * 4)
			flush()
			close(ch)
		case <-ticker.C:
			flush()
		}
	}
}

func (s *Store) write(entries []Entry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin access log transaction: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT INTO access_log (
		ts, source, rule_id, rule, listen, host, method, path, status, client_ip,
		user_agent, upstream, upstream_status, attempts, duration_ms, bytes,
		bytes_in, bytes_out, proto, tls, request_id, result, reason, error, waf_rule_id, message,
		waf_action, country, province, city
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("prepare access log insert: %w", err)
	}
	for _, e := range entries {
		_, err = stmt.Exec(
			e.Time.UnixMilli(), e.Source, e.RuleID, e.Rule, e.Listen, e.Host, e.Method, e.Path,
			e.Status, e.ClientIP, e.UserAgent, e.Upstream, e.UpstreamStatus, e.Attempts,
			e.DurationMs, e.Bytes, e.BytesIn, e.BytesOut, e.Proto, e.TLS, e.RequestID,
			e.Result, e.Reason, e.Error, e.WAFRuleID, e.Message,
			e.WAFAction, e.Country, e.Province, e.City,
		)
		if err != nil {
			_ = stmt.Close()
			_ = tx.Rollback()
			return fmt.Errorf("insert access log: %w", err)
		}
	}
	if err := stmt.Close(); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("close access log statement: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit access log: %w", err)
	}
	return nil
}

// requestFlush asks the writer to commit whatever is queued, so a query sees
// the newest records. It never blocks the caller for long.
func (s *Store) requestFlush() {
	ch := make(chan struct{})
	select {
	case s.flush <- ch:
		select {
		case <-ch:
		case <-time.After(3 * time.Second):
		}
	case <-time.After(200 * time.Millisecond):
	}
}

func (s *Store) prune() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.pruneOnce()
		ticker := time.NewTicker(pruneInterval)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
				s.pruneOnce()
			}
		}
	}()
}

func (s *Store) pruneOnce() {
	opts := s.Options()
	cutoff := time.Now().Add(-time.Duration(opts.KeepDays) * 24 * time.Hour).UnixMilli()
	if _, err := s.db.Exec("DELETE FROM access_log WHERE ts < ?", cutoff); err != nil {
		s.setError(err)
		return
	}
	capBytes := int64(opts.MaxFileMB) << 20
	for i := 0; i < 20; i++ {
		info, err := os.Stat(s.dbPath)
		if err != nil || info.Size() <= capBytes {
			break
		}
		if _, err := s.db.Exec("DELETE FROM access_log WHERE id IN (SELECT id FROM access_log ORDER BY ts ASC LIMIT 5000)"); err != nil {
			s.setError(err)
			break
		}
		if _, err := s.db.Exec("PRAGMA incremental_vacuum(2000)"); err != nil {
			s.setError(err)
			break
		}
	}
}
