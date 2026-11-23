// Package healthprobe implements the container health check.
//
// It resolves the admin listen address with exactly the same precedence as the
// service (NUNT_ADMIN_LISTEN > NUNT_ADMIN_PORT > system.adminListen in the
// configuration file > the built-in default) without creating or modifying any
// file, and then calls /healthz on the loopback address. Doing this in Go
// instead of shell keeps the probe correct when the configuration is written
// minified, when the console binds a wildcard or an IPv6 address, and when the
// image happens not to ship wget/sed.
package healthprobe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/adminlisten"
)

// DefaultTimeout bounds one health probe.
const DefaultTimeout = 3 * time.Second

// Config configures Run.
type Config struct {
	// ConfigPath is the configuration file (config.json). A missing file is
	// not an error: the default address is probed instead.
	ConfigPath string
	// DefaultListen is used when the file is missing or carries no value.
	DefaultListen string
	// Getenv resolves environment variables (os.Getenv in production).
	Getenv func(string) string
	// Timeout bounds one probe; defaults to DefaultTimeout.
	Timeout time.Duration
	// Client overrides the HTTP client (tests).
	Client *http.Client
}

// Run resolves the address, probes it and reports what it did.
func Run(ctx context.Context, cfg Config) (adminlisten.Info, []string, error) {
	configured, err := ReadAdminListen(cfg.ConfigPath)
	if err != nil {
		return adminlisten.Info{}, nil, err
	}
	if strings.TrimSpace(configured) == "" {
		configured = cfg.DefaultListen
	}
	info, err := adminlisten.Resolve(configured, cfg.Getenv)
	if err != nil {
		return adminlisten.Info{}, nil, err
	}

	targets := ProbeAddrs(info.Listen)
	client := cfg.Client
	if client == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = DefaultTimeout
		}
		client = &http.Client{
			Timeout: timeout,
			// The probe must never leave the machine, even when the
			// environment exports HTTP_PROXY for the service.
			Transport: &http.Transport{Proxy: nil},
		}
	}

	var lastErr error
	for _, target := range targets {
		if err := probe(ctx, client, target); err != nil {
			lastErr = err
			continue
		}
		return info, targets, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no probe address")
	}
	return info, targets, lastErr
}

// ReadAdminListen reads system.adminListen without touching the file system.
// A missing file yields an empty value.
func ReadAdminListen(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	var file struct {
		System struct {
			AdminListen string `json:"adminListen"`
		} `json:"system"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return "", fmt.Errorf("parse %s: %w", path, err)
	}
	return strings.TrimSpace(file.System.AdminListen), nil
}

// ProbeAddrs turns a listen address into the addresses to try. A wildcard
// binding is probed on the loopback addresses; a specific address is probed as
// configured. IPv6 loopback is tried first for a "::" wildcard and IPv4 is the
// fallback, which covers hosts with IPv6 disabled.
func ProbeAddrs(listen string) []string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return []string{listen}
	}
	switch host {
	case "", "0.0.0.0":
		return []string{net.JoinHostPort("127.0.0.1", port)}
	case "::", "[::]", "::0":
		return []string{net.JoinHostPort("::1", port), net.JoinHostPort("127.0.0.1", port)}
	default:
		return []string{net.JoinHostPort(host, port)}
	}
}

func probe(ctx context.Context, client *http.Client, target string) error {
	url := "http://" + target + "/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("build request for %s: %w", url, err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	// Drain a little so the connection can be reused; the body is a small JSON
	// document and its contents do not matter.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: unexpected status %d", url, resp.StatusCode)
	}
	return nil
}
