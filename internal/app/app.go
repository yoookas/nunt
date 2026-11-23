// Package app wires the configuration, the modules and the admin API into a
// single runnable service.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/backup"
	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"
	"github.com/nunt/nunt/internal/version"

	"github.com/nunt/nunt/internal/modules/acme"
	"github.com/nunt/nunt/internal/modules/ddns"
	"github.com/nunt/nunt/internal/modules/forward"
	"github.com/nunt/nunt/internal/modules/waf"
	"github.com/nunt/nunt/internal/modules/web"
)

// Options configures the application.
type Options struct {
	ConfigPath string
	DataDir    string
	LogLevel   string
}

// App is the running service.
type App struct {
	opts        Options
	cfg         *config.Store
	adminListen adminlisten.Info
	log         *logging.Hub
	box         *secret.Box
	certs       *certs.Store
	geo         *ip2region.Service
	registry    *module.Registry
	sessions    *security.SessionStore
	api         *api.Server
	admin       *adminlisten.Server
	logStore    *logstore.Store
	bg          sync.WaitGroup
	bgCancel    context.CancelFunc

	initialPassword string
}

// New builds the application from the on disk configuration.
func New(opts Options) (*App, error) {
	if opts.ConfigPath == "" {
		return nil, errors.New("a configuration file path is required")
	}
	if opts.DataDir == "" {
		opts.DataDir = filepath.Dir(opts.ConfigPath)
	}
	if err := store.EnsureDir(opts.DataDir, 0o750); err != nil {
		return nil, err
	}

	cfg, initialPassword, err := config.Load(opts.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("load configuration: %w", err)
	}
	// Environment overrides win over system.adminListen. Resolve validates the
	// effective value here so an invalid override aborts startup instead of
	// silently listening on the configured address.
	adminListen, err := adminlisten.Resolve(cfg.Snapshot().System.AdminListen, os.Getenv)
	if err != nil {
		return nil, fmt.Errorf("resolve the admin listen address: %w", err)
	}
	level := opts.LogLevel
	if level == "" {
		level = cfg.Snapshot().System.LogLevel
	}
	appLog := cfg.Snapshot().Logs.App
	hub := logging.NewWithOptions(level, filepath.Join(opts.DataDir, "logs", "nunt.log"), logging.Options{
		MaxFileMB: appLog.MaxFileMB,
		KeepFiles: appLog.KeepFiles,
	})
	logger := hub.Logger()

	a := &App{
		opts:            opts,
		cfg:             cfg,
		adminListen:     adminListen,
		log:             hub,
		initialPassword: initialPassword,
	}

	box, err := secret.Open(filepath.Join(filepath.Dir(opts.ConfigPath), "secret.key"))
	if err != nil {
		return nil, err
	}
	a.box = box

	certStore, err := certs.Open(filepath.Join(opts.DataDir, "certs"))
	if err != nil {
		return nil, err
	}
	a.certs = certStore
	a.sessions = security.NewSessionStore()
	a.geo = ip2region.New()
	if err := a.geo.Configure(cfg.Snapshot().System.IP2RegionDB); err != nil {
		logger.Warn("ip2region：无法加载地址库", "error", err)
	}

	// The persistent access log lives next to the process log. Opening it
	// before the modules start means their very first request is recorded.
	accessLog := cfg.Snapshot().Logs.Access
	logStore, err := logstore.Open(filepath.Join(opts.DataDir, "logs", "access"), logstore.Options{
		Persist:   accessLog.Persist,
		KeepDays:  accessLog.KeepDays,
		MaxFileMB: accessLog.MaxFileMB,
	})
	if err != nil {
		hub.Close()
		return nil, err
	}
	a.logStore = logStore

	a.registry = module.NewRegistry()
	deps := &module.Deps{
		Cfg:      cfg,
		Log:      hub,
		Certs:    certStore,
		Box:      box,
		DataDir:  opts.DataDir,
		Registry: a.registry,
		Geo:      a.geo,
		Logs:     logStore,
	}

	// Registration order defines the start order: the WAF must exist before
	// the web service starts routing traffic.
	a.registry.MustRegister(waf.New(deps))
	a.registry.MustRegister(acme.New(deps))
	a.registry.MustRegister(web.New(deps))
	a.registry.MustRegister(forward.New(deps))
	a.registry.MustRegister(ddns.New(deps))

	adminWAF := func(next http.Handler) http.Handler {
		mod, ok := a.registry.Get("waf")
		if !ok {
			return next
		}
		engine, ok := mod.(*waf.WAF)
		if !ok || !engine.AdminProtect() {
			return next
		}
		return engine.Middleware("admin-api", next)
	}

	a.api = api.New(api.Options{
		Cfg:      cfg,
		Log:      hub,
		Registry: a.registry,
		Certs:    certStore,
		Box:      box,
		Sessions: a.sessions,
		DataDir:  opts.DataDir,
		Geo:      a.geo,
		Logs:     logStore,
		Reload:   a.Reload,
		AdminWAF: adminWAF,
	})
	a.api.BroadcastLogs()

	// The admin listener is a manager rather than a plain http.Server: the
	// settings page can move it to another address at runtime (see
	// adminlisten.Server.Rebind). The API reads the address actually in use
	// from the manager, so GET /api/v1/system/info follows a rebind.
	a.admin = adminlisten.NewServer(a.api.Handler(), logger.With("component", "admin"), adminListen)
	a.api.SetAdminListener(a.admin)

	cfg.Subscribe(func(c *model.Config) {
		hub.SetLevel(c.System.LogLevel)
		hub.SetLimits(logging.Options{MaxFileMB: c.Logs.App.MaxFileMB, KeepFiles: c.Logs.App.KeepFiles})
		if a.logStore != nil {
			a.logStore.Configure(logstore.Options{
				Persist:   c.Logs.Access.Persist,
				KeepDays:  c.Logs.Access.KeepDays,
				MaxFileMB: c.Logs.Access.MaxFileMB,
			})
		}
		a.api.BroadcastLogs()
	})
	return a, nil
}

// InitialPassword returns the generated administrator password when the
// configuration was created by this process.
func (a *App) InitialPassword() string { return a.initialPassword }

// Config returns the configuration store.
func (a *App) Config() *config.Store { return a.cfg }

// Logger returns the log hub.
func (a *App) Logger() *logging.Hub { return a.log }

// LogStore returns the persistent access log store.
func (a *App) LogStore() *logstore.Store { return a.logStore }

// Registry returns the module registry.
func (a *App) Registry() *module.Registry { return a.registry }

// Reload pushes the current configuration to every module. The geo database is
// configured first so newly compiled rules see it.
func (a *App) Reload() {
	if a.geo != nil {
		if err := a.geo.Configure(a.cfg.Snapshot().System.IP2RegionDB); err != nil {
			a.log.Logger().Warn("ip2region：无法重新加载地址库", "error", err)
		}
	}
	a.registry.Reload(a.cfg.Snapshot())
}

// Run starts every module and the admin server, then blocks until ctx is
// cancelled or the server fails.
func (a *App) Run(ctx context.Context) error {
	log := a.log.Logger()
	if a.adminListen.Source == adminlisten.SourceEnv {
		log.Info("管理端监听地址来自环境变量（优先于 config.json）",
			"addr", a.adminListen.Listen,
			"env", a.adminListen.EnvVar,
			"config", a.adminListen.ConfigListen)
	} else {
		log.Info("管理端监听地址来自配置文件",
			"addr", a.adminListen.Listen,
			"config", a.adminListen.ConfigListen)
	}
	logAccess := a.cfg.Snapshot().Logs.Access
	log.Info("访问日志已就绪",
		"dir", filepath.Join(a.opts.DataDir, "logs", "access"),
		"persist", logAccess.Persist,
		"keepDays", logAccess.KeepDays,
		"maxFileMB", logAccess.MaxFileMB)
	info := version.Get()
	log.Info("nunt 已启动",
		"version", info.Version,
		"commit", info.Commit,
		"go", info.GoVersion,
		"data", a.opts.DataDir,
		"config", a.opts.ConfigPath)
	// Start the modules here instead of through Registry.StartAll so every
	// module reports when it came up and how long it took. The order is the
	// same (registry order), and a failure does not stop the rest.
	for _, mod := range a.registry.All() {
		started := time.Now()
		if err := mod.Start(ctx); err != nil {
			log.Error("模块启动失败", "module", mod.Name(), "title", mod.Title(), "error", err)
			continue
		}
		log.Info("模块已启动",
			"module", mod.Name(),
			"title", mod.Title(),
			"duration", time.Since(started).Round(time.Microsecond).String())
	}
	a.startBackups(ctx)

	if err := a.admin.Serve(a.adminListen.Listen); err != nil {
		return fmt.Errorf("listen on %s: %w", a.adminListen.Listen, err)
	}

	select {
	case <-ctx.Done():
		log.Info("收到停止信号，开始关闭")
	case err := <-a.admin.Errors():
		// Log before Shutdown: Shutdown closes the log hub, so an error reported
		// after it would be swallowed.
		log.Error("管理端服务异常退出", "error", err)
		a.Shutdown()
		return err
	}
	a.Shutdown()
	return nil
}

// Shutdown stops the HTTP server and every module.
func (a *App) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if a.admin != nil {
		if err := a.admin.Close(); err != nil {
			a.log.Logger().Warn("管理端服务已关闭", "error", err)
		}
	}
	if a.bgCancel != nil {
		a.bgCancel()
	}
	a.bg.Wait()
	stopped := time.Now()
	a.registry.StopAll(ctx)
	a.log.Logger().Info("模块已全部停止", "duration", time.Since(stopped).Round(time.Millisecond).String())
	if a.logStore != nil {
		if err := a.logStore.Close(); err != nil {
			a.log.Logger().Warn("访问日志写入已停止", "error", err)
		}
	}
	a.sessions.Close()
	a.log.Close()
}

// startBackups runs the periodic data directory archive. It checks every few
// minutes and only writes when the configured interval has elapsed, so a
// restart does not create a burst of archives.
func (a *App) startBackups(ctx context.Context) {
	loopCtx, cancel := context.WithCancel(ctx)
	a.bgCancel = cancel
	a.bg.Add(1)
	go func() {
		defer a.bg.Done()
		timer := time.NewTimer(45 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-timer.C:
				a.runBackup()
				timer.Reset(10 * time.Minute)
			}
		}
	}()
}

func (a *App) runBackup() {
	cfg := a.cfg.Snapshot()
	if !cfg.Backup.Enabled {
		return
	}
	dest := backup.Dir(a.opts.DataDir, cfg.Backup.Dir)
	interval := time.Duration(cfg.Backup.IntervalHours) * time.Hour
	if newest := backup.Newest(dest); !newest.IsZero() && time.Since(newest) < interval {
		return
	}
	path, err := backup.Create(a.opts.DataDir, dest, cfg.Backup.Keep, time.Now())
	if err != nil {
		a.log.Logger().Warn("备份：无法写入归档", "dir", dest, "error", err)
		return
	}
	size := int64(0)
	if info, statErr := os.Stat(path); statErr == nil {
		size = info.Size()
	}
	a.log.Logger().Info("备份：归档已写入", "file", path, "bytes", size, "keep", cfg.Backup.Keep)
}
