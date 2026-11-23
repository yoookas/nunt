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
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/mounts"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"

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
	mounts      *mounts.Manager
	geo         *ip2region.Service
	registry    *module.Registry
	sessions    *security.SessionStore
	api         *api.Server
	admin       *adminlisten.Server

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
	hub := logging.New(level, filepath.Join(opts.DataDir, "logs", "nunt.log"))
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
	a.mounts = mounts.New(cfg)
	a.sessions = security.NewSessionStore()
	a.geo = ip2region.New()
	if err := a.geo.Configure(cfg.Snapshot().System.IP2RegionDB); err != nil {
		logger.Warn("ip2region: cannot load the database", "error", err)
	}

	a.registry = module.NewRegistry()
	deps := &module.Deps{
		Cfg:      cfg,
		Log:      hub,
		Certs:    certStore,
		Mounts:   a.mounts,
		Box:      box,
		DataDir:  opts.DataDir,
		Registry: a.registry,
		Geo:      a.geo,
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
		Mounts:   a.mounts,
		Box:      box,
		Sessions: a.sessions,
		DataDir:  opts.DataDir,
		Geo:      a.geo,
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

// Registry returns the module registry.
func (a *App) Registry() *module.Registry { return a.registry }

// Reload pushes the current configuration to every module. The geo database is
// configured first so newly compiled rules see it.
func (a *App) Reload() {
	if a.geo != nil {
		if err := a.geo.Configure(a.cfg.Snapshot().System.IP2RegionDB); err != nil {
			a.log.Logger().Warn("ip2region: cannot reload the database", "error", err)
		}
	}
	a.registry.Reload(a.cfg.Snapshot())
}

// Run starts every module and the admin server, then blocks until ctx is
// cancelled or the server fails.
func (a *App) Run(ctx context.Context) error {
	log := a.log.Logger()
	if a.adminListen.Source == adminlisten.SourceEnv {
		log.Info("admin listen address comes from the environment, not config.json",
			"addr", a.adminListen.Listen,
			"env", a.adminListen.EnvVar,
			"config", a.adminListen.ConfigListen)
	} else {
		log.Info("admin listen address comes from the configuration file",
			"addr", a.adminListen.Listen,
			"config", a.adminListen.ConfigListen)
	}
	for _, err := range a.registry.StartAll(ctx) {
		log.Error("module failed to start", "error", err)
	}

	if err := a.admin.Serve(a.adminListen.Listen); err != nil {
		return fmt.Errorf("listen on %s: %w", a.adminListen.Listen, err)
	}

	select {
	case <-ctx.Done():
		log.Info("shutdown requested")
	case err := <-a.admin.Errors():
		// Log before Shutdown: Shutdown closes the log hub, so an error reported
		// after it would be swallowed.
		log.Error("admin server stopped with an error", "error", err)
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
			a.log.Logger().Warn("admin server shutdown", "error", err)
		}
	}
	a.registry.StopAll(ctx)
	a.sessions.Close()
	a.log.Close()
}
