package logstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Query describes one page of access records.
type Query struct {
	// Source limits the result to web, forward or waf records.
	Source string
	// RuleID limits the result to one rule or site.
	RuleID string
	// Host matches the requested host (case insensitive).
	Host string
	// IP matches the client address by prefix, so "192.168." works.
	IP string
	// Method matches the HTTP method (case insensitive).
	Method string
	// Status is an exact code ("404") or a class ("4xx").
	Status string
	// Text is a case insensitive substring of path, host, user agent, rule,
	// upstream, result or message.
	Text string
	// From and To bound the records by time; zero means unbounded.
	From time.Time
	To   time.Time
	// Limit is the page size (1..MaxLimit).
	Limit int
	// Cursor is the opaque value returned by the previous page.
	Cursor string
}

// Limits of one query.
const (
	DefaultLimit = 100
	MaxLimit     = 1000
	// maxQueryLines bounds how much a single query scans, so an admin request
	// over a huge retention window stays bounded.
	maxQueryLines = 300000
)

// Result is one page of records, newest first.
type Result struct {
	Items      []Entry `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
	HasMore    bool    `json:"hasMore"`
	Scanned    int     `json:"scanned"`
	Truncated  bool    `json:"truncated,omitempty"`
}

// StatCount is one entry of a top list.
type StatCount struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// Stats aggregates the records matching a query.
type Stats struct {
	Total         int64            `json:"total"`
	Bytes         int64            `json:"bytes"`
	AvgDurationMs float64          `json:"avgDurationMs"`
	BySource      map[string]int64 `json:"bySource"`
	ByStatus      map[string]int64 `json:"byStatus"`
	TopIPs        []StatCount      `json:"topIps"`
	TopPaths      []StatCount      `json:"topPaths"`
	TopRules      []StatCount      `json:"topRules"`
	Scanned       int              `json:"scanned"`
	Complete      bool             `json:"complete"`
	Files         int              `json:"files"`
}

// maxDistinct bounds the cardinality of one aggregation map; a hostile client
// cannot make the process allocate one map entry per request.
const maxDistinct = 20000

// Query returns one page of records, newest first.
func (s *Store) Query(q Query) (Result, error) {
	q = normalizeQuery(q)
	// Push whatever the writer still holds in its buffer so the newest records
	// are visible; the lock is released before the files are scanned.
	s.flush()
	files, err := s.Files()
	if err != nil {
		return Result{}, err
	}

	cursorNanos, cursorSkip, cursorOK := parseCursor(q.Cursor)
	fromNanos, toNanos := bounds(q)

	items := make([]Entry, 0, q.Limit+1)
	scanned := 0
	truncated := false
	remainingSkip := cursorSkip
	cursorActive := cursorOK

	for i := len(files) - 1; i >= 0 && len(items) <= q.Limit && !truncated; i-- {
		file := files[i]
		if !fileInRange(file.Day, q) {
			continue
		}
		path := filepath.Join(s.dir, file.Name)
		err := scanFileReverse(path, func(line []byte) bool {
			if scanned >= maxQueryLines {
				truncated = true
				return false
			}
			scanned++
			var e Entry
			if err := json.Unmarshal(line, &e); err != nil {
				return true
			}
			if fromNanos > 0 && e.Time.UnixNano() < fromNanos {
				return true
			}
			if toNanos > 0 && e.Time.UnixNano() > toNanos {
				return true
			}
			if !matchEntry(e, q) {
				return true
			}
			if cursorActive {
				nanos := e.Time.UnixNano()
				if nanos > cursorNanos {
					return true
				}
				if nanos == cursorNanos && remainingSkip > 0 {
					remainingSkip--
					return true
				}
				cursorActive = false
			}
			items = append(items, e)
			return len(items) <= q.Limit
		})
		if err != nil {
			return Result{}, fmt.Errorf("read %s: %w", file.Name, err)
		}
	}

	res := Result{Items: []Entry{}, Scanned: scanned, Truncated: truncated}
	if len(items) > q.Limit {
		res.HasMore = true
		items = items[:q.Limit]
	}
	res.Items = items
	if res.HasMore && len(items) > 0 {
		last := items[len(items)-1]
		// The cursor carries the cumulative number of records already returned
		// at this timestamp: a page can end in the middle of a group (the
		// records of one millisecond), and the next page has to skip the whole
		// group, not just what this page happened to contain.
		seen := countAt(items, last.Time)
		if cursorOK && last.Time.UnixNano() == cursorNanos {
			seen += cursorSkip
		}
		res.NextCursor = formatCursor(last.Time, seen)
	}
	return res, nil
}

// Stats aggregates every record matching the filters. The scan is capped and
// Complete reports whether the whole window was seen.
func (s *Store) Stats(q Query) (Stats, error) {
	q = normalizeQuery(q)
	s.flush()
	files, err := s.Files()
	if err != nil {
		return Stats{}, err
	}

	st := Stats{
		BySource: map[string]int64{},
		ByStatus: map[string]int64{},
		Complete: true,
	}
	fromNanos, toNanos := bounds(q)
	ips := map[string]int64{}
	paths := map[string]int64{}
	rules := map[string]int64{}
	var durationTotal int64

	for i := len(files) - 1; i >= 0; i-- {
		file := files[i]
		if !fileInRange(file.Day, q) {
			continue
		}
		st.Files++
		path := filepath.Join(s.dir, file.Name)
		err := scanFileReverse(path, func(line []byte) bool {
			if st.Scanned >= maxQueryLines {
				st.Complete = false
				return false
			}
			st.Scanned++
			var e Entry
			if err := json.Unmarshal(line, &e); err != nil {
				return true
			}
			if fromNanos > 0 && e.Time.UnixNano() < fromNanos {
				return true
			}
			if toNanos > 0 && e.Time.UnixNano() > toNanos {
				return true
			}
			if !matchEntry(e, q) {
				return true
			}
			st.Total++
			st.Bytes += e.Bytes
			durationTotal += e.DurationMs
			bump(st.BySource, e.Source, maxDistinct)
			bump(st.ByStatus, statusClass(e.Status), 8)
			if e.ClientIP != "" {
				bumpBounded(ips, e.ClientIP)
			}
			if e.Path != "" {
				bumpBounded(paths, e.Path)
			}
			if e.Rule != "" {
				bumpBounded(rules, e.Rule)
			}
			return true
		})
		if err != nil {
			return Stats{}, fmt.Errorf("read %s: %w", file.Name, err)
		}
		if !st.Complete {
			break
		}
	}
	if st.Total > 0 {
		st.AvgDurationMs = float64(durationTotal) / float64(st.Total)
	}
	st.TopIPs = topN(ips, 10)
	st.TopPaths = topN(paths, 10)
	st.TopRules = topN(rules, 10)
	return st, nil
}

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

func normalizeQuery(q Query) Query {
	q.Source = strings.ToLower(strings.TrimSpace(q.Source))
	q.RuleID = strings.TrimSpace(q.RuleID)
	q.Host = strings.TrimSpace(q.Host)
	q.IP = strings.TrimSpace(q.IP)
	q.Method = strings.ToUpper(strings.TrimSpace(q.Method))
	q.Status = strings.ToLower(strings.TrimSpace(q.Status))
	q.Text = strings.TrimSpace(q.Text)
	if q.Limit <= 0 {
		q.Limit = DefaultLimit
	}
	if q.Limit > MaxLimit {
		q.Limit = MaxLimit
	}
	return q
}

func bounds(q Query) (from, to int64) {
	if !q.From.IsZero() {
		from = q.From.UnixNano()
	}
	if !q.To.IsZero() {
		to = q.To.UnixNano()
	}
	return from, to
}

// fileInRange skips whole files that cannot contain a match.
func fileInRange(day string, q Query) bool {
	if day == "" || (q.From.IsZero() && q.To.IsZero()) {
		return true
	}
	d, err := time.ParseInLocation(dayLayout, day, time.Local)
	if err != nil {
		return true
	}
	start := d
	end := d.AddDate(0, 0, 1)
	// end is exclusive: a file ending exactly at From cannot overlap.
	if !q.From.IsZero() && !end.After(q.From) {
		return false
	}
	if !q.To.IsZero() && start.After(q.To) {
		return false
	}
	return true
}

func matchEntry(e Entry, q Query) bool {
	if q.Source != "" && !strings.EqualFold(e.Source, q.Source) {
		return false
	}
	if q.RuleID != "" && e.RuleID != q.RuleID {
		return false
	}
	if q.Host != "" && !strings.Contains(strings.ToLower(e.Host), strings.ToLower(q.Host)) {
		return false
	}
	if q.IP != "" && !strings.HasPrefix(e.ClientIP, q.IP) {
		return false
	}
	if q.Method != "" && !strings.EqualFold(e.Method, q.Method) {
		return false
	}
	if q.Status != "" && !matchStatus(e.Status, q.Status) {
		return false
	}
	if q.Text != "" {
		haystack := strings.ToLower(strings.Join([]string{
			e.Path, e.Host, e.UserAgent, e.Rule, e.Upstream, e.Result, e.Message,
		}, " "))
		if !strings.Contains(haystack, strings.ToLower(q.Text)) {
			return false
		}
	}
	return true
}

func matchStatus(status int, want string) bool {
	if len(want) == 3 && want[1] == 'x' && want[2] == 'x' {
		class := int(want[0] - '0')
		if class < 1 || class > 5 {
			return false
		}
		return status >= class*100 && status < class*100+100
	}
	n, err := strconv.Atoi(want)
	return err == nil && status == n
}

func statusClass(status int) string {
	switch {
	case status <= 0:
		return "other"
	case status < 200:
		return "1xx"
	case status < 300:
		return "2xx"
	case status < 400:
		return "3xx"
	case status < 500:
		return "4xx"
	default:
		return "5xx"
	}
}

func bump(m map[string]int64, key string, limit int) {
	if key == "" {
		return
	}
	if _, ok := m[key]; ok {
		m[key]++
		return
	}
	if len(m) < limit {
		m[key] = 1
	}
}

func bumpBounded(m map[string]int64, key string) { bump(m, key, maxDistinct) }

func topN(m map[string]int64, n int) []StatCount {
	out := make([]StatCount, 0, len(m))
	for k, v := range m {
		out = append(out, StatCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

// formatCursor encodes "the last returned record" together with how many
// records sharing its timestamp were already returned, so paging never skips
// or repeats an entry.
func formatCursor(t time.Time, n int) string {
	return fmt.Sprintf("%d:%d", t.UnixNano(), n)
}

func parseCursor(raw string) (int64, int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, 0, false
	}
	i := strings.IndexByte(raw, ':')
	if i <= 0 {
		return 0, 0, false
	}
	nanos, err := strconv.ParseInt(raw[:i], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	n, err := strconv.Atoi(raw[i+1:])
	if err != nil || n < 0 {
		return 0, 0, false
	}
	return nanos, n, true
}

// countAt counts how many of the returned items share the timestamp of last.
func countAt(items []Entry, last time.Time) int {
	n := 0
	for _, e := range items {
		if e.Time.Equal(last) {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// reverse reader
// ---------------------------------------------------------------------------

// scanFileReverse calls fn once per line, last line first, and stops early when
// fn returns false.
func scanFileReverse(path string, fn func(line []byte) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}

	const chunkSize = 64 << 10
	size := info.Size()
	buf := make([]byte, chunkSize)
	var carry []byte
	pos := size
	for pos > 0 {
		n := int64(chunkSize)
		if pos < n {
			n = pos
		}
		pos -= n
		chunk := buf[:n]
		if _, err := f.ReadAt(chunk, pos); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		data := make([]byte, 0, len(chunk)+len(carry))
		data = append(data, chunk...)
		data = append(data, carry...)

		end := len(data)
		for i := len(data) - 1; i >= 0; i-- {
			if data[i] != '\n' {
				continue
			}
			if i+1 < end {
				line := bytes.TrimSuffix(data[i+1:end], []byte{'\r'})
				if len(line) > 0 && !fn(line) {
					return nil
				}
			}
			end = i
		}
		carry = append(carry[:0], data[:end]...)
		if len(carry) > maxLineBytes {
			carry = carry[len(carry)-maxLineBytes:]
		}
	}
	if len(carry) > 0 {
		line := bytes.TrimSuffix(carry, []byte{'\r'})
		if len(line) > 0 {
			fn(line)
		}
	}
	return nil
}

// SeriesPoint aggregates one time bucket.
type SeriesPoint struct {
	Time      time.Time `json:"time"`
	Total     int64     `json:"total"`
	Errors4xx int64     `json:"errors4xx"`
	Errors5xx int64     `json:"errors5xx"`
	Bytes     int64     `json:"bytes"`
}

// MaxSeriesBuckets bounds the response size of one series request.
const MaxSeriesBuckets = 1440

// Series aggregates the records matching q into fixed buckets. Empty buckets
// inside the requested range are returned as zeros so the caller can draw a
// continuous chart; the range defaults to the last 24 hours when q.From is
// zero, and to q.From + 24h when q.To is zero.
func (s *Store) Series(q Query, bucket time.Duration) ([]SeriesPoint, error) {
	q = normalizeQuery(q)
	if bucket < time.Minute {
		bucket = time.Minute
	}
	now := time.Now()
	if q.To.IsZero() {
		q.To = now
	}
	if q.From.IsZero() {
		q.From = q.To.Add(-24 * time.Hour)
	}
	if q.To.Before(q.From) {
		return []SeriesPoint{}, nil
	}
	count := int(q.To.Sub(q.From)/bucket) + 1
	if count > MaxSeriesBuckets {
		return nil, fmt.Errorf("time range covers %d buckets, at most %d allowed", count, MaxSeriesBuckets)
	}

	s.flush()
	files, err := s.Files()
	if err != nil {
		return nil, err
	}
	fromNanos, toNanos := bounds(q)
	points := map[int64]*SeriesPoint{}
	scanned := 0
	for i := len(files) - 1; i >= 0; i-- {
		file := files[i]
		if !fileInRange(file.Day, q) {
			continue
		}
		err := scanFileReverse(filepath.Join(s.dir, file.Name), func(line []byte) bool {
			if scanned >= maxQueryLines {
				return false
			}
			scanned++
			var e Entry
			if err := json.Unmarshal(line, &e); err != nil {
				return true
			}
			if fromNanos > 0 && e.Time.UnixNano() < fromNanos {
				return true
			}
			if toNanos > 0 && e.Time.UnixNano() > toNanos {
				return true
			}
			if !matchEntry(e, q) {
				return true
			}
			key := e.Time.Truncate(bucket).Unix()
			p, ok := points[key]
			if !ok {
				p = &SeriesPoint{Time: time.Unix(key, 0)}
				points[key] = p
			}
			p.Total++
			p.Bytes += e.Bytes
			switch {
			case e.Status >= 500:
				p.Errors5xx++
			case e.Status >= 400:
				p.Errors4xx++
			}
			return true
		})
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", file.Name, err)
		}
	}

	start := q.From.Truncate(bucket)
	out := make([]SeriesPoint, 0, count)
	for ts := start; !ts.After(q.To); ts = ts.Add(bucket) {
		if p, ok := points[ts.Unix()]; ok {
			out = append(out, *p)
			continue
		}
		out = append(out, SeriesPoint{Time: ts})
	}
	return out, nil
}
