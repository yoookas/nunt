// Package adminlisten resolves the listen address of the admin console.
//
// The address normally comes from system.adminListen in config.json, but a
// deployment can override it at runtime with NUNT_ADMIN_LISTEN (a full listen
// address) or NUNT_ADMIN_PORT (a port only). Environment overrides are never
// written back to the configuration file: restarting a container with another
// port must not modify the data volume.
//
// The package also carries the resolved value to the HTTP layer through the
// request context, so GET /api/v1/system/info can report which address is
// really in use and where it came from.
package adminlisten

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/nunt/nunt/internal/netutil"
)

// Environment variables understood by Resolve.
const (
	EnvListen = "NUNT_ADMIN_LISTEN"
	EnvPort   = "NUNT_ADMIN_PORT"
)

// Source describes where the effective listen address comes from.
type Source string

// Possible sources.
const (
	// SourceConfig means system.adminListen from the configuration file.
	SourceConfig Source = "config"
	// SourceEnv means NUNT_ADMIN_LISTEN or NUNT_ADMIN_PORT.
	SourceEnv Source = "env"
)

// Info is the result of resolving the admin listen address.
type Info struct {
	// Listen is the effective, normalized listen address used by net.Listen.
	Listen string
	// ConfigListen is the raw system.adminListen value read from config.json.
	ConfigListen string
	// Source tells whether Listen came from the environment or the file.
	Source Source
	// EnvVar names the environment variable that supplied Listen. It is empty
	// when Source is SourceConfig.
	EnvVar string
}

// Resolve picks the effective listen address. Priority:
//
//	NUNT_ADMIN_LISTEN (full address) > NUNT_ADMIN_PORT (port only) > configured
//
// Empty environment variables count as unset. Values are validated with
// netutil.NormalizeListen; an invalid override is an error instead of a silent
// fallback, because the operator would otherwise believe the override worked.
// Only the effective value is validated: a broken configured value does not
// prevent startup when the environment overrides it.
func Resolve(configured string, getenv func(string) string) (Info, error) {
	info := Info{ConfigListen: configured, Source: SourceConfig}
	if getenv != nil {
		if raw := strings.TrimSpace(getenv(EnvListen)); raw != "" {
			addr, err := netutil.NormalizeListen(raw)
			if err != nil {
				return Info{}, fmt.Errorf("invalid %s=%q: %w", EnvListen, raw, err)
			}
			info.Listen = addr
			info.Source = SourceEnv
			info.EnvVar = EnvListen
			return info, nil
		}
		if raw := strings.TrimSpace(getenv(EnvPort)); raw != "" {
			port, err := parsePort(raw)
			if err != nil {
				return Info{}, fmt.Errorf("invalid %s=%q: %w", EnvPort, raw, err)
			}
			info.Listen = ":" + strconv.Itoa(port)
			info.Source = SourceEnv
			info.EnvVar = EnvPort
			return info, nil
		}
	}

	addr, err := netutil.NormalizeListen(configured)
	if err != nil {
		return Info{}, fmt.Errorf("invalid system.adminListen=%q in the configuration file: %w", configured, err)
	}
	info.Listen = addr
	return info, nil
}

func parsePort(raw string) (int, error) {
	port, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("must be a number between 1 and 65535")
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("must be a number between 1 and 65535")
	}
	return port, nil
}

type contextKey struct{}

// WithInfo exposes the resolved address to the admin API handlers. The app
// wraps the API handler with it; tests and other embedders may omit it, in
// which case the API reports the configured value.
func WithInfo(next http.Handler, info Info) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, info)))
	})
}

// FromContext returns the resolved address injected by WithInfo.
func FromContext(ctx context.Context) (Info, bool) {
	info, ok := ctx.Value(contextKey{}).(Info)
	return info, ok
}
