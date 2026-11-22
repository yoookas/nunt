package config

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"

	"github.com/nunt/nunt/internal/model"
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
	if c.ACME.CA == "" {
		c.ACME.CA = "letsencrypt"
	}
	if c.ACME.KeyType == "" {
		c.ACME.KeyType = "ec256"
	}

	for i := range c.Web.Rules {
		r := &c.Web.Rules[i]
		if r.ID == "" {
			r.ID = model.NewID()
		}
		r.Path = model.NormalizePath(r.Path)
		if r.Type == "" {
			r.Type = model.WebTypeProxy
		}
		if r.TLS.Mode == "" {
			r.TLS.Mode = model.TLSModeOff
		}
		if r.Access.Mode == "" {
			r.Access.Mode = model.AccessOff
		}
		if r.Access.UAMode == "" {
			r.Access.UAMode = model.AccessOff
		}
		for j := range r.Listen {
			r.Listen[j] = strings.TrimSpace(r.Listen[j])
		}
		if r.Proxy != nil && r.Proxy.Balance == "" {
			r.Proxy.Balance = "roundrobin"
		}
		if r.Redirect != nil && r.Redirect.Status == 0 {
			r.Redirect.Status = 302
		}
		if r.Files != nil && r.Files.ShareTTLMin == 0 {
			r.Files.ShareTTLMin = 1440
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
	for i := range c.Storage.Mounts {
		m := &c.Storage.Mounts[i]
		if m.ID == "" {
			m.ID = model.NewID()
		}
		if m.Type == "" {
			m.Type = model.MountLocal
		}
	}
	for i := range c.Tasks.Items {
		t := &c.Tasks.Items[i]
		if t.ID == "" {
			t.ID = model.NewID()
		}
		if t.Cron == "" {
			t.Cron = "0 3 * * *"
		}
	}
}

// Validate rejects configurations that would break the service.
func Validate(c *model.Config) error {
	if len(c.Users) == 0 {
		return fmt.Errorf("at least one administrator account is required")
	}
	for _, r := range c.Web.Rules {
		if len(r.Listen) == 0 {
			return fmt.Errorf("web rule %q: at least one listen address is required", displayName(r.Name, r.ID))
		}
		if err := requireFileServiceAuth(&r); err != nil {
			return err
		}
		if r.Proxy != nil {
			if r.Proxy.RateLimitPerSec < 0 {
				return fmt.Errorf("web rule %q: rateLimitPerSec must not be negative", displayName(r.Name, r.ID))
			}
			if r.Proxy.MaxBodyBytes < 0 {
				return fmt.Errorf("web rule %q: maxBodyBytes must not be negative", displayName(r.Name, r.ID))
			}
		}
		for _, l := range r.Listen {
			if _, _, err := net.SplitHostPort(l); err != nil {
				return fmt.Errorf("web rule %q: invalid listen address %q", displayName(r.Name, r.ID), l)
			}
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
		case model.WebTypeStatic, model.WebTypeFiles, model.WebTypeWebDAV:
			if r.Static == nil && r.Files == nil {
				return fmt.Errorf("web rule %q: storage settings are required", displayName(r.Name, r.ID))
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
	}
	for _, r := range c.DDNS.Rules {
		if strings.TrimSpace(r.Domain) == "" {
			return fmt.Errorf("ddns rule %q: domain is required", displayName(r.Name, r.ID))
		}
	}
	for _, j := range c.ACME.Jobs {
		if len(j.Domains) == 0 {
			return fmt.Errorf("certificate job %q: at least one domain is required", displayName(j.Name, j.ID))
		}
		if j.Challenge == "dns" && j.DNSProvider == "" {
			return fmt.Errorf("certificate job %q: a DNS provider is required for the dns-01 challenge", displayName(j.Name, j.ID))
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

// requireFileServiceAuth rejects filebrowser and webdav rules that would be
// reachable by anybody: these rule types read and write the mounted storage, so
// every anonymous visitor they accept is an anonymous storage account. Such a
// rule must be gated by basic authentication or by an allow list of client
// addresses. Both checks are deliberately made on the stored configuration, not
// on the runtime state, so a rule cannot be activated later through a toggle
// that skips validation.
func requireFileServiceAuth(r *model.WebRule) error {
	switch r.Type {
	case model.WebTypeFiles, model.WebTypeWebDAV:
	default:
		return nil
	}
	if basicAuthHasUsers(r.BasicAuth) {
		return nil
	}
	if r.Access.Mode == model.AccessAllow && len(r.Access.IPs) > 0 {
		return nil
	}
	return fmt.Errorf("web rule %q: type %s exposes the file storage without authentication, "+
		"enable BasicAuth for this rule (basicAuth.enable with at least one user) "+
		"or set the access control to allow + IP list",
		displayName(r.Name, r.ID), r.Type)
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
