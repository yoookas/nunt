// Package module defines the lifecycle contract shared by every feature of
// the service and the registry used to start, stop and inspect them.
package module

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/logstore"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/secret"
)

// Status is the runtime state of a module as shown in the UI.
type Status struct {
	Name    string         `json:"name"`
	Title   string         `json:"title"`
	Running bool           `json:"running"`
	Detail  string         `json:"detail,omitempty"`
	Error   string         `json:"error,omitempty"`
	Since   *time.Time     `json:"since,omitempty"`
	Stats   map[string]any `json:"stats,omitempty"`
}

// Module is implemented by every feature.
type Module interface {
	// Name is the stable identifier used by the API and the tasks module.
	Name() string
	// Title is the human readable name shown in the UI.
	Title() string
	// Start brings the module up; it must be safe to call twice.
	Start(ctx context.Context) error
	// Stop releases every resource; it must be idempotent.
	Stop(ctx context.Context) error
	// Status reports the current state.
	Status() Status
}

// Reloader is implemented by modules that react to configuration changes.
type Reloader interface {
	Reload(cfg *model.Config)
}

// APIProvider is implemented by modules that expose REST endpoints.
type APIProvider interface {
	RegisterAPI(mux *rest.Mux)
}

// CertProvider is implemented by the certificate module so the web service
// can request a certificate on demand.
type CertProvider interface {
	// EnsureCertificate asks for a certificate covering the domains and
	// returns once it is available or the attempt failed.
	EnsureCertificate(ctx context.Context, domains []string) error
	// HasCertificate reports whether a valid certificate is already stored.
	HasCertificate(domains []string) bool
}

// ChallengeProvider is implemented by a module that can answer ACME http-01
// challenges through the listeners of the web service, so issuing a certificate
// does not need a second listener on port 80.
type ChallengeProvider interface {
	// ServeChallenge answers the request when its path belongs to a challenge
	// that is currently being validated, and reports whether it did.
	ServeChallenge(w http.ResponseWriter, r *http.Request) bool
	// ServesHTTPChallenge reports whether a plain listener that routes the
	// challenge path is currently bound to port 80, which is the only port a CA
	// connects to for http-01.
	ServesHTTPChallenge() bool
}

// TLSChallengeProvider is implemented by a module that can answer ACME
// tls-alpn-01 challenges on its own TLS listeners.
type TLSChallengeProvider interface {
	// ALPNChallengeConfig returns the TLS configuration that answers a
	// tls-alpn-01 ClientHello, and reports whether this handshake belongs to an
	// active challenge.
	ALPNChallengeConfig(hello *tls.ClientHelloInfo) (*tls.Config, bool)
	// ServesTLSChallenge reports whether a TLS listener is currently bound to
	// port 443.
	ServesTLSChallenge() bool
}

// Deps carries everything a module may need.
type Deps struct {
	Cfg      *config.Store
	Log      *logging.Hub
	Certs    *certs.Store
	Box      *secret.Box
	DataDir  string
	Registry *Registry
	// Logs is the persistent access log shared by the web, forward and WAF
	// modules; it may be nil in tests.
	Logs *logstore.Store
	// Geo resolves the country/province of a client address; it may be nil in
	// tests.
	Geo *ip2region.Service
}

// Logger returns a logger tagged with the module name.
func (d *Deps) Logger(name string) *slog.Logger {
	if d == nil || d.Log == nil {
		return slog.Default()
	}
	// The run log page shows a component column, and it reads this attribute;
	// tag it here so every module log line lands in that column.
	return d.Log.Logger().With("component", name)
}

// Base implements the boring parts of Module.
type Base struct {
	Deps   *Deps
	MName  string
	MTitle string

	mu      sync.Mutex
	running bool
	since   time.Time
	lastErr string
	detail  string
	stats   map[string]any
}

// Init prepares the base with its identity.
func (b *Base) Init(deps *Deps, name, title string) {
	b.Deps = deps
	b.MName = name
	b.MTitle = title
}

// Name implements Module.
func (b *Base) Name() string { return b.MName }

// Title implements Module.
func (b *Base) Title() string { return b.MTitle }

// SetRunning records the running state.
func (b *Base) SetRunning(running bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if running && !b.running {
		b.since = time.Now()
	}
	if !running {
		b.since = time.Time{}
	}
	b.running = running
}

// SetDetail sets the short status text.
func (b *Base) SetDetail(detail string) {
	b.mu.Lock()
	b.detail = detail
	b.mu.Unlock()
}

// SetError records (or clears) the last error.
func (b *Base) SetError(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err == nil {
		b.lastErr = ""
		return
	}
	b.lastErr = err.Error()
}

// SetStats replaces the free form statistics map.
func (b *Base) SetStats(stats map[string]any) {
	b.mu.Lock()
	b.stats = stats
	b.mu.Unlock()
}

// Status implements Module.
func (b *Base) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := Status{
		Name:    b.MName,
		Title:   b.MTitle,
		Running: b.running,
		Detail:  b.detail,
		Error:   b.lastErr,
		Stats:   b.stats,
	}
	if !b.since.IsZero() {
		t := b.since
		st.Since = &t
	}
	return st
}

// Registry holds every module.
type Registry struct {
	mu    sync.RWMutex
	mods  map[string]Module
	order []string
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{mods: map[string]Module{}}
}

// Register adds a module and rejects duplicates.
func (r *Registry) Register(m Module) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := m.Name()
	if _, exists := r.mods[name]; exists {
		return fmt.Errorf("module %q is already registered", name)
	}
	r.mods[name] = m
	r.order = append(r.order, name)
	return nil
}

// MustRegister panics when a module cannot be registered; used during wiring
// where a duplicate is a programming error.
func (r *Registry) MustRegister(m Module) {
	if err := r.Register(m); err != nil {
		panic(err)
	}
}

// Get returns a module by name.
func (r *Registry) Get(name string) (Module, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.mods[name]
	return m, ok
}

// All returns the modules in registration order.
func (r *Registry) All() []Module {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Module, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.mods[name])
	}
	return out
}

// Statuses returns the status of every module.
func (r *Registry) Statuses() []Status {
	out := []Status{}
	for _, m := range r.All() {
		out = append(out, m.Status())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// StartAll starts every module, collecting errors instead of aborting.
func (r *Registry) StartAll(ctx context.Context) []error {
	var errs []error
	for _, m := range r.All() {
		if err := m.Start(ctx); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", m.Name(), err))
		}
	}
	return errs
}

// StopAll stops every module in reverse order.
func (r *Registry) StopAll(ctx context.Context) {
	mods := r.All()
	for i := len(mods) - 1; i >= 0; i-- {
		_ = mods[i].Stop(ctx)
	}
}

// Reload pushes a new configuration to every interested module.
func (r *Registry) Reload(cfg *model.Config) {
	for _, m := range r.All() {
		if rl, ok := m.(Reloader); ok {
			rl.Reload(cfg)
		}
	}
}

// APIProviders returns the modules that expose REST endpoints.
func (r *Registry) APIProviders() []APIProvider {
	var out []APIProvider
	for _, m := range r.All() {
		if p, ok := m.(APIProvider); ok {
			out = append(out, p)
		}
	}
	return out
}
