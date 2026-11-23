package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
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

	g.Get("/ip2region", s.handleGetIP2Region)
	g.Get("/ip2region/provinces", s.handleIP2RegionProvinces)
	g.Put("/ip2region", s.handleUpdateIP2Region)
	g.Post("/ip2region/reload", s.handleReloadIP2Region)
	g.Post("/ip2region/lookup", s.handleIP2RegionLookup)
}

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	cfg := s.opts.Cfg.Snapshot()
	stats := sysinfo.Collect(s.opts.DataDir)
	listen := s.currentAdminListen(r.Context(), cfg.System.AdminListen)
	rest.OK(w, map[string]any{
		"version":   version.Get(),
		"startedAt": stats.StartTime,
		"dataDir":   s.opts.DataDir,
		"webRules":  len(cfg.Web.Rules),
		"modules":   s.opts.Registry.Statuses(),
		// Certificates that are present on disk plus the ones that could not
		// be loaded at startup (they are skipped, never fatal).
		"certs": s.certInfo(),
		// The listen address really in use, the value stored in config.json and
		// where the effective value came from ("env" or "config"). The env
		// variable name is included so the UI can point at the right override.
		"adminListen":       listen.Listen,
		"adminListenConfig": cfg.System.AdminListen,
		"adminListenSource": string(listen.Source),
		"adminListenEnv":    listen.EnvVar,
		// Effective admin IP allow list (empty = unrestricted) and how many
		// requests it rejected since start up.
		"adminAllowList": s.adminAllowListInfo(),
	})
}

// certInfo summarises the certificate store for the system page.
func (s *Server) certInfo() map[string]any {
	out := map[string]any{"count": 0, "loadErrors": 0}
	if s.opts.Certs == nil {
		return out
	}
	out["count"] = len(s.opts.Certs.List())
	out["loadErrors"] = s.opts.Certs.LoadErrors()
	return out
}

// currentAdminListen reports the address that is really in use. The listener
// manager is authoritative because a settings save can move it at runtime; the
// request context is the fallback for embedders that wrap the handler with
// adminlisten.WithInfo, and the configuration file is the last resort (the API
// is also usable without a running listener in unit tests).
func (s *Server) currentAdminListen(ctx context.Context, configured string) adminlisten.Info {
	if srv := s.AdminListener(); srv != nil {
		info := srv.Info()
		// The configuration may have changed since the listener was bound;
		// always report the value currently stored in the file separately.
		info.ConfigListen = configured
		return info
	}
	if info, ok := adminlisten.FromContext(ctx); ok && info.Listen != "" {
		info.ConfigListen = configured
		return info
	}
	effective := configured
	if normalized, err := netutil.NormalizeListen(configured); err == nil {
		effective = normalized
	}
	return adminlisten.Info{
		Listen:       effective,
		ConfigListen: configured,
		Source:       adminlisten.SourceConfig,
	}
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
	wanted, err := normalizeAdminListen(req.AdminListen)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "管理后台监听地址不合法：%s", err)
		return
	}
	req.AdminListen = wanted
	if _, err := netutil.ParseIPList(req.AdminAllowIPs); err != nil {
		rest.Fail(w, http.StatusBadRequest, "管理后台 IP 白名单不合法：%s", err)
		return
	}
	// The address database has its own endpoint (PUT /system/ip2region) and is
	// no longer edited by the system form. The update below replaces the whole
	// SystemConfig, so an omitted field would silently wipe the database path.
	req.IP2RegionDB = s.opts.Cfg.Snapshot().System.IP2RegionDB

	// The listener moves first and the file is written only after the new
	// address is bound: when the port is occupied, the process lacks the
	// privilege, the value is invalid or the address is controlled by the
	// environment, nothing is persisted and the old listener keeps running.
	previous := s.opts.Cfg.Snapshot().System.AdminListen
	moved := !sameAdminListen(wanted, previous)
	if moved {
		if err := s.rebindAdminListen(wanted); err != nil {
			status, message := adminListenFailure(err)
			rest.Fail(w, status, "%s", message)
			return
		}
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.System = req
		return nil
	}); err != nil {
		if moved {
			// A configuration write failure would leave the runtime on the new
			// address while the file still has the old one; put the listener
			// back so both agree. The only way this fails is somebody else
			// taking the old port in the meantime.
			if rollbackErr := s.rebindAdminListen(previous); rollbackErr != nil {
				s.log.Error("admin listener rollback failed", "addr", previous, "error", rollbackErr)
			}
		}
		rest.Fail(w, http.StatusInternalServerError, "无法保存设置：%s", err)
		return
	}
	s.opts.Log.SetLevel(req.LogLevel)
	s.audit(r, "system.settings", "adminListen", wanted, "moved", moved)
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	rest.OK(w, s.systemSettingsResponse())
}

// rebindAdminListen moves the listener when the application attached one. The
// API stays usable without a listener (unit tests and embedders), in which case
// only the configuration file changes.
func (s *Server) rebindAdminListen(addr string) error {
	if srv := s.AdminListener(); srv != nil {
		return srv.Rebind(addr)
	}
	return nil
}

// normalizeAdminListen validates a listen address. An empty value means "use the
// default", exactly like config.Normalize does for the file.
func normalizeAdminListen(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		raw = config.DefaultAdminListen
	}
	return netutil.NormalizeListen(raw)
}

// sameAdminListen reports whether the requested address already is the
// configured one. An unparsable stored value counts as different so that the
// next save repairs it.
func sameAdminListen(wanted, configured string) bool {
	previous, err := netutil.NormalizeListen(configured)
	if err != nil {
		return false
	}
	return netutil.SameListen(wanted, previous)
}

// adminListenFailure maps a rebind error to an HTTP status. Everything the
// caller can fix is a 4xx that repeats the original message (the settings page
// shows it verbatim); only an unexpected failure becomes a 500.
func adminListenFailure(err error) (int, string) {
	var rebindErr *adminlisten.RebindError
	if errors.As(err, &rebindErr) {
		switch rebindErr.Kind {
		case adminlisten.KindEnv, adminlisten.KindInUse:
			return http.StatusConflict, rebindErr.Error()
		case adminlisten.KindPermission:
			return http.StatusForbidden, rebindErr.Error()
		case adminlisten.KindInvalid, adminlisten.KindBind:
			return http.StatusBadRequest, rebindErr.Error()
		}
		return http.StatusBadRequest, err.Error()
	}
	return http.StatusInternalServerError, err.Error()
}

// systemSettingsResponse is the stored settings plus the listen address state.
// The embedded adminListen field carries the address that is really in use, so
// the page can tell the operator where the console ended up; the stored value,
// the source and whether they agree are reported separately.
type systemSettingsResponse struct {
	model.SystemConfig
	AdminListenConfig  string `json:"adminListenConfig"`
	AdminListenSource  string `json:"adminListenSource"`
	AdminListenEnv     string `json:"adminListenEnv"`
	AdminListenApplied bool   `json:"adminListenApplied"`
	AdminListenNotice  string `json:"adminListenNotice,omitempty"`
}

func (s *Server) systemSettingsResponse() systemSettingsResponse {
	cfg := s.opts.Cfg.Snapshot()
	info := s.currentAdminListen(context.Background(), cfg.System.AdminListen)
	out := systemSettingsResponse{
		SystemConfig:       cfg.System,
		AdminListenConfig:  cfg.System.AdminListen,
		AdminListenSource:  string(info.Source),
		AdminListenEnv:     info.EnvVar,
		AdminListenApplied: netutil.SameListen(info.Listen, cfg.System.AdminListen),
	}
	out.AdminListen = info.Listen
	if info.Source == adminlisten.SourceEnv {
		env := info.EnvVar
		if env == "" {
			env = adminlisten.EnvListen
		}
		out.AdminListenNotice = fmt.Sprintf(
			"当前监听地址由环境变量 %s 控制（实际生效 %s）：修改配置不会改变运行中的端口，需移除该环境变量并重启服务后才生效。",
			env, info.Listen)
	}
	return out
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
	// An imported configuration may move the admin console too; validate the
	// address and bind the new socket before the file is replaced.
	wanted, err := normalizeAdminListen(req.Config.System.AdminListen)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "导入配置里的管理后台监听地址不合法：%s", err)
		return
	}
	req.Config.System.AdminListen = wanted
	previous := old.System.AdminListen
	moved := !sameAdminListen(wanted, previous)
	if moved {
		if err := s.rebindAdminListen(wanted); err != nil {
			status, message := adminListenFailure(err)
			rest.Fail(w, status, "%s", message)
			return
		}
	}
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
		c.WAF = req.Config.WAF
		return nil
	}); err != nil {
		if moved {
			if rollbackErr := s.rebindAdminListen(previous); rollbackErr != nil {
				s.log.Error("admin listener rollback failed", "addr", previous, "error", rollbackErr)
			}
		}
		rest.Fail(w, http.StatusBadRequest, "无法导入配置：%s", err)
		return
	}
	s.audit(r, "system.config.import", "adminListen", wanted, "moved", moved)
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	cfg := s.opts.Cfg.Snapshot()
	info := s.currentAdminListen(context.Background(), cfg.System.AdminListen)
	rest.OK(w, map[string]any{
		"status":             "imported",
		"adminListen":        info.Listen,
		"adminListenConfig":  cfg.System.AdminListen,
		"adminListenSource":  string(info.Source),
		"adminListenEnv":     info.EnvVar,
		"adminListenApplied": netutil.SameListen(info.Listen, cfg.System.AdminListen),
	})
}

func maskConfigSecrets(cfg *model.Config) {
	for i := range cfg.Users {
		cfg.Users[i].PasswordHash = ""
		// The TOTP seed is as sensitive as a password: an export must never
		// contain a usable one. Recovery codes are one time credentials too.
		if cfg.Users[i].TOTP.Secret != "" {
			cfg.Users[i].TOTP.Secret = maskSentinel
		}
		cfg.Users[i].TOTP.Codes = nil
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

	// TOTP seeds are masked in exports, so an import that carries the mask (or
	// nothing) for a known user keeps the stored seed instead of wiping the
	// factor. The enabled flag always comes from the imported document.
	oldTOTP := map[string]model.TOTP{}
	for _, u := range old.Users {
		oldTOTP[u.ID] = u.TOTP
	}
	for i := range next.Users {
		u := &next.Users[i]
		prev, ok := oldTOTP[u.ID]
		if !ok || prev.Secret == "" {
			continue
		}
		if u.TOTP.Secret == "" || isMasked(u.TOTP.Secret) {
			u.TOTP.Secret = prev.Secret
			u.TOTP.Codes = prev.Codes
			u.TOTP.LastStep = prev.LastStep
			if u.TOTP.EnrolledAt == nil {
				u.TOTP.EnrolledAt = prev.EnrolledAt
			}
		}
	}
}

func isMasked(v string) bool {
	return v == "" || v == maskSentinel || strings.Contains(v, "********")
}

// ---------------------------------------------------------------------------
// ip2region
// ---------------------------------------------------------------------------

// ip2regionStatus is the JSON view shared by the endpoints.
type ip2regionStatus struct {
	Status ip2region.Status `json:"status"`
	// Provinces lists the provinces that the picker may offer. Source is
	// "database" when they were enumerated from the loaded xdb and "builtin"
	// when the built-in list is used as a fallback.
	Provinces []string `json:"provinces"`
	Source    string   `json:"source"`
}

func (s *Server) ip2regionStatus() ip2regionStatus {
	out := ip2regionStatus{Provinces: ip2region.Provinces(), Source: "builtin"}
	if s.opts.Geo != nil {
		out.Status = s.opts.Geo.Status()
		if provinces, ok := s.opts.Geo.ProvincesFromDatabase(); ok && len(provinces) > 0 {
			out.Provinces = provinces
			out.Source = "database"
		}
	}
	return out
}

func (s *Server) handleGetIP2Region(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, s.ip2regionStatus())
}

// handleIP2RegionProvinces serves the province picker: the values come from
// the loaded database when possible and from the built-in fallback otherwise.
func (s *Server) handleIP2RegionProvinces(w http.ResponseWriter, r *http.Request) {
	status := s.ip2regionStatus()
	rest.OK(w, map[string]any{"provinces": status.Provinces, "source": status.Source})
}

// handleUpdateIP2Region validates the new database before saving it, so a
// broken path never ends up in the configuration.
func (s *Server) handleUpdateIP2Region(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	path := strings.TrimSpace(req.Path)
	if path != "" {
		if s.opts.Geo == nil {
			rest.Fail(w, http.StatusInternalServerError, "IP 地址库服务不可用")
			return
		}
		if _, err := s.opts.Geo.Probe(path); err != nil {
			rest.Fail(w, http.StatusBadRequest, "无法加载该地址库：%s", err)
			return
		}
	}
	if err := s.opts.Cfg.Update(func(c *model.Config) error {
		c.System.IP2RegionDB = path
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "无法保存地址库路径：%s", err)
		return
	}
	s.audit(r, "system.ip2region", "path", path)
	if s.opts.Reload != nil {
		s.opts.Reload()
	}
	rest.OK(w, s.ip2regionStatus())
}

func (s *Server) handleReloadIP2Region(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if s.opts.Geo == nil {
		rest.Fail(w, http.StatusInternalServerError, "IP 地址库服务不可用")
		return
	}
	if err := s.opts.Geo.Reload(); err != nil {
		rest.Fail(w, http.StatusBadRequest, "重新加载失败：%s", err)
		return
	}
	s.audit(r, "system.ip2region.reload")
	rest.OK(w, s.ip2regionStatus())
}

// handleIP2RegionLookup answers "which country/province does this address
// belong to", which the UI uses to verify a filter value.
func (s *Server) handleIP2RegionLookup(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var req struct {
		IP string `json:"ip"`
	}
	if !jsonBody(w, r, &req) {
		return
	}
	ip := net.ParseIP(strings.TrimSpace(req.IP))
	if ip == nil {
		rest.Fail(w, http.StatusBadRequest, "IP 地址不合法")
		return
	}
	if s.opts.Geo == nil {
		rest.Fail(w, http.StatusInternalServerError, "IP 地址库服务不可用")
		return
	}
	record, err := s.opts.Geo.Lookup(ip)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "查询失败：%s", err)
		return
	}
	rest.OK(w, map[string]any{
		"ip":                 ip.String(),
		"country":            record.Country,
		"region":             record.Region,
		"province":           record.Province,
		"provinceNormalized": ip2region.NormalizeProvince(record.Province),
		"city":               record.City,
		"isp":                record.ISP,
		"raw":                record.Raw,
	})
}
