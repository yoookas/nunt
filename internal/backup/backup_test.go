package backup

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func seedDataDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"config.json":       `{"version":1}`,
		"secret.key":        "0123456789abcdef",
		"certs/a.pem":       "CERT",
		"acme/account.json": `{"kty":"EC"}`,
		"logs/nunt.log":     "log line",
	}
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func readArchive(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		out[h.Name] = string(body)
	}
	return out
}

func TestCreateArchivesOnlyTheState(t *testing.T) {
	dir := seedDataDir(t)
	dest := filepath.Join(dir, "backups")
	path, err := Create(dir, dest, 7, time.Now())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	entries := readArchive(t, path)
	for _, want := range []string{"config.json", "secret.key", "certs/a.pem", "acme/account.json"} {
		if _, ok := entries[want]; !ok {
			t.Fatalf("archive is missing %s (has %v)", want, keys(entries))
		}
	}
	if _, ok := entries["logs/nunt.log"]; ok {
		t.Fatal("logs must not be archived")
	}
	if entries["config.json"] != `{"version":1}` {
		t.Fatalf("config content = %q", entries["config.json"])
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600 (the archive holds secret.key)", info.Mode().Perm())
	}
}

func TestCreateSkipsMissingOptionalEntries(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(dir, filepath.Join(dir, "backups"), 3, time.Now()); err != nil {
		t.Fatalf("a missing acme/ must not fail: %v", err)
	}
}

func TestRetentionKeepsTheNewest(t *testing.T) {
	dir := seedDataDir(t)
	dest := filepath.Join(dir, "backups")
	base := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		if _, err := Create(dir, dest, 2, base.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	infos, err := List(dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 2 {
		t.Fatalf("archives = %d, want 2", len(infos))
	}
	if infos[0].Name != NamePrefix+"20260101-060000.tar.gz" {
		t.Fatalf("newest = %s", infos[0].Name)
	}
}

func TestListAndNewestOnEmptyDir(t *testing.T) {
	dir := t.TempDir()
	infos, err := List(filepath.Join(dir, "missing"))
	if err != nil {
		t.Fatalf("missing directory must not be an error: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("infos = %v", infos)
	}
	if !Newest(dir).IsZero() {
		t.Fatal("Newest on an empty directory must be the zero time")
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
