package acme

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

func TestNormalizeCA(t *testing.T) {
	valid := map[string]string{
		"":                    "",
		" LETSENCRYPT ":       "letsencrypt",
		"letsencrypt-staging": "letsencrypt-staging",
		"custom":              "custom",
	}
	for in, want := range valid {
		got, err := normalizeCA(in)
		if err != nil || got != want {
			t.Fatalf("normalizeCA(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"zerossl", "buypass", "nope"} {
		if _, err := normalizeCA(in); err == nil {
			t.Fatalf("normalizeCA(%q) must be rejected", in)
		}
	}
}

func TestJobStoresItsOwnCA(t *testing.T) {
	a := newConfigModule(t)
	body := `{"name":"t","enable":true,"domains":["example.com"],"challenge":"http","ca":"letsencrypt-staging"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/acme/jobs", strings.NewReader(body))
	rec := httptest.NewRecorder()
	a.handleCreateJob(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create job = %d: %s", rec.Code, rec.Body.String())
	}
	jobs := a.deps.Cfg.Snapshot().ACME.Jobs
	if len(jobs) != 1 || jobs[0].CA != "letsencrypt-staging" {
		t.Fatalf("stored jobs = %+v", jobs)
	}

	// An unsupported CA is refused.
	bad := `{"name":"x","enable":true,"domains":["bad.example.com"],"challenge":"http","ca":"zerossl"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/acme/jobs", strings.NewReader(bad))
	rec = httptest.NewRecorder()
	a.handleCreateJob(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown CA = %d: %s", rec.Code, rec.Body.String())
	}
	if got := len(a.deps.Cfg.Snapshot().ACME.Jobs); got != 1 {
		t.Fatalf("a rejected job was stored, jobs = %d", got)
	}
}

func TestRequestFollowsJobCAWithGlobalFallback(t *testing.T) {
	cfg := &model.Config{ACME: model.ACMEConfig{CA: "letsencrypt-staging"}}
	job := model.CertJob{Domains: []string{"a.example.com"}, CA: "letsencrypt"}
	if req := newRequest(cfg, job); req.ca != "letsencrypt" {
		t.Fatalf("job CA = %q", req.ca)
	}
	job.CA = ""
	if req := newRequest(cfg, job); req.ca != "letsencrypt-staging" {
		t.Fatalf("fallback CA = %q", req.ca)
	}
}

func TestAccountFilesArePerDirectory(t *testing.T) {
	m := newAccountManager(&module.Deps{DataDir: filepath.Join(t.TempDir(), "data")}, slog.Default())
	prod := m.accountPath("https://acme-v02.api.letsencrypt.org/directory")
	staging := m.accountPath("https://acme-staging-v02.api.letsencrypt.org/directory")
	if prod == staging {
		t.Fatal("two CAs must not share an account file")
	}
	if !strings.Contains(prod, "account-") || !strings.HasSuffix(prod, ".json") {
		t.Fatalf("unexpected account path %q", prod)
	}
	// The registration view still runs through the shared key path.
	if !strings.HasSuffix(m.keyPath(), "account.key") {
		t.Fatalf("key path = %q", m.keyPath())
	}
	// The JSON view of a job exposes the CA so the UI can show it.
	view := aJobViewForCA(t)
	if view.CA != "custom" {
		t.Fatalf("job view CA = %q", view.CA)
	}
}

func aJobViewForCA(t *testing.T) model.CertJob {
	t.Helper()
	raw := `{"id":"j1","name":"x","domains":["a.example.com"],"challenge":"http","ca":"custom"}`
	var job model.CertJob
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	return job
}

// A job may pick the custom CA, but only when the instance has a directory URL.
func TestCustomCAJobNeedsADirectory(t *testing.T) {
	a := newConfigModule(t)
	body := `{"name":"c","enable":true,"domains":["a.example.com"],"challenge":"http","ca":"custom"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/acme/jobs", strings.NewReader(body))
	rec := httptest.NewRecorder()
	a.handleCreateJob(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "目录 URL") {
		t.Fatalf("custom CA without a directory = %d: %s", rec.Code, rec.Body.String())
	}
}
