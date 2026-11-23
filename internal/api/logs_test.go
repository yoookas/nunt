package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/logstore"
)

// seedLogs appends the entries and waits until the writer has flushed them, so
// the assertions never race the background goroutine.
func seedLogs(t *testing.T, env *testEnv, entries ...logstore.Entry) {
	t.Helper()
	// Read the counter before appending: the writer goroutine is fast enough
	// to flush an entry before this function looks at Meta, which made the
	// target unreachable and the timeout look like a lost record.
	want := env.logs.Meta().Written + int64(len(entries))
	for _, e := range entries {
		env.logs.Append(e)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if env.logs.Meta().Written >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("written = %d, want at least %d", env.logs.Meta().Written, want)
}

func TestAccessLogQueryAndStats(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	base := time.Now().Add(-time.Minute)
	seedLogs(t, env,
		logstore.Entry{Time: base, Source: logstore.SourceWeb, Rule: "site-a", Path: "/a",
			Status: 200, ClientIP: "192.0.2.10", DurationMs: 12, Bytes: 100},
		logstore.Entry{Time: base.Add(time.Second), Source: logstore.SourceWeb, Rule: "site-a", Path: "/b",
			Status: 404, ClientIP: "198.51.100.7"},
		logstore.Entry{Time: base.Add(2 * time.Second), Source: logstore.SourceForward, Rule: "fw",
			ClientIP: "192.0.2.55", Protocol: "tcp", Result: "closed", Bytes: 42},
	)

	rec := env.do(t, http.MethodGet, "/api/v1/logs/access?source=web&limit=10", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET access log: %d %s", rec.Code, rec.Body.String())
	}
	var page struct {
		Items []logstore.Entry `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode page: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items = %d, want the 2 web records", len(page.Items))
	}
	if page.Items[0].Path != "/b" {
		t.Fatalf("first item = %q, want the newest record /b", page.Items[0].Path)
	}

	rec = env.do(t, http.MethodGet, "/api/v1/logs/access?status=4xx", nil, cookies, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "/b") {
		t.Fatalf("status filter response: %d %s", rec.Code, rec.Body.String())
	}

	rec = env.do(t, http.MethodGet, "/api/v1/logs/access?ip=192.0.2.", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("ip filter: %d", rec.Code)
	}
	var ipPage struct {
		Items []logstore.Entry `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ipPage); err != nil {
		t.Fatalf("decode ip page: %v", err)
	}
	if len(ipPage.Items) != 2 {
		t.Fatalf("ip filter items = %d, want 2", len(ipPage.Items))
	}

	rec = env.do(t, http.MethodGet, "/api/v1/logs/access/stats", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("stats: %d %s", rec.Code, rec.Body.String())
	}
	var stats logstore.Stats
	if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode stats: %v", err)
	}
	if stats.Total != 3 || stats.BySource[logstore.SourceWeb] != 2 || stats.ByStatus["4xx"] != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	if len(stats.TopIPs) != 3 {
		t.Fatalf("top ips: %+v", stats.TopIPs)
	}
}

func TestAccessLogFiltersAreValidated(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	for _, path := range []string{
		"/api/v1/logs/access?source=nginx",
		"/api/v1/logs/access?status=abc",
		"/api/v1/logs/access?from=yesterday",
		"/api/v1/logs/access?from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z",
		"/api/v1/logs/access?limit=0",
	} {
		if rec := env.do(t, http.MethodGet, path, nil, cookies, nil); rec.Code != http.StatusBadRequest {
			t.Fatalf("GET %s = %d, want 400 (%s)", path, rec.Code, rec.Body.String())
		}
	}
}

func TestAccessLogConfigUpdate(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)

	bad := map[string]any{
		"access": map[string]any{"persist": true, "keepDays": 999, "maxFileMb": 32},
		"app":    map[string]any{"maxFileMb": 8, "keepFiles": 3},
	}
	rec := env.do(t, http.MethodPut, "/api/v1/logs/config", bad, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid keepDays = %d, want 400", rec.Code)
	}

	good := map[string]any{
		"access": map[string]any{"persist": false, "keepDays": 3, "maxFileMb": 16},
		"app":    map[string]any{"maxFileMb": 4, "keepFiles": 2},
	}
	rec = env.do(t, http.MethodPut, "/api/v1/logs/config", good, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("valid config = %d %s", rec.Code, rec.Body.String())
	}
	cfg := env.store.Snapshot()
	if cfg.Logs.Access.Persist || cfg.Logs.Access.KeepDays != 3 || cfg.Logs.App.KeepFiles != 2 {
		t.Fatalf("stored logs config = %+v", cfg.Logs)
	}
	// The switch must take effect immediately: the next record is not written.
	seedLogs(t, env)
	env.logs.Append(logstore.Entry{Time: time.Now(), Source: logstore.SourceWeb, Path: "/ignored"})
	time.Sleep(30 * time.Millisecond)
	if got := env.logs.Meta().Written; got != 0 {
		t.Fatalf("written = %d with persistence off, want 0", got)
	}
}

func TestAccessLogClear(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)

	seedLogs(t, env, logstore.Entry{Time: time.Now(), Source: logstore.SourceWeb, Path: "/a", Status: 200})
	if files, _ := env.logs.Files(); len(files) == 0 {
		t.Fatal("expected a log file before clearing")
	}

	rec := env.do(t, http.MethodDelete, "/api/v1/logs/access", nil, cookies, map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("clear = %d %s", rec.Code, rec.Body.String())
	}
	if files, _ := env.logs.Files(); len(files) != 0 {
		t.Fatalf("files after clear = %v", files)
	}

	// A delete without the CSRF token is refused.
	rec = env.do(t, http.MethodDelete, "/api/v1/logs/access", nil, cookies, nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("clear without csrf = %d, want 403", rec.Code)
	}
}

func TestAccessLogExportCSV(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	seedLogs(t, env, logstore.Entry{
		Time: time.Now(), Source: logstore.SourceWeb, Rule: "站点", Path: "/导出",
		Status: 200, ClientIP: "192.0.2.1", UserAgent: "curl",
	})
	rec := env.do(t, http.MethodGet, "/api/v1/logs/access/export?source=web", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export = %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Fatalf("content type = %q", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "客户端 IP") || !strings.Contains(body, "/导出") {
		t.Fatalf("csv body = %q", body)
	}
}

func TestLogDownloadRejectsTraversal(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	for _, name := range []string{"../../config.json", "config.json", "nunt.log.99", ""} {
		rec := env.do(t, http.MethodGet, "/api/v1/system/logs/download?name="+name, nil, cookies, nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("download %q = %d, want 400", name, rec.Code)
		}
	}
	// The real name is allowed (the file may not exist yet, which is a 404).
	rec := env.do(t, http.MethodGet, "/api/v1/system/logs/download?name=nunt.log", nil, cookies, nil)
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusOK {
		t.Fatalf("download nunt.log = %d", rec.Code)
	}
}

func TestAccessLogSeries(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	base := time.Now().Truncate(time.Hour).Add(-2 * time.Hour)
	seedLogs(t, env,
		logstore.Entry{Time: base.Add(time.Minute), Source: logstore.SourceWeb, Status: 200, Bytes: 10},
		logstore.Entry{Time: base.Add(2 * time.Minute), Source: logstore.SourceWeb, Status: 404, Bytes: 5},
		logstore.Entry{Time: base.Add(61 * time.Minute), Source: logstore.SourceWeb, Status: 502, Bytes: 1},
	)

	from := base.Format(time.RFC3339)
	rec := env.do(t, http.MethodGet, "/api/v1/logs/access/series?bucket=3600&from="+url.QueryEscape(from), nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("series = %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Bucket int                    `json:"bucket"`
		Points []logstore.SeriesPoint `json:"points"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Bucket != 3600 || len(payload.Points) < 3 {
		t.Fatalf("payload = %+v", payload)
	}
	var total int64
	for _, point := range payload.Points {
		total += point.Total
	}
	if total != 3 {
		t.Fatalf("total = %d, want 3", total)
	}
	if payload.Points[0].Errors4xx+payload.Points[0].Errors5xx != 1 {
		t.Fatalf("first bucket = %+v", payload.Points[0])
	}

	// Out of range buckets are rejected rather than producing a huge payload.
	rec = env.do(t, http.MethodGet, "/api/v1/logs/access/series?bucket=60&from=2020-01-01T00:00:00Z", nil, cookies, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("huge range = %d, want 400", rec.Code)
	}
}
