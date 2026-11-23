package api

import (
	"testing"
	"time"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/module"
)

func TestBuildHealthCertificates(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	infos := []certs.Info{
		{ID: "expired", Domains: []string{"old.example.com"}, NotAfter: now.Add(-24 * time.Hour)},
		{ID: "soon", Domains: []string{"a.example.com"}, NotAfter: now.Add(3 * 24 * time.Hour), AutoRenew: true},
		{ID: "month", Domains: []string{"b.example.com"}, NotAfter: now.Add(20 * 24 * time.Hour), AutoRenew: true},
		{ID: "fine", Domains: []string{"c.example.com"}, NotAfter: now.Add(80 * 24 * time.Hour)},
	}
	report := buildHealth(infos, nil, nil, now)

	if report.Certs.Total != 4 {
		t.Fatalf("total = %d", report.Certs.Total)
	}
	if report.Certs.Expired != 1 {
		t.Fatalf("expired = %d", report.Certs.Expired)
	}
	if report.Certs.Expiring7 != 1 || report.Certs.Expiring30 != 2 {
		t.Fatalf("expiring7=%d expiring30=%d", report.Certs.Expiring7, report.Certs.Expiring30)
	}
	if report.Certs.NextDays == nil || *report.Certs.NextDays >= 0 {
		t.Fatalf("next days = %v, want a negative value for the expired certificate", report.Certs.NextDays)
	}
	if len(report.Problems) != 2 {
		t.Fatalf("problems = %d, want the expired and the expiring certificate: %+v", len(report.Problems), report.Problems)
	}
	if report.Problems[0].Level != "danger" || report.Problems[1].Level != "warning" {
		t.Fatalf("levels = %q/%q", report.Problems[0].Level, report.Problems[1].Level)
	}
	if len(report.Certs.Soon) != 2 {
		t.Fatalf("soon = %d, want the two certificates inside 30 days", len(report.Certs.Soon))
	}
}

func TestBuildHealthACMEAndModules(t *testing.T) {
	now := time.Now()
	acme := map[string]any{"lastError": "dns: invalid credentials"}
	modules := []module.Status{
		{Name: "web", Title: "Web service", Running: true},
		{Name: "acme", Title: "Certificates", Running: false, Error: "no account key"},
	}
	report := buildHealth(nil, acme, modules, now)

	if len(report.Problems) != 2 {
		t.Fatalf("problems = %+v", report.Problems)
	}
	if report.Problems[0].Title != "证书自动续期失败" {
		t.Fatalf("first problem = %+v", report.Problems[0])
	}
	if report.Problems[1].Title != "模块 Certificates 未启动" {
		t.Fatalf("second problem = %+v", report.Problems[1])
	}
}

func TestBuildHealthIsBounded(t *testing.T) {
	now := time.Now()
	var infos []certs.Info
	for i := 0; i < 20; i++ {
		infos = append(infos, certs.Info{ID: "c", Domains: []string{"x"}, NotAfter: now.Add(-time.Hour)})
	}
	report := buildHealth(infos, nil, nil, now)
	if len(report.Problems) != maxProblemRows {
		t.Fatalf("problems = %d, want %d", len(report.Problems), maxProblemRows)
	}
	if report.Certs.Expired != 20 {
		t.Fatalf("expired = %d", report.Certs.Expired)
	}
}

func TestSystemHealthEndpoint(t *testing.T) {
	env := newTestEnv(t)
	cookies, _ := login(t, env)
	rec := env.do(t, "GET", "/api/v1/system/health", nil, cookies, nil)
	if rec.Code != 200 {
		t.Fatalf("health = %d: %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !contains(body, `"certs"`) || !contains(body, `"problems"`) {
		t.Fatalf("body = %s", body)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
