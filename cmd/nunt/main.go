// Command nunt is a self hosted edge service: reverse proxy, redirects,
// static hosting, port forwarding, DDNS, ACME certificates, WebDAV, a file
// browser and a Coraza based WAF behind one small web interface.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/nunt/nunt/internal/app"
	"github.com/nunt/nunt/internal/version"
)

func main() {
	var (
		configPath  = flag.String("c", "", "configuration file (default <dir>/config.json)")
		dataDir     = flag.String("d", "", "data directory (default the configuration directory)")
		configDir   = flag.String("cd", "", "configuration directory; config.json is created inside")
		logLevel    = flag.String("log-level", "", "log level: debug, info, warn, error")
		showVersion = flag.Bool("v", false, "print the version and exit")
	)
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
	log.Info("starting nunt", "version", version.Get().Version, "config", absCfg, "data", absDir)
	if pw := application.InitialPassword(); pw != "" {
		fmt.Fprintf(os.Stdout, "\n"+
			"============================================================\n"+
			"  A new configuration was created.\n"+
			"  Administrator user : admin\n"+
			"  Administrator pass : %s\n"+
			"  Sign in and change it immediately.\n"+
			"============================================================\n\n", pw)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := application.Run(ctx); err != nil {
		log.Error("service stopped", "error", err)
		os.Exit(1)
	}
	log.Info("bye")
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "nunt: %v\n", err)
	os.Exit(1)
}
