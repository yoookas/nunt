package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// cloudflareEndpoint is the Cloudflare API v4 entry point. It is a variable so
// tests can point the provider at a local server.
var cloudflareEndpoint = "https://api.cloudflare.com/client/v4"

func registerCloudflare(r *Registry) {
	r.Register(Meta{
		ID:    "cloudflare",
		Title: "Cloudflare",
		Fields: []Field{
			{
				Key:         "apitoken",
				Label:       "API Token",
				Secret:      true,
				Required:    true,
				Placeholder: "Bearer token",
				Help:        "Cloudflare → My Profile → API Tokens → Create Token，权限选 Zone → DNS → Edit，并限定到目标域名。",
			},
			{
				Key:         "zoneid",
				Label:       "Zone ID（可选）",
				Placeholder: "自动查找",
				Help:        "域名在多个账户下或自动查找失败时填写；留空会按域名逐级向上查找 zone。",
			},
		},
		AuthNote: "Cloudflare API v4，推荐使用只有 DNS 编辑权限的 API Token；不支持 Global API Key。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["apitoken"])
		if token == "" {
			return nil, fmt.Errorf("cloudflare: api token required")
		}
		return &cloudflareProvider{
			base:   newBase(creds),
			token:  token,
			zoneID: strings.TrimSpace(creds["zoneid"]),
			zones:  map[string]string{},
		}, nil
	})
}

type cloudflareProvider struct {
	base
	token  string
	zoneID string

	mu    sync.Mutex
	zones map[string]string
}

func (p *cloudflareProvider) Name() string { return "cloudflare" }

type cloudflareEnvelope struct {
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

type cloudflareRecord struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Content string `json:"content"`
}

type cloudflareZone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// call performs one API request and unwraps the Cloudflare envelope.
func (p *cloudflareProvider) call(ctx context.Context, method, path string, payload, out any) error {
	res, err := p.base.callJSON(ctx, method, cloudflareEndpoint+path, payload, map[string]string{
		"Authorization": "Bearer " + p.token,
	})
	var env cloudflareEnvelope
	if len(res.Body) > 0 {
		_ = json.Unmarshal(res.Body, &env)
	}
	if err != nil {
		return fmt.Errorf("cloudflare: %s", cloudflareError(&env, res))
	}
	if !env.Success {
		return fmt.Errorf("cloudflare: %s", cloudflareError(&env, res))
	}
	if out != nil && len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("cloudflare: decode result: %w", err)
		}
	}
	return nil
}

func cloudflareError(env *cloudflareEnvelope, res result) string {
	parts := make([]string, 0, len(env.Errors))
	for _, e := range env.Errors {
		if e.Message != "" {
			parts = append(parts, fmt.Sprintf("%s (code %d)", e.Message, e.Code))
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "; ")
	}
	if text := res.Text(); text != "" {
		return text
	}
	return fmt.Sprintf("HTTP %d", res.Status)
}

// zoneFor resolves (and caches) the zone that owns the record. The configured
// Zone ID wins; otherwise the domain is tried as-is and then with one more
// label removed, so "sub.example.com" still finds "example.com".
func (p *cloudflareProvider) zoneFor(ctx context.Context, rec Record) (string, error) {
	if p.zoneID != "" {
		return p.zoneID, nil
	}
	domain := strings.Trim(strings.TrimSpace(rec.Domain), ".")
	if domain == "" {
		return "", fmt.Errorf("cloudflare: domain is required")
	}

	p.mu.Lock()
	cached, ok := p.zones[domain]
	p.mu.Unlock()
	if ok {
		return cached, nil
	}

	labels := strings.Split(domain, ".")
	for i := 0; i < len(labels)-1; i++ {
		candidate := strings.Join(labels[i:], ".")
		var zones []cloudflareZone
		if err := p.call(ctx, http.MethodGet, "/zones?name="+url.QueryEscape(candidate), nil, &zones); err != nil {
			return "", err
		}
		for _, zone := range zones {
			if strings.EqualFold(zone.Name, candidate) && zone.ID != "" {
				p.mu.Lock()
				p.zones[domain] = zone.ID
				p.mu.Unlock()
				return zone.ID, nil
			}
		}
	}
	return "", fmt.Errorf("cloudflare: no zone found for %q", domain)
}

// Set creates the record or updates the existing one. Duplicate records for the
// same name are removed so a stale second value cannot shadow the update.
func (p *cloudflareProvider) Set(ctx context.Context, rec Record) error {
	zone, err := p.zoneFor(ctx, rec)
	if err != nil {
		return err
	}
	name := rec.FQDN()
	body := map[string]any{
		"type":    strings.ToUpper(strings.TrimSpace(rec.Type)),
		"name":    name,
		"content": rec.Value,
		"ttl":     cloudflareTTL(rec.TTL),
		"proxied": false,
	}

	existing, err := p.records(ctx, zone, name, rec.Type)
	if err != nil {
		return err
	}
	if len(existing) == 0 {
		return p.call(ctx, http.MethodPost, "/zones/"+url.PathEscape(zone)+"/dns_records", body, nil)
	}
	if err := p.call(ctx, http.MethodPut, recordPath(zone, existing[0].ID), body, nil); err != nil {
		return err
	}
	for _, extra := range existing[1:] {
		_ = p.call(ctx, http.MethodDelete, recordPath(zone, extra.ID), nil, nil)
	}
	return nil
}

// Delete removes every record with this name and type; a missing record is not
// an error.
func (p *cloudflareProvider) Delete(ctx context.Context, rec Record) error {
	zone, err := p.zoneFor(ctx, rec)
	if err != nil {
		return err
	}
	existing, err := p.records(ctx, zone, rec.FQDN(), rec.Type)
	if err != nil {
		return err
	}
	for _, item := range existing {
		if err := p.call(ctx, http.MethodDelete, recordPath(zone, item.ID), nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func (p *cloudflareProvider) records(ctx context.Context, zone, name, typ string) ([]cloudflareRecord, error) {
	path := fmt.Sprintf("/zones/%s/dns_records?type=%s&name=%s",
		url.PathEscape(zone), url.QueryEscape(strings.ToUpper(strings.TrimSpace(typ))), url.QueryEscape(name))
	var out []cloudflareRecord
	if err := p.call(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func recordPath(zone, id string) string {
	return "/zones/" + url.PathEscape(zone) + "/dns_records/" + url.PathEscape(id)
}

// cloudflareTTL maps the configured TTL: 0 means Cloudflare's automatic value
// (1), and anything below the 60 second minimum is raised to it.
func cloudflareTTL(ttl int) int {
	if ttl <= 0 {
		return 1
	}
	if ttl < 60 {
		return 60
	}
	return ttl
}
