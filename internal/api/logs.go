package api

import (
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

// exportRowLimit bounds how many records a single CSV download contains.
const exportRowLimit = 100000

func (s *Server) registerLogs() {
	g := s.mux.Group("/api/v1/logs")
	g.Get("/access", s.handleAccessLogs)
	g.Get("/access/stats", s.handleAccessLogStats)
	g.Get("/access/series", s.handleAccessLogSeries)
	g.Get("/access/meta", s.handleAccessLogMeta)
	g.Get("/access/export", s.handleAccessLogExport)
	g.Delete("/access", s.handleClearAccessLogs)
	g.Get("/config", s.handleGetLogConfig)
	g.Put("/config", s.handleUpdateLogConfig)
	s.registerLogFiles()
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

// accessQuery reads the filters shared by the list, stats and export
// endpoints. Time values are RFC3339 or unix seconds.
func accessQuery(r *http.Request) (logstore.Query, error) {
	v := r.URL.Query()
	q := logstore.Query{
		Source: strings.TrimSpace(v.Get("source")),
		RuleID: strings.TrimSpace(v.Get("rule")),
		Host:   strings.TrimSpace(v.Get("host")),
		IP:     strings.TrimSpace(v.Get("ip")),
		Method: strings.TrimSpace(v.Get("method")),
		Status: strings.TrimSpace(v.Get("status")),
		Text:   strings.TrimSpace(v.Get("q")),
		Cursor: strings.TrimSpace(v.Get("cursor")),
	}
	if q.Source != "" {
		switch q.Source {
		case logstore.SourceWeb, logstore.SourceForward, logstore.SourceWAF:
		default:
			return q, fmt.Errorf("来源只能是 web、forward 或 waf")
		}
	}
	if q.Status != "" {
		if !validStatusFilter(q.Status) {
			return q, fmt.Errorf("状态码只能是 1xx/2xx/3xx/4xx/5xx 或三位数字")
		}
	}
	if raw := strings.TrimSpace(v.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return q, fmt.Errorf("limit 必须是正整数")
		}
		q.Limit = n
	}
	var err error
	if q.From, err = parseTimeParam(v.Get("from")); err != nil {
		return q, fmt.Errorf("from 不合法：%w", err)
	}
	if q.To, err = parseTimeParam(v.Get("to")); err != nil {
		return q, fmt.Errorf("to 不合法：%w", err)
	}
	if !q.From.IsZero() && !q.To.IsZero() && q.From.After(q.To) {
		return q, fmt.Errorf("from 不能晚于 to")
	}
	return q, nil
}

func validStatusFilter(raw string) bool {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if len(raw) == 3 && raw[1] == 'x' && raw[2] == 'x' {
		return raw[0] >= '1' && raw[0] <= '5'
	}
	if len(raw) != 3 {
		return false
	}
	n, err := strconv.Atoi(raw)
	return err == nil && n >= 100 && n <= 599
}

func parseTimeParam(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t, nil
	}
	if secs, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.Unix(secs, 0), nil
	}
	return time.Time{}, fmt.Errorf("需要 RFC3339 时间或 unix 秒数")
}

func (s *Server) logStore() *logstore.Store { return s.opts.Logs }

// ---------------------------------------------------------------------------
// access records
// ---------------------------------------------------------------------------

func (s *Server) handleAccessLogs(w http.ResponseWriter, r *http.Request) {
	store := s.logStore()
	if store == nil {
		rest.OK(w, logstore.Result{Items: []logstore.Entry{}})
		return
	}
	q, err := accessQuery(r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err)
		return
	}
	res, err := store.Query(q)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "读取访问日志失败：%s", err)
		return
	}
	rest.OK(w, res)
}

func (s *Server) handleAccessLogStats(w http.ResponseWriter, r *http.Request) {
	store := s.logStore()
	if store == nil {
		rest.OK(w, logstore.Stats{BySource: map[string]int64{}, ByStatus: map[string]int64{}, Complete: true})
		return
	}
	q, err := accessQuery(r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err)
		return
	}
	st, err := store.Stats(q)
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "统计访问日志失败：%s", err)
		return
	}
	rest.OK(w, st)
}

// handleAccessLogSeries returns the request counts per time bucket, which is
// what the overview chart draws.
func (s *Server) handleAccessLogSeries(w http.ResponseWriter, r *http.Request) {
	store := s.logStore()
	bucket := 3600
	if raw := strings.TrimSpace(r.URL.Query().Get("bucket")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 60 || n > 3600 {
			rest.Fail(w, http.StatusBadRequest, "bucket 必须是 60 到 3600 之间的秒数")
			return
		}
		bucket = n
	}
	if store == nil {
		rest.OK(w, map[string]any{"bucket": bucket, "points": []logstore.SeriesPoint{}})
		return
	}
	q, err := accessQuery(r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err)
		return
	}
	points, err := store.Series(q, time.Duration(bucket)*time.Second)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "读取趋势失败：%s", err)
		return
	}
	rest.OK(w, map[string]any{"bucket": bucket, "points": points})
}

func (s *Server) handleAccessLogMeta(w http.ResponseWriter, r *http.Request) {
	store := s.logStore()
	if store == nil {
		rest.OK(w, logstore.Meta{Files: []logstore.File{}})
		return
	}
	rest.OK(w, store.Meta())
}

// handleAccessLogExport streams the filtered records as CSV. The loop walks
// the cursor so a large range is exported page by page instead of in memory.
func (s *Server) handleAccessLogExport(w http.ResponseWriter, r *http.Request) {
	store := s.logStore()
	if store == nil {
		rest.Fail(w, http.StatusConflict, "访问日志存储未启用")
		return
	}
	q, err := accessQuery(r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err)
		return
	}
	q.Limit = logstore.MaxLimit

	name := fmt.Sprintf("nunt-access-%s.csv", time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Cache-Control", "no-store")
	// The BOM makes Excel open the file as UTF-8 instead of mangling the
	// Chinese column titles.
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})

	cw := csv.NewWriter(w)
	head := exportColumns(q.Source)
	_ = cw.Write(head)

	written := 0
	for page := 0; page < exportRowLimit/logstore.MaxLimit+1; page++ {
		res, err := store.Query(q)
		if err != nil {
			// The header is already on the wire; stop cleanly.
			break
		}
		for _, e := range res.Items {
			// Every field here is influenced by the request that produced it
			// (path, Host, User-Agent, WAF message), so the cells are neutralised
			// before a spreadsheet gets the chance to evaluate one.
			cells := exportCells(e)
			row := make([]string, len(head))
			for i, name := range head {
				row[i] = cells[name]
			}
			for i := range row {
				row[i] = csvSafe(row[i])
			}
			_ = cw.Write(row)
			written++
			if written >= exportRowLimit {
				break
			}
		}
		if !res.HasMore || written >= exportRowLimit || res.NextCursor == "" {
			break
		}
		q.Cursor = res.NextCursor
	}
	cw.Flush()
}

// exportColumns mirrors the table the operator is looking at: a port-forward
// row has no method, path, status or User-Agent, so those columns are dropped
// instead of being written empty on every line. An export that does not pin a
// source keeps the full superset plus a 来源 column, because it may mix rows.
func exportColumns(source string) []string {
	switch source {
	case logstore.SourceForward:
		return []string{"时间", "规则", "监听", "客户端 IP", "国家", "省份", "城市",
			"目标", "结果", "拒绝原因", "错误", "耗时(ms)", "请求字节", "响应字节",
			"总字节", "消息"}
	case logstore.SourceWeb, logstore.SourceWAF:
		// A web export also carries the WAF interceptions, because that is the
		// same traffic; the 来源 column tells the two apart.
		return []string{"时间", "来源", "请求 ID", "规则", "协议", "TLS", "监听", "域名", "方法",
			"路径", "状态", "上游状态", "尝试次数", "结果", "拒绝原因", "错误",
			"客户端 IP", "国家", "省份", "城市", "上游", "耗时(ms)", "请求字节",
			"响应字节", "总字节", "User-Agent", "WAF 动作", "消息"}
	default:
		return []string{"时间", "来源", "请求 ID", "规则", "协议", "TLS", "监听", "域名",
			"方法", "路径", "状态", "上游状态", "尝试次数", "结果", "拒绝原因", "错误",
			"客户端 IP", "国家", "省份", "城市", "上游", "耗时(ms)", "请求字节",
			"响应字节", "总字节", "User-Agent", "WAF 动作", "消息"}
	}
}

// exportCells renders every named column; exportColumns picks the subset.
func exportCells(e logstore.Entry) map[string]string {
	return map[string]string{
		"时间":         e.Time.Format("2006-01-02 15:04:05"),
		"来源":         e.Source,
		"请求 ID":      e.RequestID,
		"规则":         e.Rule,
		"协议":         e.Proto,
		"TLS":        e.TLS,
		"监听":         e.Listen,
		"域名":         e.Host,
		"方法":         e.Method,
		"路径":         e.Path,
		"状态":         statusCell(e.Status),
		"上游状态":       optionalInt(e.UpstreamStatus),
		"尝试次数":       optionalInt(e.Attempts),
		"结果":         e.Result,
		"拒绝原因":       e.Reason,
		"错误":         e.Error,
		"客户端 IP":     e.ClientIP,
		"国家":         e.Country,
		"省份":         e.Province,
		"城市":         e.City,
		"上游":         e.Upstream,
		"目标":         e.Upstream,
		"耗时(ms)":     durationCell(e.DurationMs),
		"请求字节":       optionalInt64(e.BytesIn),
		"响应字节":       optionalInt64(e.BytesOut),
		"总字节":        optionalInt64(e.Bytes),
		"User-Agent": e.UserAgent,
		"WAF 动作":     e.WAFAction,
		"消息":         e.Message,
	}
}

// csvSafe neutralises a cell that a spreadsheet would evaluate as a formula.
// Access log fields are chosen by the requests that produced them, so a visitor
// can plant "=cmd|..." in a User-Agent and wait for the operator to open the
// export: a leading apostrophe makes the spreadsheet treat the cell as text and
// is not displayed. Numeric and ordinary text cells are returned unchanged.
func csvSafe(cell string) string {
	if cell == "" {
		return cell
	}
	switch cell[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + cell
	}
	return cell
}

func statusCell(status int) string {
	if status <= 0 {
		return ""
	}
	return strconv.Itoa(status)
}

func optionalInt(value int) string {
	if value <= 0 {
		return ""
	}
	return strconv.Itoa(value)
}

func optionalInt64(value int64) string {
	if value <= 0 {
		return ""
	}
	return strconv.FormatInt(value, 10)
}

func durationCell(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return strconv.FormatInt(ms, 10)
}

func (s *Server) handleClearAccessLogs(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	store := s.logStore()
	if store == nil {
		rest.OK(w, map[string]any{"status": "cleared"})
		return
	}
	if err := store.Clear(); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "清空访问日志失败：%s", err)
		return
	}
	s.audit(r, "logs.access.clear")
	rest.OK(w, map[string]any{"status": "cleared"})
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

func (s *Server) handleGetLogConfig(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, s.opts.Cfg.Snapshot().Logs)
}

func (s *Server) handleUpdateLogConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req model.LogConfig
	if !jsonBody(w, r, &req) {
		return
	}
	if err := validateLogConfig(req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err)
		return
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.Logs = req
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "保存日志设置失败：%s", err)
		return
	}
	// The configuration subscriber in the application does the same; calling
	// it here keeps an API server built without one (tests) correct too.
	if store := s.logStore(); store != nil {
		store.Configure(logstore.Options{
			Persist:   req.Access.Persist,
			KeepDays:  req.Access.KeepDays,
			MaxFileMB: req.Access.MaxFileMB,
		})
	}
	s.opts.Log.SetLimits(logging.Options{MaxFileMB: req.App.MaxFileMB, KeepFiles: req.App.KeepFiles})
	s.audit(r, "logs.config", "persist", req.Access.Persist, "keepDays", req.Access.KeepDays)
	rest.OK(w, s.opts.Cfg.Snapshot().Logs)
}

func validateLogConfig(c model.LogConfig) error {
	if c.Access.KeepDays < 1 || c.Access.KeepDays > logstore.MaxKeepDays {
		return fmt.Errorf("保留天数必须在 1 到 %d 之间", logstore.MaxKeepDays)
	}
	if c.Access.MaxFileMB < 1 || c.Access.MaxFileMB > logstore.MaxFileMB {
		return fmt.Errorf("访问日志单文件上限必须在 1 到 %d MB 之间", logstore.MaxFileMB)
	}
	if c.App.MaxFileMB < 1 || c.App.MaxFileMB > 1024 {
		return fmt.Errorf("运行日志单文件上限必须在 1 到 1024 MB 之间")
	}
	if c.App.KeepFiles < 1 || c.App.KeepFiles > 10 {
		return fmt.Errorf("运行日志保留份数必须在 1 到 10 之间")
	}
	return nil
}

// ---------------------------------------------------------------------------
// process log files
// ---------------------------------------------------------------------------

func (s *Server) registerLogFiles() {
	g := s.mux.Group("/api/v1/system/logs")
	g.Get("/files", s.handleLogFiles)
	g.Get("/download", s.handleLogDownload)
}

type logFileView struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

func (s *Server) handleLogFiles(w http.ResponseWriter, r *http.Request) {
	dir := filepath.Join(s.opts.DataDir, "logs")
	out := []logFileView{}
	for _, name := range logFileNames() {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		out = append(out, logFileView{Name: name, Size: info.Size(), ModTime: info.ModTime()})
	}
	rest.OK(w, out)
}

// handleLogDownload serves one of the process log files. The name is checked
// against a fixed list, so the handler can never be talked into reading an
// arbitrary path.
func (s *Server) handleLogDownload(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if !validLogFileName(name) {
		rest.Fail(w, http.StatusBadRequest, "日志文件名不合法")
		return
	}
	path := filepath.Join(s.opts.DataDir, "logs", name)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			rest.Fail(w, http.StatusNotFound, "日志文件不存在")
			return
		}
		rest.Fail(w, http.StatusInternalServerError, "无法打开日志文件：%s", err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法读取日志文件：%s", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// logFileNames lists the files the rotating logger can produce.
func logFileNames() []string {
	out := []string{"nunt.log"}
	for i := 1; i <= 10; i++ {
		out = append(out, fmt.Sprintf("nunt.log.%d", i))
	}
	return out
}

func validLogFileName(name string) bool {
	for _, candidate := range logFileNames() {
		if candidate == name {
			return true
		}
	}
	return false
}
