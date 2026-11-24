// Command nunt is a self hosted edge service: reverse proxy, redirects,
// static hosting, port forwarding, DDNS, ACME certificates, IP filtering and a
// Coraza based WAF behind one small web interface.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nunt/nunt/internal/app"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/healthprobe"
	"github.com/nunt/nunt/internal/version"
)

func main() {
	// The container health check is a subcommand so the image does not need a
	// shell, sed or wget to resolve the effective admin address.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck(os.Args[2:]))
	}

	var (
		configPath  = flag.String("c", "", "configuration file (default <dir>/config.json)")
		dataDir     = flag.String("d", "", "data directory (default the configuration directory)")
		configDir   = flag.String("cd", "", "configuration directory; config.json is created inside")
		logLevel    = flag.String("log-level", "", "log level: debug, info, warn, error")
		showVersion = flag.Bool("v", false, "print the version and exit")
	)
	flag.Usage = func() {
		out := flag.CommandLine.Output()
		fmt.Fprintf(out, "usage:\n  %s [flags]\n  %s healthcheck [-c file] [-d dir] [-cd dir] [-timeout duration]\n\nflags:\n", os.Args[0], os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *showVersion {
		info := version.Get()
		fmt.Printf("%s %s (commit %s, built %s, %s)\n",
			info.Name, info.Version, info.Commit, info.BuildTime, info.GoVersion)
		return
	}

	dir := *dataDir
	if *configDir != "" {
		dir = *configDir
	}
	if dir == "" {
		dir = "data"
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		fatal(err)
	}
	cfgPath := *configPath
	if cfgPath == "" {
		cfgPath = filepath.Join(absDir, "config.json")
	}
	absCfg, err := filepath.Abs(cfgPath)
	if err != nil {
		fatal(err)
	}
	if *dataDir == "" && *configDir == "" {
		absDir = filepath.Dir(absCfg)
	}

	application, err := app.New(app.Options{
		ConfigPath: absCfg,
		DataDir:    absDir,
		LogLevel:   *logLevel,
	})
	if err != nil {
		fatal(err)
	}

	log := application.Logger().Logger()
	log.Info("启动 nunt", "version", version.Get().Version, "config", absCfg, "data", absDir)
	if pw := application.InitialPassword(); pw != "" {
		fmt.Fprintf(os.Stdout, "\n"+
			"============================================================\n"+
			"  已生成新的配置文件\n"+
			"  管理员密码 : %s\n"+
			"  请立即登录并修改密码\n"+
			"============================================================\n\n", pw)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := application.Run(ctx); err != nil {
		log.Error("服务已停止", "error", err)
		os.Exit(1)
	}
	log.Info("再见")
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "nunt: %v\n", err)
	os.Exit(1)
}

// runHealthcheck probes the admin console and returns the process exit code:
// 0 healthy, 1 unhealthy, 2 bad arguments.
//
// It never creates or rewrites the configuration: a missing file simply means
// "probe the built-in default", which is what a fresh container looks like
// before the service has written its first configuration.
func runHealthcheck(args []string) int {
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	configPath := fs.String("c", "", "configuration file (default <dir>/config.json)")
	dataDir := fs.String("d", "", "data directory (default $DATA_DIR, then ./data)")
	configDir := fs.String("cd", "", "configuration directory; config.json is read inside")
	timeout := fs.Duration("timeout", healthprobe.DefaultTimeout, "probe timeout")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: %s healthcheck [-c file] [-d dir] [-cd dir] [-timeout duration]\n\nflags:\n", os.Args[0])
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dir := *dataDir
	if *configDir != "" {
		dir = *configDir
	}
	if dir == "" {
		// The image sets DATA_DIR; a bare binary keeps the usual ./data.
		if env := strings.TrimSpace(os.Getenv("DATA_DIR")); env != "" {
			dir = env
		} else {
			dir = "data"
		}
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nunt healthcheck: %v\n", err)
		return 1
	}

	path := *configPath
	if path == "" {
		path = filepath.Join(absDir, "config.json")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "nunt healthcheck: %v\n", err)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout+2*time.Second)
	defer cancel()
	info, targets, err := healthprobe.Run(ctx, healthprobe.Config{
		ConfigPath:    absPath,
		DefaultListen: config.DefaultAdminListen,
		Getenv:        os.Getenv,
		Timeout:       *timeout,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "nunt healthcheck: %v (config %s, probes %v)\n", err, absPath, targets)
		return 1
	}
	fmt.Printf("healthy: %s (%s)\n", info.Listen, info.Source)
	return 0
}
