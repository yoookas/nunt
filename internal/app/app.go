// Package app wires the configuration, the modules and the admin API into a
// single runnable service.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	"path/filepath"
	"time"

	"github.com/nunt/nunt/internal/api"
	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/mounts"
	"github.com/nunt/nunt/internal/notify"
	"github.com/nunt/nunt/internal/secret"
	"github.com/nunt/nunt/internal/security"
	"github.com/nunt/nunt/internal/store"

	"github.com/nunt/nunt/internal/modules/acme"
	"github.com/nunt/nunt/internal/modules/ddns"
	"github.com/nunt/nunt/internal/modules/forward"
	"github.com/nunt/nunt/internal/modules/task"
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
	opts     Options
	cfg      *config.Store
	log      *logging.Hub
	box      *secret.Box
	certs    *certs.Store
	mounts   *mounts.Manager
	notify   *notify.Service
	registry *module.Registry
	sessions *security.SessionStore
	api      *api.Server
	server   *http.Server

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
	level := opts.LogLevel
	if level == "" {
		level = cfg.Snapshot().System.LogLevel
	}
	hub := logging.New(level, filepath.Join(opts.DataDir, "logs", "nunt.log"))
	logger := hub.Logger()

	a := &App{
		opts:            opts,
		cfg:             cfg,
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
	a.mounts = mounts.New(cfg, box, logger.With("component", "mounts"))
	a.notify = notify.New(cfg, logger.With("component", "notify"))
	a.sessions = security.NewSessionStore()

	a.registry = module.NewRegistry()
	deps := &module.Deps{
		Cfg:      cfg,
		Log:      hub,
		Certs:    certStore,
		Mounts:   a.mounts,
		Notify:   a.notify,
		Box:      box,
		DataDir:  opts.DataDir,
		Registry: a.registry,
	}

	// Registration order defines the start order: the WAF must exist before
	// the web service starts routing traffic.
	a.registry.MustRegister(waf.New(deps))
	a.registry.MustRegister(acme.New(deps))
	a.registry.MustRegister(web.New(deps))
	a.registry.MustRegister(forward.New(deps))
	a.registry.MustRegister(ddns.New(deps))
	a.registry.MustRegister(task.New(deps))

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
		Notify:   a.notify,
		Box:      box,
		Sessions: a.sessions,
		DataDir:  opts.DataDir,
		Reload:   a.Reload,
		AdminWAF: adminWAF,
	})
	a.api.BroadcastLogs()

	a.server = &http.Server{
		Addr:              cfg.Snapshot().System.AdminListen,
		Handler:           a.api.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       0, // uploads and SSE streams may be long lived
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(hub.Logger().Handler(), slog.LevelWarn),
	}

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

// Reload pushes the current configuration to every module.
func (a *App) Reload() {
	a.registry.Reload(a.cfg.Snapshot())
}

// Run starts every module and the admin server, then blocks until ctx is
// cancelled or the server fails.
func (a *App) Run(ctx context.Context) error {
	log := a.log.Logger()
	for _, err := range a.registry.StartAll(ctx) {
		log.Error("module failed to start", "error", err)
	}

	ln, err := net.Listen("tcp", a.server.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", a.server.Addr, err)
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("admin interface listening", "addr", ln.Addr().String())
		if err := a.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown requested")
	case err := <-errCh:
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
	if err := a.server.Shutdown(ctx); err != nil {
		a.log.Logger().Warn("admin server shutdown", "error", err)
	}
	a.registry.StopAll(ctx)
	a.notify.Close()
	a.sessions.Close()
	a.log.Close()
}
