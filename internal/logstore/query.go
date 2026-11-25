package logstore

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Query describes one page of access records.
type Query struct {
	Source string
	RuleID string
	// Host matches the requested host as a case insensitive substring.
	Host string
	// IP matches the client address by prefix, so "192.168." works.
	IP string
	// Method matches the HTTP method (case insensitive).
	Method string
	// Status is an exact code ("404") or a class ("4xx").
	Status string
	// Text is a case insensitive substring of path, host, user agent, rule,
	// upstream, result, message or error.
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
)

// Result is one page of records, newest first.
type Result struct {
	Items      []Entry `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
	HasMore    bool    `json:"hasMore"`
	Scanned    int     `json:"scanned"`
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

func normalizeQuery(q Query) Query {
	if q.Limit <= 0 {
		q.Limit = DefaultLimit
	}
	if q.Limit > MaxLimit {
		q.Limit = MaxLimit
	}
	return q
}

// clauses renders the shared filters of the list, stats and series queries.
func clauses(q Query) (string, []any) {
	var parts []string
	var args []any
	add := func(cond string, value any) {
		parts = append(parts, cond)
		args = append(args, value)
	}
	if q.Source != "" {
		add("source = ?", q.Source)
	}
	if q.RuleID != "" {
		add("rule_id = ?", q.RuleID)
	}
	if q.Host != "" {
		add(`host LIKE ? ESCAPE '\'`, "%"+likeEscape(q.Host)+"%")
	}
	if q.IP != "" {
		add(`client_ip LIKE ? ESCAPE '\'`, likeEscape(q.IP)+"%")
	}
	if q.Method != "" {
		add("method = ? COLLATE NOCASE", q.Method)
	}
	if q.Status != "" {
		if len(q.Status) == 3 && q.Status[1] == 'x' && q.Status[2] == 'x' &&
			q.Status[0] >= '1' && q.Status[0] <= '5' {
			class := int(q.Status[0] - '0')
			parts = append(parts, "status BETWEEN ? AND ?")
			args = append(args, class*100, class*100+99)
		} else if n, err := strconv.Atoi(q.Status); err == nil {
			add("status = ?", n)
		}
	}
	if q.Text != "" {
		pattern := "%" + likeEscape(q.Text) + "%"
		parts = append(parts, `(path LIKE ? ESCAPE '\' OR host LIKE ? ESCAPE '\' OR
			user_agent LIKE ? ESCAPE '\' OR rule LIKE ? ESCAPE '\' OR
			upstream LIKE ? ESCAPE '\' OR result LIKE ? ESCAPE '\' OR
			message LIKE ? ESCAPE '\' OR error LIKE ? ESCAPE '\' OR reason LIKE ? ESCAPE '\')`)
		for i := 0; i < 9; i++ {
			args = append(args, pattern)
		}
	}
	if !q.From.IsZero() {
		add("ts >= ?", q.From.UnixMilli())
	}
	if !q.To.IsZero() {
		add("ts <= ?", q.To.UnixMilli())
	}
	if len(parts) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(parts, " AND "), args
}

func likeEscape(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func encodeCursor(ts int64, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%d:%d", ts, id)))
}

func decodeCursor(value string) (int64, int64, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, 0, false
	}
	parts := strings.SplitN(string(raw), ":", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	ts, err1 := strconv.ParseInt(parts[0], 10, 64)
	id, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return ts, id, true
}

const entryColumns = `id, ts, source, rule_id, rule, listen, host, method, path, status,
	client_ip, user_agent, upstream, upstream_status, attempts, duration_ms, bytes,
	bytes_in, bytes_out, proto, tls, request_id, result, reason, error, waf_rule_id, message`

// Query returns one page of records, newest first.
func (s *Store) Query(q Query) (Result, error) {
	q = normalizeQuery(q)
	s.requestFlush()

	where, args := clauses(q)
	if ts, id, ok := decodeCursor(q.Cursor); ok {
		if where == "" {
			where = " WHERE "
		} else {
			where += " AND "
		}
		where += "(ts < ? OR (ts = ? AND id < ?))"
		args = append(args, ts, ts, id)
	}
	args = append(args, q.Limit+1)
	rows, err := s.db.Query(`SELECT `+entryColumns+` FROM access_log`+where+` ORDER BY ts DESC, id DESC LIMIT ?`, args...)
	if err != nil {
		return Result{}, fmt.Errorf("query access log: %w", err)
	}
	defer rows.Close()

	items := make([]Entry, 0, q.Limit+1)
	var ids []int64
	for rows.Next() {
		var (
			e  Entry
			id int64
			ts int64
		)
		if err := rows.Scan(&id, &ts, &e.Source, &e.RuleID, &e.Rule, &e.Listen, &e.Host,
			&e.Method, &e.Path, &e.Status, &e.ClientIP, &e.UserAgent, &e.Upstream,
			&e.UpstreamStatus, &e.Attempts, &e.DurationMs, &e.Bytes, &e.BytesIn,
			&e.BytesOut, &e.Proto, &e.TLS, &e.RequestID, &e.Result, &e.Reason,
			&e.Error, &e.WAFRuleID, &e.Message); err != nil {
			return Result{}, fmt.Errorf("scan access log: %w", err)
		}
		e.Time = time.UnixMilli(ts)
		items = append(items, e)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return Result{}, fmt.Errorf("read access log: %w", err)
	}

	out := Result{Scanned: len(items)}
	if len(items) > q.Limit {
		out.HasMore = true
		items = items[:q.Limit]
		ids = ids[:q.Limit]
	}
	out.Items = items
	if len(items) > 0 {
		last := len(items) - 1
		out.NextCursor = encodeCursor(items[last].Time.UnixMilli(), ids[last])
	}
	return out, nil
}

// Stats aggregates the records matching a query.
func (s *Store) Stats(q Query) (Stats, error) {
	s.requestFlush()
	where, args := clauses(q)
	out := Stats{BySource: map[string]int64{}, ByStatus: map[string]int64{}, Complete: true}

	row := s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0), COALESCE(AVG(duration_ms),0) FROM access_log`+where, args...)
	if err := row.Scan(&out.Total, &out.Bytes, &out.AvgDurationMs); err != nil {
		return out, fmt.Errorf("aggregate access log: %w", err)
	}
	out.Scanned = int(out.Total)
	if out.Total > 0 {
		out.Files = 1
	}

	if err := s.groupCounts(`SELECT source, COUNT(*) FROM access_log`+where+` GROUP BY source`, args, out.BySource); err != nil {
		return out, err
	}

	statusRows, err := s.db.Query(`SELECT status, COUNT(*) FROM access_log`+where+` GROUP BY status`, args...)
	if err != nil {
		return out, fmt.Errorf("group access log by status: %w", err)
	}
	defer statusRows.Close()
	for statusRows.Next() {
		var status int
		var count int64
		if err := statusRows.Scan(&status, &count); err != nil {
			return out, fmt.Errorf("scan status group: %w", err)
		}
		key := statusClass(status)
		out.ByStatus[key] += count
	}
	if err := statusRows.Err(); err != nil {
		return out, fmt.Errorf("read status groups: %w", err)
	}

	if out.TopIPs, err = s.top(`client_ip`, where, args); err != nil {
		return out, err
	}
	if out.TopPaths, err = s.top(`path`, where, args); err != nil {
		return out, err
	}
	if out.TopRules, err = s.top(`rule`, where, args); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Store) groupCounts(query string, args []any, into map[string]int64) error {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return fmt.Errorf("group access log: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name sql.NullString
		var count int64
		if err := rows.Scan(&name, &count); err != nil {
			return fmt.Errorf("scan group: %w", err)
		}
		if name.Valid && name.String != "" {
			into[name.String] = count
		}
	}
	return rows.Err()
}

func (s *Store) top(column, where string, args []any) ([]StatCount, error) {
	query := `SELECT ` + column + `, COUNT(*) AS n FROM access_log` + where
	if where == "" {
		query += " WHERE "
	} else {
		query += " AND "
	}
	query += column + ` <> '' GROUP BY ` + column + ` ORDER BY n DESC, ` + column + ` LIMIT 10`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("top %s: %w", column, err)
	}
	defer rows.Close()
	out := []StatCount{}
	for rows.Next() {
		var item StatCount
		if err := rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, fmt.Errorf("scan top %s: %w", column, err)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func statusClass(status int) string {
	switch {
	case status >= 100 && status <= 599:
		return fmt.Sprintf("%dxx", status/100)
	default:
		return "other"
	}
}

// Series aggregates the records matching q into fixed buckets.
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
	s.requestFlush()
	where, whereArgs := clauses(q)
	bucketMs := int64(bucket / time.Millisecond)
	if bucketMs <= 0 {
		bucketMs = 60000
	}
	// The bucket expressions are the first placeholders of the statement, so
	// their arguments must come before the filter arguments.
	args := []any{bucketMs, bucketMs}
	args = append(args, whereArgs...)
	query := `SELECT (ts / ?) * ? AS b, COUNT(*),
		COALESCE(SUM(CASE WHEN status BETWEEN 400 AND 499 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(bytes),0)
		FROM access_log` + where + ` GROUP BY b ORDER BY b`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("series access log: %w", err)
	}
	defer rows.Close()
	points := map[int64]*SeriesPoint{}
	for rows.Next() {
		var ms, total, e4, e5, bytes int64
		if err := rows.Scan(&ms, &total, &e4, &e5, &bytes); err != nil {
			return nil, fmt.Errorf("scan series: %w", err)
		}
		points[ms] = &SeriesPoint{Time: time.UnixMilli(ms), Total: total, Errors4xx: e4, Errors5xx: e5, Bytes: bytes}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read series: %w", err)
	}
	out := make([]SeriesPoint, 0, count)
	start := q.From.Truncate(bucket)
	for t := start; !t.After(q.To); t = t.Add(bucket) {
		if p, ok := points[t.UnixMilli()]; ok {
			out = append(out, *p)
			continue
		}
		out = append(out, SeriesPoint{Time: t})
	}
	return out, nil
}
