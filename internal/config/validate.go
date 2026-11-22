package config

import (
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/nunt/nunt/internal/dnsprov"
	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// Default concurrency caps of a stored port forward rule. Zero disables a cap,
// so a rule that never passed through the normaliser keeps relaying without a
// limit; a persisted rule always carries an explicit, visible value.
const (
	defaultForwardMaxConns      = 1024
	defaultForwardMaxConnsPerIP = 64
)

func deepCopy(in, out any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// Normalize repairs the parts of the configuration that can be derived or
// that older versions may have left empty.
func Normalize(c *model.Config) {
	if c.System.AdminListen == "" {
		c.System.AdminListen = DefaultAdminListen
	}
	if c.System.LogLevel == "" {
		c.System.LogLevel = "info"
	}
	if c.System.SessionTTLHours <= 0 {
		c.System.SessionTTLHours = 12
	}
	if c.System.LoginMaxFail <= 0 {
		c.System.LoginMaxFail = 5
	}
	if c.System.LoginLockMin <= 0 {
		c.System.LoginLockMin = 10
	}
	if c.System.Theme == "" {
		c.System.Theme = "dark"
	}
	if c.Web.LogKeep <= 0 {
		c.Web.LogKeep = 200
	}
	if c.WAF.Mode == "" {
		c.WAF.Mode = model.WAFModeBlock
	}
	if c.WAF.ParanoiaLevel <= 0 {
		c.WAF.ParanoiaLevel = 1
	}
	if c.WAF.BodyLimitKB <= 0 {
		c.WAF.BodyLimitKB = 128
	}
	if c.ACME.KeyType == "" {
		c.ACME.KeyType = "ec256"
	}

	for i := range c.Web.Listeners {
		l := &c.Web.Listeners[i]
		if l.ID == "" {
			l.ID = model.NewID()
		}
		l.Name = strings.TrimSpace(l.Name)
		if l.TLS.Mode == "" {
			l.TLS.Mode = model.TLSModeOff
		}
		l.TLS.Mode = normalizeWebTLSMode(l.TLS.Mode)
		l.TLS.CertID = strings.TrimSpace(l.TLS.CertID)
		for j := range l.Listen {
			l.Listen[j] = strings.TrimSpace(l.Listen[j])
		}
	}
	for i := range c.Web.Rules {
		r := &c.Web.Rules[i]
		if r.ID == "" {
			r.ID = model.NewID()
		}
		r.ListenerID = strings.TrimSpace(r.ListenerID)
		// A config with exactly one listener does not have to repeat its id on
		// every route.
		if r.ListenerID == "" && len(c.Web.Listeners) == 1 {
			r.ListenerID = c.Web.Listeners[0].ID
		}
		r.Path = model.NormalizePath(r.Path)
		if r.Type == "" {
			r.Type = model.WebTypeProxy
		}
		if r.Access.Mode == "" {
			r.Access.Mode = model.AccessOff
		}
		if r.Access.UAMode == "" {
			r.Access.UAMode = model.AccessOff
		}
		normalizeGeoAccess(&r.Access)
		if r.Proxy != nil && r.Proxy.Balance == "" {
			r.Proxy.Balance = "roundrobin"
		}
		if r.Redirect != nil && r.Redirect.Status == 0 {
			r.Redirect.Status = 302
		}
	}
	for i := range c.Forward.Rules {
		r := &c.Forward.Rules[i]
		if r.ID == "" {
			r.ID = model.NewID()
		}
		if r.Protocol == "" {
			r.Protocol = "tcp"
		}
		if r.Access.Mode == "" {
			r.Access.Mode = model.AccessOff
		}
		normalizeGeoAccess(&r.Access)
		if r.MaxConns == 0 {
			r.MaxConns = defaultForwardMaxConns
		}
		if r.MaxConnsPerIP == 0 {
			r.MaxConnsPerIP = defaultForwardMaxConnsPerIP
		}
	}
	for i := range c.DDNS.Rules {
		r := &c.DDNS.Rules[i]
		if r.ID == "" {
			r.ID = model.NewID()
		}
		if r.RecordType == "" {
			r.RecordType = "A"
		}
		if r.IntervalSec <= 0 {
			r.IntervalSec = 300
		}
		if r.TTL <= 0 {
			r.TTL = 600
		}
		if r.Callback != nil && r.Callback.Method == "" {
			r.Callback.Method = "GET"
		}
	}
	for i := range c.ACME.Jobs {
		j := &c.ACME.Jobs[i]
		if j.ID == "" {
			j.ID = model.NewID()
		}
		if j.Challenge == "" {
			j.Challenge = "http"
		}
		switch {
		case j.RenewDays <= 0:
			j.RenewDays = 30
		case j.RenewDays > 30:
			// A window wider than the certificate lifetime would renew on every
			// check and burn the CA rate limit.
			j.RenewDays = 30
		}
		if j.KeyType == "" {
			j.KeyType = c.ACME.KeyType
		}
	}
	c.System.IP2RegionDB = strings.TrimSpace(c.System.IP2RegionDB)
	for i := range c.Storage.Mounts {
		m := &c.Storage.Mounts[i]
		if m.ID == "" {
			m.ID = model.NewID()
		}
		if m.Type == "" {
			m.Type = model.MountLocal
		}
	}
}

// Validate rejects configurations that would break the service.
func Validate(c *model.Config) error {
	if len(c.Users) == 0 {
		return fmt.Errorf("at least one administrator account is required")
	}
	listeners, err := validateWebListeners(c.Web.Listeners)
	if err != nil {
		return err
	}
	seenRoutes := map[string]string{}
	for _, r := range c.Web.Rules {
		listener, ok := listeners[r.ListenerID]
		if !ok {
			return fmt.Errorf("web rule %q: unknown listener %q", displayName(r.Name, r.ID), r.ListenerID)
		}
		if r.Proxy != nil {
			if r.Proxy.RateLimitPerSec < 0 {
				return fmt.Errorf("web rule %q: rateLimitPerSec must not be negative", displayName(r.Name, r.ID))
			}
			if r.Proxy.MaxBodyBytes < 0 {
				return fmt.Errorf("web rule %q: maxBodyBytes must not be negative", displayName(r.Name, r.ID))
			}
		}
		if r.Enable {
			key := r.ListenerID + "\x00" + routeFingerprint(r)
			if other, dup := seenRoutes[key]; dup {
				return fmt.Errorf("web rule %q: the same domains and path are already served by rule %q on listener %q",
					displayName(r.Name, r.ID), other, listener.Name)
			}
			seenRoutes[key] = displayName(r.Name, r.ID)
		}
		if r.Enable && listener.TLS.Mode == model.TLSModeAuto && !hasConcreteDomain(r.Domains) {
			return fmt.Errorf("web rule %q: automatic TLS needs at least one concrete domain", displayName(r.Name, r.ID))
		}
		if err := validateGeoAccess(r.Access, r.Enable, c.System.IP2RegionDB); err != nil {
			return fmt.Errorf("web rule %q: %w", displayName(r.Name, r.ID), err)
		}
		switch r.Type {
		case model.WebTypeProxy:
			if r.Proxy == nil || len(r.Proxy.Targets) == 0 {
				return fmt.Errorf("web rule %q: proxy target is required", displayName(r.Name, r.ID))
			}
		case model.WebTypeRedirect:
			if r.Redirect == nil || strings.TrimSpace(r.Redirect.To) == "" {
				return fmt.Errorf("web rule %q: redirect target is required", displayName(r.Name, r.ID))
			}
		case model.WebTypeStatic:
			if r.Static == nil {
				return fmt.Errorf("web rule %q: static settings are required", displayName(r.Name, r.ID))
			}
		default:
			return fmt.Errorf("web rule %q: unknown type %q", displayName(r.Name, r.ID), r.Type)
		}
	}
	for _, r := range c.Forward.Rules {
		if _, _, err := net.SplitHostPort(r.SrcAddr); err != nil {
			return fmt.Errorf("forward rule %q: invalid source address %q", displayName(r.Name, r.ID), r.SrcAddr)
		}
		if _, _, err := net.SplitHostPort(r.DstAddr); err != nil {
			return fmt.Errorf("forward rule %q: invalid destination address %q", displayName(r.Name, r.ID), r.DstAddr)
		}
		if r.MaxConns < 0 {
			return fmt.Errorf("forward rule %q: maxConns must not be negative", displayName(r.Name, r.ID))
		}
		if r.MaxConnsPerIP < 0 {
			return fmt.Errorf("forward rule %q: maxConnsPerIP must not be negative", displayName(r.Name, r.ID))
		}
		if err := validateGeoAccess(r.Access, r.Enable, c.System.IP2RegionDB); err != nil {
			return fmt.Errorf("forward rule %q: %w", displayName(r.Name, r.ID), err)
		}
	}
	for _, r := range c.DDNS.Rules {
		if strings.TrimSpace(r.Domain) == "" {
			return fmt.Errorf("ddns rule %q: domain is required", displayName(r.Name, r.ID))
		}
		// A disabled rule is a draft and may still be incomplete; an enabled
		// one must name a provider this build actually ships.
		if !r.Enable {
			continue
		}
		provider := strings.TrimSpace(r.Provider)
		if provider == "" {
			return fmt.Errorf("ddns rule %q: a DNS provider is required", displayName(r.Name, r.ID))
		}
		if _, ok := dnsprov.Default().Meta(provider); !ok {
			return fmt.Errorf("ddns rule %q: unknown DNS provider %q", displayName(r.Name, r.ID), provider)
		}
	}
	for _, j := range c.ACME.Jobs {
		if len(j.Domains) == 0 {
			return fmt.Errorf("certificate job %q: at least one domain is required", displayName(j.Name, j.ID))
		}
		if j.Challenge == "dns" && j.DNSProvider == "" {
			return fmt.Errorf("certificate job %q: a DNS provider is required for the dns-01 challenge", displayName(j.Name, j.ID))
		}
		if j.Enable && strings.TrimSpace(j.DNSProvider) != "" {
			if _, ok := dnsprov.Default().Meta(j.DNSProvider); !ok {
				return fmt.Errorf("certificate job %q: unknown DNS provider %q", displayName(j.Name, j.ID), j.DNSProvider)
			}
		}
	}
	for _, m := range c.Storage.Mounts {
		if m.Type == model.MountLocal && strings.TrimSpace(m.Root) == "" {
			return fmt.Errorf("mount %q: local root path is required", displayName(m.Name, m.ID))
		}
		if m.Type == model.MountWebDAV && strings.TrimSpace(m.URL) == "" {
			return fmt.Errorf("mount %q: webdav url is required", displayName(m.Name, m.ID))
		}
	}
	return nil
}

// normalizeWebTLSMode canonicalises a listener TLS mode.
func normalizeWebTLSMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case model.TLSModeAuto:
		return model.TLSModeAuto
	case model.TLSModeCustom:
		return model.TLSModeCustom
	default:
		return model.TLSModeOff
	}
}

// validateWebListeners checks the listener level: unique ids, valid and unique
// socket addresses, and a usable TLS configuration.
func validateWebListeners(list []model.WebListener) (map[string]model.WebListener, error) {
	out := make(map[string]model.WebListener, len(list))
	for i, l := range list {
		name := displayName(l.Name, l.ID)
		if strings.TrimSpace(l.ID) == "" {
			return nil, fmt.Errorf("web listener %q: an id is required", name)
		}
		if _, dup := out[l.ID]; dup {
			return nil, fmt.Errorf("web listener %q: duplicate id %q", name, l.ID)
		}
		if len(l.Listen) == 0 {
			return nil, fmt.Errorf("web listener %q: at least one listen address is required", name)
		}
		for _, addr := range l.Listen {
			if _, err := netutil.NormalizeListen(addr); err != nil {
				return nil, fmt.Errorf("web listener %q: %w", name, err)
			}
			for j := 0; j < i; j++ {
				for _, other := range list[j].Listen {
					if netutil.SameListen(addr, other) {
						return nil, fmt.Errorf("web listener %q: %s is already used by listener %q",
							name, addr, displayName(list[j].Name, list[j].ID))
					}
				}
			}
		}
		switch l.TLS.Mode {
		case "", model.TLSModeOff, model.TLSModeAuto:
		case model.TLSModeCustom:
			if strings.TrimSpace(l.TLS.CertID) == "" {
				return nil, fmt.Errorf("web listener %q: the custom TLS mode needs a certificate", name)
			}
		default:
			return nil, fmt.Errorf("web listener %q: unknown TLS mode %q", name, l.TLS.Mode)
		}
		out[l.ID] = l
	}
	return out, nil
}

// routeFingerprint identifies the (domains, path) pair that must be unique per
// listener: two routes with the same pair could never both be reached.
func routeFingerprint(r model.WebRule) string {
	domains := make([]string, 0, len(r.Domains))
	for _, d := range r.Domains {
		d = strings.ToLower(strings.TrimSpace(d))
		if d != "" {
			domains = append(domains, d)
		}
	}
	sort.Strings(domains)
	return strings.Join(domains, ",") + "\x00" + model.NormalizePath(r.Path)
}

// hasConcreteDomain reports whether an automatic certificate can be requested
// for at least one of the domains.
func hasConcreteDomain(domains []string) bool {
	for _, d := range domains {
		d = strings.TrimSpace(d)
		if d == "" || d == "*" || strings.HasPrefix(d, "~") {
			continue
		}
		return true
	}
	return false
}

// normalizeGeoAccess trims and canonicalises the country/province lists so the
// matcher only has to compare the short province names.
func normalizeGeoAccess(a *model.Access) {
	a.Countries = normalizeCountryList(a.Countries)
	a.Provinces = normalizeProvinceList(a.Provinces)
}

func normalizeCountryList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func normalizeProvinceList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, item := range in {
		name := ip2region.NormalizeProvince(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// validateGeoAccess checks the country/province part of an access rule. A rule
// that uses it must be an allow/deny rule, and an enabled rule needs the
// database path: without it every geo lookup fails closed.
func validateGeoAccess(access model.Access, enabled bool, dbPath string) error {
	if len(access.Countries) == 0 && len(access.Provinces) == 0 {
		return nil
	}
	if access.Mode != model.AccessAllow && access.Mode != model.AccessDeny {
		return fmt.Errorf("country/province filtering requires access mode allow or deny")
	}
	for _, country := range access.Countries {
		if strings.Contains(country, "|") || utf8.RuneCountInString(country) > 32 {
			return fmt.Errorf("invalid country %q", country)
		}
	}
	for _, province := range access.Provinces {
		if !ip2region.KnownProvince(province) {
			return fmt.Errorf("unknown province %q", province)
		}
	}
	if enabled && strings.TrimSpace(dbPath) == "" {
		return fmt.Errorf("country/province filtering requires system.ip2regionDb to be configured")
	}
	return nil
}

// basicAuthHasUsers reports whether the rule carries a usable basic auth list.
func basicAuthHasUsers(auth *model.BasicAuth) bool {
	return auth != nil && auth.Enable && len(auth.Users) > 0
}

func displayName(name, id string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return id
}
