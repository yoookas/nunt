package logstore

import (
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir(), Options{Persist: true, KeepDays: 7, MaxFileMB: 64})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func seed(t *testing.T, s *Store, entries []Entry) {
	t.Helper()
	for _, e := range entries {
		s.Append(e)
	}
	s.requestFlush()
}

func entryAt(base time.Time, offset time.Duration, mutate func(*Entry)) Entry {
	e := Entry{
		Time:     base.Add(offset),
		Source:   SourceWeb,
		Rule:     "site",
		Host:     "example.com",
		Method:   "GET",
		Path:     "/",
		Status:   200,
		ClientIP: "203.0.113.9",
		Bytes:    100,
	}
	if mutate != nil {
		mutate(&e)
	}
	return e
}

func TestAppendQueryNewestFirst(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-time.Hour)
	seed(t, s, []Entry{
		entryAt(base, 0, func(e *Entry) { e.Path = "/a" }),
		entryAt(base, time.Second, func(e *Entry) { e.Path = "/b" }),
		entryAt(base, 2*time.Second, func(e *Entry) { e.Path = "/c" }),
	})
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("items = %d", len(res.Items))
	}
	if res.Items[0].Path != "/c" || res.Items[2].Path != "/a" {
		t.Fatalf("order: %v", []string{res.Items[0].Path, res.Items[1].Path, res.Items[2].Path})
	}
	if res.HasMore {
		t.Fatal("unexpected hasMore")
	}
}

func TestFilters(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-time.Hour)
	seed(t, s, []Entry{
		entryAt(base, 0, nil),
		entryAt(base, time.Second, func(e *Entry) { e.Source = SourceWAF; e.Status = 403; e.Rule = "blocked" }),
		entryAt(base, 2*time.Second, func(e *Entry) { e.Source = SourceForward; e.ClientIP = "10.0.0.5"; e.Result = "closed" }),
		entryAt(base, 3*time.Second, func(e *Entry) { e.Host = "other.example"; e.Path = "/admin"; e.Status = 502 }),
	})
	cases := []struct {
		name string
		q    Query
		want int
	}{
		{"source", Query{Source: SourceWAF}, 1},
		{"status class", Query{Status: "4xx"}, 1},
		{"status exact", Query{Status: "502"}, 1},
		{"ip prefix", Query{IP: "10.0."}, 1},
		{"host substring", Query{Host: "other"}, 1},
		{"text", Query{Text: "admin"}, 1},
		{"rule", Query{RuleID: ""}, 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := s.Query(tc.q)
			if err != nil {
				t.Fatalf("query: %v", err)
			}
			if len(res.Items) != tc.want {
				t.Fatalf("got %d, want %d", len(res.Items), tc.want)
			}
		})
	}
}

func TestTimeRange(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-time.Hour)
	seed(t, s, []Entry{
		entryAt(base, 0, nil),
		entryAt(base, time.Minute, func(e *Entry) { e.Path = "/mid" }),
		entryAt(base, 2*time.Minute, func(e *Entry) { e.Path = "/late" }),
	})
	res, err := s.Query(Query{From: base.Add(30 * time.Second), To: base.Add(90 * time.Second)})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].Path != "/mid" {
		t.Fatalf("items = %+v", res.Items)
	}
}

func TestPaginationWithEqualTimestamps(t *testing.T) {
	s := newTestStore(t)
	at := time.Now().Add(-time.Minute)
	seed(t, s, []Entry{
		entryAt(at, 0, func(e *Entry) { e.Path = "/1" }),
		entryAt(at, 0, func(e *Entry) { e.Path = "/2" }),
		entryAt(at, 0, func(e *Entry) { e.Path = "/3" }),
	})
	first, err := s.Query(Query{Limit: 2})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(first.Items) != 2 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	second, err := s.Query(Query{Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("second query: %v", err)
	}
	if len(second.Items) != 1 {
		t.Fatalf("second page = %+v", second)
	}
	seen := map[string]bool{}
	for _, e := range append(first.Items, second.Items...) {
		seen[e.Path] = true
	}
	if len(seen) != 3 {
		t.Fatalf("duplicate or missing rows: %v", seen)
	}
}

func TestLimitAndHasMore(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		s.Append(entryAt(base, time.Duration(i)*time.Second, nil))
	}
	res, err := s.Query(Query{Limit: 2})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 2 || !res.HasMore || res.NextCursor == "" {
		t.Fatalf("result = %+v", res)
	}
}

func TestStats(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-time.Hour)
	seed(t, s, []Entry{
		entryAt(base, 0, func(e *Entry) { e.Status = 200; e.Bytes = 10; e.DurationMs = 1 }),
		entryAt(base, time.Second, func(e *Entry) { e.Status = 404; e.Bytes = 20; e.DurationMs = 3 }),
		entryAt(base, 2*time.Second, func(e *Entry) { e.Status = 500; e.Bytes = 30; e.DurationMs = 5; e.ClientIP = "10.0.0.1" }),
	})
	stats, err := s.Stats(Query{})
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if stats.Total != 3 || stats.Bytes != 60 {
		t.Fatalf("stats = %+v", stats)
	}
	if stats.ByStatus["2xx"] != 1 || stats.ByStatus["4xx"] != 1 || stats.ByStatus["5xx"] != 1 {
		t.Fatalf("by status = %v", stats.ByStatus)
	}
	if len(stats.TopIPs) == 0 || stats.TopIPs[0].Name == "" {
		t.Fatalf("top ips = %v", stats.TopIPs)
	}
}

func TestSeriesFillsEmptyBuckets(t *testing.T) {
	s := newTestStore(t)
	base := time.Now().Add(-2 * time.Hour).Truncate(time.Hour)
	seed(t, s, []Entry{entryAt(base, 0, nil), entryAt(base, time.Hour, nil)})
	points, err := s.Series(Query{From: base, To: base.Add(2 * time.Hour)}, time.Hour)
	if err != nil {
		t.Fatalf("series: %v", err)
	}
	if len(points) < 3 {
		t.Fatalf("points = %d", len(points))
	}
	if points[0].Total != 1 || points[1].Total != 1 || points[2].Total != 0 {
		t.Fatalf("points = %+v", points)
	}
}

func TestClear(t *testing.T) {
	s := newTestStore(t)
	seed(t, s, []Entry{entryAt(time.Now(), 0, nil)})
	if err := s.Clear(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 0 {
		t.Fatalf("items = %d", len(res.Items))
	}
}

func TestPersistDisabledWritesNothing(t *testing.T) {
	s, err := Open(t.TempDir(), Options{Persist: false})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	s.Append(entryAt(time.Now(), 0, nil))
	s.requestFlush()
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 0 {
		t.Fatalf("persist disabled wrote %d rows", len(res.Items))
	}
}

func TestCloseDrainsQueue(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, Options{Persist: true})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for i := 0; i < 50; i++ {
		s.Append(entryAt(time.Now(), time.Duration(i)*time.Millisecond, nil))
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	s2, err := Open(dir, Options{Persist: true})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	res, err := s2.Query(Query{Limit: 100})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 50 {
		t.Fatalf("items after reopen = %d", len(res.Items))
	}
}

func TestPruneDropsOldRows(t *testing.T) {
	s := newTestStore(t)
	seed(t, s, []Entry{
		entryAt(time.Now().Add(-10*24*time.Hour), 0, nil),
		entryAt(time.Now(), 0, nil),
	})
	s.Configure(Options{Persist: true, KeepDays: 7, MaxFileMB: 64})
	s.pruneOnce()
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items after prune = %d", len(res.Items))
	}
}

func TestGeoAndWAFFieldsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	seed(t, s, []Entry{entryAt(time.Now(), 0, func(e *Entry) {
		e.Country = "中国"
		e.Province = "江苏省"
		e.City = "南京市"
		e.WAFAction = "blocked"
		e.WAFRuleID = 942100
		e.Message = "SQL Injection"
	})})
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items = %d", len(res.Items))
	}
	got := res.Items[0]
	if got.Country != "中国" || got.Province != "江苏省" || got.City != "南京市" {
		t.Fatalf("geo = %+v", got)
	}
	if got.WAFAction != "blocked" || got.WAFRuleID != 942100 || got.Message != "SQL Injection" {
		t.Fatalf("waf = %+v", got)
	}
}
