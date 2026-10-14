package api

import (
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/sysinfo"
	"github.com/nunt/nunt/internal/version"
)

// maskSentinel marks a secret that the client did not change.
const maskSentinel = "********"

func (s *Server) registerSystem() {
	g := s.mux.Group("/api/v1/system")
	g.Get("/info", s.handleSystemInfo)
	g.Get("/stats", s.handleSystemStats)
	g.Get("/logs", s.handleSystemLogs)
	g.Get("/interfaces", s.handleInterfaces)
	g.Get("/settings", s.handleGetSettings)
	g.Put("/settings", s.handleUpdateSettings)
	g.Get("/config", s.handleExportConfig)
	g.Put("/config", s.handleImportConfig)
	g.Post("/reload", s.handleReload)
	g.Get("/sessions", s.handleListSessions)
}

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	cfg := s.opts.Cfg.Snapshot()
	stats := sysinfo.Collect(s.opts.DataDir)
	rest.OK(w, map[string]any{
		"version":   version.Get(),
		"startedAt": stats.StartTime,
		"dataDir":   s.opts.DataDir,
		"webRules":  len(cfg.Web.Rules),
		"modules":   s.opts.Registry.Statuses(),
		// Effective admin IP allow list (empty = unrestricted) and how many
		// requests it rejected since start up.
		"adminAllowList": s.adminAllowListInfo(),
	})
}

func (s *Server) handleSystemStats(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, sysinfo.Collect(s.opts.DataDir))
}

func (s *Server) handleSystemLogs(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	rest.OK(w, map[string]any{"entries": s.opts.Log.Recent(limit), "level": s.opts.Log.Level()})
}

func (s *Server) handleInterfaces(w http.ResponseWriter, r *http.Request) {
	type ifaceView struct {
		Name  string   `json:"name"`
		Addrs []string `json:"addrs"`
		Up    bool     `json:"up"`
	}
	out := []ifaceView{}
	ifaces, err := net.Interfaces()
	if err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法列出网卡：%s", err)
		return
	}
	for _, iface := range ifaces {
		view := ifaceView{Name: iface.Name, Up: iface.Flags&net.FlagUp != 0}
		addrs, err := iface.Addrs()
		if err == nil {
			for _, addr := range addrs {
				view.Addrs = append(view.Addrs, addr.String())
			}
		}
		out = append(out, view)
	}
	rest.OK(w, out)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	cfg := s.opts.Cfg.Snapshot()
	rest.OK(w, cfg.System)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req model.SystemConfig
	if !jsonBody(w, r, &req) {
		return
	}
	if req.AdminListen != "" {
		if _, err := netutil.NormalizeListen(req.AdminListen); err != nil {
			rest.Fail(w, http.StatusBadRequest, "管理后台监听地址不合法：%s", err)
			return
		}
	}
	if _, err := netutil.ParseIPList(req.AdminAllowIPs); err != nil {
		rest.Fail(w, http.StatusBadRequest, "管理后台 IP 白名单不合法：%s", err)
		return
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.System = req
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "无法保存设置：%s", err)
		return
	}
	s.opts.Log.SetLevel(req.LogLevel)
	s.audit(r, "system.settings")
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	rest.OK(w, s.opts.Cfg.Snapshot().System)
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	s.audit(r, "system.reload")
	rest.OK(w, map[string]any{"status": "reloaded"})
}

// ---------------------------------------------------------------------------
// configuration import / export
// ---------------------------------------------------------------------------

func (s *Server) handleExportConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	cfg := s.opts.Cfg.Snapshot()
	maskConfigSecrets(cfg)
	w.Header().Set("Content-Disposition", "attachment; filename=nunt-config.json")
	rest.JSON(w, http.StatusOK, cfg)
}

func (s *Server) handleImportConfig(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	type importRequest struct {
		Config *model.Config `json:"config"`
	}
	var req importRequest
	if !jsonBody(w, r, &req) {
		return
	}
	if req.Config == nil {
		rest.Fail(w, http.StatusBadRequest, "缺少 config 字段")
		return
	}
	old := s.opts.Cfg.Snapshot()
	restoreSecrets(old, req.Config)
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		// Tokens and users are managed through their own endpoints; only the
		// imported users are kept when they carry a password hash.
		users := make([]model.User, 0, len(req.Config.Users))
		for _, u := range req.Config.Users {
			if u.PasswordHash == "" {
				continue
			}
			users = append(users, u)
		}
		if len(users) > 0 {
			c.Users = users
		}
		c.System = req.Config.System
		c.Web = req.Config.Web
		c.Forward = req.Config.Forward
		c.DDNS = req.Config.DDNS
		c.ACME = req.Config.ACME
		c.Storage = req.Config.Storage
		c.WAF = req.Config.WAF
		c.Tasks = req.Config.Tasks
		c.Notify = req.Config.Notify
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "无法导入配置：%s", err)
		return
	}
	s.audit(r, "system.config.import")
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	rest.OK(w, map[string]any{"status": "imported"})
}

func maskConfigSecrets(cfg *model.Config) {
	for i := range cfg.Users {
		cfg.Users[i].PasswordHash = ""
	}
	cfg.Tokens = nil
	for i := range cfg.DDNS.Rules {
		for k, v := range cfg.DDNS.Rules[i].Creds {
			cfg.DDNS.Rules[i].Creds[k] = secret.Mask(v)
		}
		if cb := cfg.DDNS.Rules[i].Callback; cb != nil && cb.BasicPass != "" {
			cb.BasicPass = maskSentinel
		}
	}
	for i := range cfg.ACME.Jobs {
		for k, v := range cfg.ACME.Jobs[i].DNSCreds {
			cfg.ACME.Jobs[i].DNSCreds[k] = secret.Mask(v)
		}
	}
	for i := range cfg.Storage.Mounts {
		if cfg.Storage.Mounts[i].Password != "" {
			cfg.Storage.Mounts[i].Password = maskSentinel
		}
	}
	for i := range cfg.Notify.Webhooks {
		for k, v := range cfg.Notify.Webhooks[i].Headers {
			cfg.Notify.Webhooks[i].Headers[k] = secret.Mask(v)
		}
	}
}

func restoreSecrets(old, next *model.Config) {
	oldDDNS := map[string]map[string]string{}
	for _, r := range old.DDNS.Rules {
		oldDDNS[r.ID] = r.Creds
	}
	for i := range next.DDNS.Rules {
		r := &next.DDNS.Rules[i]
		prev := oldDDNS[r.ID]
		for k, v := range r.Creds {
			if isMasked(v) && prev != nil {
				r.Creds[k] = prev[k]
			}
		}
		if r.Callback != nil && isMasked(r.Callback.BasicPass) {
			for _, o := range old.DDNS.Rules {
				if o.ID == r.ID && o.Callback != nil {
					r.Callback.BasicPass = o.Callback.BasicPass
				}
			}
		}
	}
	oldACME := map[string]map[string]string{}
	for _, j := range old.ACME.Jobs {
		oldACME[j.ID] = j.DNSCreds
	}
	for i := range next.ACME.Jobs {
		j := &next.ACME.Jobs[i]
		prev := oldACME[j.ID]
		for k, v := range j.DNSCreds {
			if isMasked(v) && prev != nil {
				j.DNSCreds[k] = prev[k]
			}
		}
	}
	oldMounts := map[string]string{}
	for _, m := range old.Storage.Mounts {
		oldMounts[m.ID] = m.Password
	}
	for i := range next.Storage.Mounts {
		m := &next.Storage.Mounts[i]
		if isMasked(m.Password) {
			m.Password = oldMounts[m.ID]
		}
	}
	oldHooks := map[string]model.Webhook{}
	for _, w := range old.Notify.Webhooks {
		oldHooks[w.ID] = w
	}
	for i := range next.Notify.Webhooks {
		wh := &next.Notify.Webhooks[i]
		if prev, ok := oldHooks[wh.ID]; ok {
			for k, v := range wh.Headers {
				if isMasked(v) {
					wh.Headers[k] = prev.Headers[k]
				}
			}
		}
	}
}

func isMasked(v string) bool {
	return v == "" || v == maskSentinel || strings.Contains(v, "********")
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

func (s *Server) registerNotify() {
	g := s.mux.Group("/api/v1/notify")
	g.Get("/webhooks", s.handleListWebhooks)
	g.Put("/webhooks", s.handleSaveWebhooks)
	g.Post("/webhooks/test", s.handleTestWebhook)
}

func (s *Server) handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	hooks := s.opts.Cfg.Snapshot().Notify.Webhooks
	for i := range hooks {
		for k, v := range hooks[i].Headers {
			hooks[i].Headers[k] = secret.Mask(v)
		}
	}
	rest.OK(w, hooks)
}

func (s *Server) handleSaveWebhooks(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req []model.Webhook
	if !jsonBody(w, r, &req) {
		return
	}
	old := s.opts.Cfg.Snapshot().Notify.Webhooks
	prev := map[string]model.Webhook{}
	for _, w := range old {
		prev[w.ID] = w
	}
	for i := range req {
		if req[i].ID == "" {
			req[i].ID = model.NewID()
		}
		for k, v := range req[i].Headers {
			if isMasked(v) {
				if p, ok := prev[req[i].ID]; ok {
					req[i].Headers[k] = p.Headers[k]
				}
			}
		}
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.Notify.Webhooks = req
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "无法保存通知配置：%s", err)
		return
	}
	s.audit(r, "notify.save", "count", len(req))
	rest.OK(w, s.opts.Cfg.Snapshot().Notify.Webhooks)
}

func (s *Server) handleTestWebhook(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req model.Webhook
	if !jsonBody(w, r, &req) {
		return
	}
	if req.URL == "" {
		rest.Fail(w, http.StatusBadRequest, "请填写 URL")
		return
	}
	if err := s.opts.Notify.SendTest(req); err != nil {
		rest.Fail(w, http.StatusBadGateway, "发送失败：%s", err)
		return
	}
	rest.OK(w, map[string]any{"status": "sent"})
}
