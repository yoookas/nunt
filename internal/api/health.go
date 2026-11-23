package api

import (
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
)

// Health summary thresholds. Seven days is the point where a certificate has to
// be noticed by a human: automatic renewal only starts thirty days out, so a
// certificate this close means the renewal did not happen.
const (
	certWarnDays   = 7
	certInfoDays   = 30
	maxProblemRows = 10
)

// certSummary is one certificate in the health payload.
type certSummary struct {
	ID        string   `json:"id"`
	Domains   []string `json:"domains"`
	NotAfter  string   `json:"notAfter"`
	DaysLeft  int      `json:"daysLeft"`
	AutoRenew bool     `json:"autoRenew"`
	Source    string   `json:"source,omitempty"`
}

// certHealth is the aggregate state of the certificate store.
type certHealth struct {
	Total      int           `json:"total"`
	Expired    int           `json:"expired"`
	Expiring7  int           `json:"expiring7"`
	Expiring30 int           `json:"expiring30"`
	NextDays   *int          `json:"nextDays,omitempty"`
	Soon       []certSummary `json:"soon"`
}

// healthProblem is one line the dashboard shows as an alert. Severity is
// "danger" (something is broken now) or "warning" (about to break).
type healthProblem struct {
	Level  string `json:"level"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

// healthReport is the payload of GET /api/v1/system/health.
type healthReport struct {
	Now      time.Time       `json:"now"`
	Certs    certHealth      `json:"certs"`
	ACME     map[string]any  `json:"acme,omitempty"`
	Problems []healthProblem `json:"problems"`
}

func (s *Server) registerSystemHealth() {
	s.mux.Get("/api/v1/system/health", s.handleSystemHealth)
}

func (s *Server) handleSystemHealth(w http.ResponseWriter, r *http.Request) {
	var infos []certs.Info
	if s.opts.Certs != nil {
		infos = s.opts.Certs.List()
	}
	var acmeStats map[string]any
	if s.opts.Registry != nil {
		if mod, ok := s.opts.Registry.Get("acme"); ok {
			acmeStats = mod.Status().Stats
		}
	}
	var modules []module.Status
	if s.opts.Registry != nil {
		modules = s.opts.Registry.Statuses()
	}
	rest.OK(w, buildHealth(infos, acmeStats, modules, time.Now()))
}

// buildHealth turns the raw state into the dashboard summary. It is a pure
// function so the thresholds and the wording can be tested without a server.
func buildHealth(infos []certs.Info, acmeStats map[string]any, modules []module.Status, now time.Time) healthReport {
	report := healthReport{Now: now, Problems: []healthProblem{}, ACME: acmeStats}
	report.Certs.Soon = []certSummary{}

	sorted := append([]certs.Info{}, infos...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].NotAfter.Before(sorted[j].NotAfter) })

	for _, info := range sorted {
		days := int(info.NotAfter.Sub(now).Hours() / 24)
		summary := certSummary{
			ID:        info.ID,
			Domains:   info.Domains,
			NotAfter:  info.NotAfter.Format(time.RFC3339),
			DaysLeft:  days,
			AutoRenew: info.AutoRenew,
			Source:    info.Source,
		}
		report.Certs.Total++
		if !info.NotAfter.After(now) {
			report.Certs.Expired++
			report.Problems = append(report.Problems, healthProblem{
				Level:  "danger",
				Title:  "证书已过期",
				Detail: fmt.Sprintf("%s 已于 %s 过期，相关站点会握手失败", certLabel(summary), info.NotAfter.Format("2006-01-02")),
			})
			continue
		}
		if days <= certInfoDays {
			report.Certs.Soon = append(report.Certs.Soon, summary)
		}
		if days <= certInfoDays {
			report.Certs.Expiring30++
		}
		if days <= certWarnDays {
			report.Certs.Expiring7++
			detail := fmt.Sprintf("%s 还有 %d 天到期", certLabel(summary), days)
			if info.AutoRenew {
				detail += "；自动续期没有生效，请检查 ACME 任务与 DNS/端口"
			}
			report.Problems = append(report.Problems, healthProblem{
				Level:  "warning",
				Title:  "证书即将过期",
				Detail: detail,
			})
		}
	}

	if len(sorted) > 0 {
		next := int(sorted[0].NotAfter.Sub(now).Hours() / 24)
		report.Certs.NextDays = &next
	}

	// The ACME module reports the last failed renewal or issuance here.
	if acmeStats != nil {
		if msg, ok := acmeStats["lastError"].(string); ok && msg != "" {
			report.Problems = append(report.Problems, healthProblem{
				Level:  "danger",
				Title:  "证书自动续期失败",
				Detail: msg,
			})
		}
	}

	for _, st := range modules {
		if st.Running {
			continue
		}
		detail := "模块未在运行"
		if st.Error != "" {
			detail = st.Error
		}
		report.Problems = append(report.Problems, healthProblem{
			Level:  "danger",
			Title:  fmt.Sprintf("模块 %s 未启动", st.Title),
			Detail: detail,
		})
	}

	if len(report.Problems) > maxProblemRows {
		report.Problems = report.Problems[:maxProblemRows]
	}
	return report
}

func certLabel(c certSummary) string {
	if len(c.Domains) == 0 {
		return c.ID
	}
	if len(c.Domains) == 1 {
		return c.Domains[0]
	}
	return fmt.Sprintf("%s 等 %d 个域名", c.Domains[0], len(c.Domains))
}
