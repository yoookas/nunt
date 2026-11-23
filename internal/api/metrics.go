package api

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/nunt/nunt/internal/sysinfo"
	"github.com/nunt/nunt/internal/version"
)

// handleMetrics serves a small Prometheus text exposition. It is mounted under
// the authenticated mux on purpose: a scraper has to use a read-only API token
// (Authorization: Bearer ...), so the topology is not public by default.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder

	writeMetric := func(name, help, typ string, value any, labels string) {
		if labels != "" {
			fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n%s%s %v\n", name, help, name, typ, name, labels, value)
			return
		}
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n%s %v\n", name, help, name, typ, name, value)
	}

	stats := sysinfo.Collect(s.opts.DataDir)
	writeMetric("nunt_up", "1 when the admin API answers.", "gauge", 1, "")
	writeMetric("nunt_uptime_seconds", "Seconds since the process started.", "gauge", int64(stats.UptimeSec), "")
	writeMetric("nunt_build_info", "Build metadata.", "gauge", 1,
		fmt.Sprintf(`{version=%q,commit=%q,go=%q}`, version.Get().Version, version.Get().Commit, version.Get().GoVersion))

	cfg := s.opts.Cfg.Snapshot()
	writeMetric("nunt_web_rules", "Configured web rules.", "gauge", len(cfg.Web.Rules), "")
	writeMetric("nunt_forward_rules", "Configured port forward rules.", "gauge", len(cfg.Forward.Rules), "")

	if s.opts.Registry != nil {
		statuses := s.opts.Registry.Statuses()
		sort.Slice(statuses, func(i, j int) bool { return statuses[i].Name < statuses[j].Name })
		var up strings.Builder
		fmt.Fprintf(&up, "# HELP nunt_module_up 1 when the module is running.\n# TYPE nunt_module_up gauge\n")
		for _, st := range statuses {
			value := 0
			if st.Running {
				value = 1
			}
			fmt.Fprintf(&up, "nunt_module_up{module=%q} %d\n", st.Name, value)
		}
		b.WriteString(up.String())
	}

	if s.opts.Certs != nil {
		infos := s.opts.Certs.List()
		writeMetric("nunt_certificates", "Certificates in the store.", "gauge", len(infos), "")
		b.WriteString("# HELP nunt_certificate_expiry_timestamp_seconds Unix time when the certificate expires.\n")
		b.WriteString("# TYPE nunt_certificate_expiry_timestamp_seconds gauge\n")
		for _, info := range infos {
			fmt.Fprintf(&b, "nunt_certificate_expiry_timestamp_seconds{id=%q} %d\n",
				info.ID, info.NotAfter.Unix())
		}
	}

	if s.opts.Logs != nil {
		meta := s.opts.Logs.Meta()
		writeMetric("nunt_access_log_written_total", "Access log records written to disk.", "counter", meta.Written, "")
		writeMetric("nunt_access_log_dropped_total", "Access log records dropped because the queue was full.", "counter", meta.Dropped, "")
		writeMetric("nunt_access_log_bytes", "Bytes currently used by access log files.", "gauge", meta.TotalBytes, "")
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}
