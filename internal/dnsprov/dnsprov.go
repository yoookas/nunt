// Package dnsprov contains the DNS provider clients shared by the DDNS
// module and the ACME dns-01 challenge solver.
//
// A provider is a small object built from a credential map; it knows how to
// create, update and delete records inside one zone.
package dnsprov

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Credentials holds decrypted provider credentials.
type Credentials map[string]string

// Record is a single DNS record.
type Record struct {
	// Domain is the root domain (or the value entered by the user), e.g.
	// "example.com" or "sub.example.com".
	Domain string
	// SubDomain is the host part relative to Domain: "www", "@" for the root.
	SubDomain string
	// Type is A, AAAA, CNAME or TXT.
	Type string
	// Value is the record content.
	Value string
	// TTL in seconds; 0 means the provider default.
	TTL int
	// Line/record line for providers that need it.
	Line string
}

// FQDN returns the full record name.
func (r Record) FQDN() string {
	sub := strings.TrimSpace(r.SubDomain)
	domain := strings.Trim(strings.TrimSpace(r.Domain), ".")
	switch sub {
	case "", "@":
		return domain
	case "*":
		return "*." + domain
	default:
		return sub + "." + domain
	}
}

// Provider updates records at one DNS vendor.
type Provider interface {
	// Name returns the provider id.
	Name() string
	// Set creates or updates a record.
	Set(ctx context.Context, rec Record) error
	// Delete removes a record (missing records must not be an error).
	Delete(ctx context.Context, rec Record) error
}

// Field describes one credential input in the UI.
type Field struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Secret      bool   `json:"secret,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Help        string `json:"help,omitempty"`
}

// Meta describes a provider for the UI.
type Meta struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Fields   []Field `json:"fields"`
	AuthNote string  `json:"authNote,omitempty"`
}

// Factory builds a provider from credentials.
type Factory func(creds Credentials) (Provider, error)

type registration struct {
	meta    Meta
	factory Factory
}

// Registry keeps every known provider.
type Registry struct {
	mu    sync.RWMutex
	items map[string]registration
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{items: map[string]registration{}}
}

// Register adds a provider. Duplicate ids overwrite the previous entry so a
// build can replace a provider without touching the registry.
func (r *Registry) Register(meta Meta, factory Factory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[meta.ID] = registration{meta: meta, factory: factory}
}

// List returns the provider metadata sorted by id.
func (r *Registry) List() []Meta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Meta, 0, len(r.items))
	for _, item := range r.items {
		out = append(out, item.meta)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Meta returns the metadata of one provider.
func (r *Registry) Meta(id string) (Meta, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	item, ok := r.items[id]
	return item.meta, ok
}

// New builds a provider instance.
func (r *Registry) New(id string, creds Credentials) (Provider, error) {
	r.mu.RLock()
	item, ok := r.items[id]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown dns provider %q", id)
	}
	provider, err := item.factory(creds)
	if err != nil {
		return nil, err
	}
	return provider, nil
}

// Validate checks that every required credential is present.
func (r *Registry) Validate(id string, creds Credentials) error {
	meta, ok := r.Meta(id)
	if !ok {
		return fmt.Errorf("unknown dns provider %q", id)
	}
	var missing []string
	for _, f := range meta.Fields {
		if f.Required && strings.TrimSpace(creds[f.Key]) == "" {
			missing = append(missing, f.Label)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("provider %s: missing %s", meta.Title, strings.Join(missing, ", "))
	}
	return nil
}

var (
	defaultOnce sync.Once
	defaultReg  *Registry
)

// Default returns the process wide registry with every built-in provider.
func Default() *Registry {
	defaultOnce.Do(func() {
		defaultReg = NewRegistry()
		registerBuiltins(defaultReg)
	})
	return defaultReg
}
