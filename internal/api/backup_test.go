package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestBackupConfigValidation(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)

	bad := []map[string]any{
		{"enabled": true, "intervalHours": 0, "keep": 7},
		{"enabled": true, "intervalHours": 24, "keep": 0},
		{"enabled": true, "intervalHours": 24, "keep": 61},
		{"enabled": true, "intervalHours": 24, "keep": 7, "dir": "relative/path"},
	}
	for _, body := range bad {
		rec := env.do(t, http.MethodPut, "/api/v1/system/backup/config", body, cookies,
			map[string]string{"X-CSRF-Token": csrf})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %v = %d, want 400", body, rec.Code)
		}
	}

	good := map[string]any{"enabled": true, "intervalHours": 12, "keep": 5, "dir": ""}
	rec := env.do(t, http.MethodPut, "/api/v1/system/backup/config", good, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("valid config = %d: %s", rec.Code, rec.Body.String())
	}
	stored := env.store.Snapshot().Backup
	if !stored.Enabled || stored.IntervalHours != 12 || stored.Keep != 5 {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestBackupDownloadAndList(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)

	// The listing starts empty (the directory may not exist yet).
	rec := env.do(t, http.MethodGet, "/api/v1/system/backup/files", nil, cookies, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"files"`) {
		t.Fatalf("list = %d: %s", rec.Code, rec.Body.String())
	}

	rec = env.do(t, http.MethodGet, "/api/v1/system/backup", nil, cookies, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("download = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("content type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "nunt-backup-") {
		t.Fatalf("content disposition = %q", cd)
	}
	body := rec.Body.Bytes()
	if len(body) < 2 || body[0] != 0x1f || body[1] != 0x8b {
		t.Fatalf("body is not gzip: %x", body[:min(4, len(body))])
	}

	// The archive is kept, so it shows up in the listing.
	rec = env.do(t, http.MethodGet, "/api/v1/system/backup/files", nil, cookies, nil)
	if !strings.Contains(rec.Body.String(), "nunt-backup-") {
		t.Fatalf("listing does not contain the archive: %s", rec.Body.String())
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
