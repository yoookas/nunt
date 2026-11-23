package logstore

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newStore opens a store in a temporary directory and closes it on cleanup.
func newStore(t *testing.T, opts Options) *Store {
	t.Helper()
	s, err := Open(t.TempDir(), opts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	})
	return s
}

func entry(t time.Time, source, path string) Entry {
	return Entry{Time: t, Source: source, Path: path, Method: "GET", ClientIP: "192.0.2.10", Status: 200}
}

// waitWritten blocks until the store has flushed the given number of entries.
func waitWritten(t *testing.T, s *Store, want int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s.written.Load() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("written = %d, want at least %d", s.written.Load(), want)
}

func TestAppendQueryNewestFirst(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	s.Append(Entry{Time: base, Source: SourceWeb, Path: "/a", Status: 200, ClientIP: "192.0.2.1"})
	s.Append(Entry{Time: base.Add(time.Second), Source: SourceForward, Path: "/b", Status: 0, ClientIP: "192.0.2.2"})
	s.Append(Entry{Time: base.Add(2 * time.Second), Source: SourceWAF, Path: "/c", Status: 403, ClientIP: "192.0.2.3"})
	waitWritten(t, s, 3)

	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(res.Items))
	}
	if res.Items[0].Path != "/c" || res.Items[1].Path != "/b" || res.Items[2].Path != "/a" {
		t.Fatalf("order = %v, want newest first", []string{res.Items[0].Path, res.Items[1].Path, res.Items[2].Path})
	}
	if res.Items[0].Source != SourceWAF || res.Items[0].Status != 403 {
		t.Fatalf("fields not preserved: %+v", res.Items[0])
	}
}

func TestFilters(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	s.Append(Entry{Time: base, Source: SourceWeb, Path: "/ok", Host: "a.example.com", Method: "GET",
		Status: 200, ClientIP: "192.0.2.10", UserAgent: "Mozilla/5.0"})
	s.Append(Entry{Time: base.Add(time.Second), Source: SourceWeb, Path: "/missing", Host: "b.example.com",
		Method: "POST", Status: 404, ClientIP: "198.51.100.7"})
	s.Append(Entry{Time: base.Add(2 * time.Second), Source: SourceForward, Protocol: "tcp",
		Path: "", ClientIP: "192.0.2.55", Status: 0, Result: "closed"})
	waitWritten(t, s, 3)

	cases := []struct {
		name  string
		query Query
		want  int
	}{
		{"source web", Query{Source: "web"}, 2},
		{"source forward", Query{Source: "forward"}, 1},
		{"status class", Query{Status: "4xx"}, 1},
		{"exact status", Query{Status: "200"}, 1},
		{"ip prefix", Query{IP: "192.0.2."}, 2},
		{"host", Query{Host: "b.example"}, 1},
		{"method", Query{Method: "POST"}, 1},
		{"text in path", Query{Text: "/miss"}, 1},
		{"text in result", Query{Text: "closed"}, 1},
		{"text in user agent", Query{Text: "mozilla"}, 1},
		{"no match", Query{Text: "nothing-here"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := s.Query(tc.query)
			if err != nil {
				t.Fatalf("Query: %v", err)
			}
			if len(res.Items) != tc.want {
				t.Fatalf("items = %d, want %d", len(res.Items), tc.want)
			}
		})
	}
}

func TestTimeRange(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	for i := 0; i < 5; i++ {
		s.Append(entry(base.Add(time.Duration(i)*time.Minute), SourceWeb, fmt.Sprintf("/%d", i)))
	}
	waitWritten(t, s, 5)

	res, err := s.Query(Query{From: base.Add(time.Minute), To: base.Add(3 * time.Minute)})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(res.Items))
	}
	for _, e := range res.Items {
		if e.Time.Before(base.Add(time.Minute)) || e.Time.After(base.Add(3*time.Minute)) {
			t.Fatalf("entry %v outside the range", e.Time)
		}
	}
}

func TestPaginationCursorWithEqualTimestamps(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	// One timestamp shared by every record: the cursor has to skip exactly the
	// records already returned, never a whole page more or less.
	for i := 0; i < 5; i++ {
		s.Append(Entry{Time: base, Source: SourceWeb, Path: fmt.Sprintf("/p%d", i), Status: 200})
	}
	waitWritten(t, s, 5)

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		res, err := s.Query(Query{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatalf("Query: %v", err)
		}
		pages++
		for _, e := range res.Items {
			if seen[e.Path] {
				t.Fatalf("duplicate %s across pages", e.Path)
			}
			seen[e.Path] = true
		}
		if !res.HasMore {
			break
		}
		cursor = res.NextCursor
		if cursor == "" {
			t.Fatal("HasMore without a cursor")
		}
		if pages > 10 {
			t.Fatal("pagination does not terminate")
		}
	}
	if len(seen) != 5 {
		t.Fatalf("saw %d records, want 5", len(seen))
	}
	if pages != 3 {
		t.Fatalf("pages = %d, want 3", pages)
	}
}

func TestLimitAndHasMore(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	for i := 0; i < 7; i++ {
		s.Append(entry(base.Add(time.Duration(i)*time.Second), SourceWeb, fmt.Sprintf("/%d", i)))
	}
	waitWritten(t, s, 7)

	res, err := s.Query(Query{Limit: 3})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Items) != 3 || !res.HasMore {
		t.Fatalf("items = %d hasMore = %v, want 3/true", len(res.Items), res.HasMore)
	}
}

func TestStats(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	rows := []Entry{
		{Time: base, Source: SourceWeb, Path: "/a", Status: 200, ClientIP: "192.0.2.1", Bytes: 100, DurationMs: 10},
		{Time: base.Add(time.Second), Source: SourceWeb, Path: "/a", Status: 404, ClientIP: "192.0.2.1", Bytes: 50, DurationMs: 20},
		{Time: base.Add(2 * time.Second), Source: SourceWeb, Path: "/b", Status: 502, ClientIP: "192.0.2.2", Bytes: 0, DurationMs: 30},
	}
	for _, e := range rows {
		s.Append(e)
	}
	waitWritten(t, s, 3)

	st, err := s.Stats(Query{})
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if st.Total != 3 || st.Bytes != 150 {
		t.Fatalf("total = %d bytes = %d, want 3/150", st.Total, st.Bytes)
	}
	if st.ByStatus["2xx"] != 1 || st.ByStatus["4xx"] != 1 || st.ByStatus["5xx"] != 1 {
		t.Fatalf("byStatus = %v", st.ByStatus)
	}
	if st.BySource[SourceWeb] != 3 {
		t.Fatalf("bySource = %v", st.BySource)
	}
	if len(st.TopIPs) != 2 || st.TopIPs[0].Name != "192.0.2.1" || st.TopIPs[0].Count != 2 {
		t.Fatalf("topIps = %v", st.TopIPs)
	}
	if len(st.TopPaths) != 2 || st.TopPaths[0].Name != "/a" {
		t.Fatalf("topPaths = %v", st.TopPaths)
	}
	if st.AvgDurationMs != 20 {
		t.Fatalf("avg duration = %v, want 20", st.AvgDurationMs)
	}
	if !st.Complete {
		t.Fatal("complete = false for a small window")
	}
}

func TestRotationCreatesSecondFile(t *testing.T) {
	s := newStore(t, Options{Persist: true, MaxFileMB: 1})
	base := time.Date(2026, 3, 4, 10, 0, 0, 0, time.Local)
	// ~250 bytes per record: 6000 records cross the 1 MiB threshold.
	body := make([]byte, 200)
	for i := range body {
		body[i] = 'x'
	}
	const n = 6000
	for i := 0; i < n; i++ {
		s.Append(Entry{Time: base.Add(time.Duration(i) * time.Millisecond), Source: SourceWeb,
			Path: "/" + string(body), Status: 200})
	}
	waitWritten(t, s, n)

	files, err := s.Files()
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) < 2 {
		t.Fatalf("files = %d, want at least 2 after crossing the size limit", len(files))
	}
	res, err := s.Query(Query{Limit: 1})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(res.Items))
	}
}

func TestPruneDropsExpiredFiles(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().AddDate(0, 0, -10)
	name := fileName(old.Format(dayLayout), 0)
	if err := os.WriteFile(filepath.Join(dir, name), []byte("{}\n"), 0o640); err != nil {
		t.Fatalf("write old file: %v", err)
	}
	s, err := Open(dir, Options{Persist: true, KeepDays: 2})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	files, err := s.Files()
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("files = %v, want the expired file pruned", files)
	}
}

func TestClear(t *testing.T) {
	s := newStore(t, Options{Persist: true})
	s.Append(entry(time.Now(), SourceWeb, "/a"))
	waitWritten(t, s, 1)
	if err := s.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	files, err := s.Files()
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("files = %v, want none", files)
	}
	// Recording keeps working after a clear.
	s.Append(entry(time.Now(), SourceWeb, "/b"))
	waitWritten(t, s, 2)
	res, err := s.Query(Query{})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].Path != "/b" {
		t.Fatalf("items = %v, want only /b", res.Items)
	}
}

func TestPersistDisabledWritesNothing(t *testing.T) {
	s := newStore(t, Options{Persist: false})
	s.Append(entry(time.Now(), SourceWeb, "/a"))
	time.Sleep(50 * time.Millisecond)
	files, err := s.Files()
	if err != nil {
		t.Fatalf("Files: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("files = %v, want none when persistence is off", files)
	}
	if got := s.Meta().Persist; got {
		t.Fatal("Meta reports persistence on")
	}
}

func TestCloseDrainsQueue(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, Options{Persist: true})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	base := time.Now()
	for i := 0; i < 50; i++ {
		s.Append(entry(base.Add(time.Duration(i)*time.Millisecond), SourceWeb, fmt.Sprintf("/%d", i)))
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("files = %d, want 1", len(files))
	}
	info, err := files[0].Info()
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("the flushed file is empty")
	}
}

func TestScanFileReverseHandlesChunks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.jsonl")
	var want []string
	var data []byte
	for i := 0; i < 2000; i++ {
		line := fmt.Sprintf("line-%04d", i)
		want = append(want, line)
		data = append(data, line...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o640); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	var got []string
	if err := scanFileReverse(path, func(line []byte) bool {
		got = append(got, string(line))
		return true
	}); err != nil {
		t.Fatalf("scanFileReverse: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("lines = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[len(want)-1-i] {
			t.Fatalf("line %d = %q, want %q", i, got[i], want[len(want)-1-i])
		}
	}
}
