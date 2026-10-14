package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// cloudflareAPI is the Cloudflare v4 API root.
const cloudflareAPI = "https://api.cloudflare.com/client/v4"

func registerCloudflare(r *Registry) {
	r.Register(Meta{
		ID:    "cloudflare",
		Title: "Cloudflare",
		Fields: []Field{
			{
				Key:         "apitoken",
				Label:       "API Token",
				Secret:      true,
				Placeholder: "40 位 API Token",
				Help:        "推荐方式。Token 需要 Zone:Read 与 DNS:Edit 权限，留空则改用下方的 Global API Key。",
			},
			{
				Key:         "email",
				Label:       "账号邮箱",
				Placeholder: "you@example.com",
				Help:        "使用 Global API Key 认证时必填。",
			},
			{
				Key:         "apikey",
				Label:       "Global API Key",
				Secret:      true,
				Placeholder: "Global API Key",
				Help:        "旧版全局密钥，需与账号邮箱一起使用。",
			},
		},
		AuthNote: "API Token（Bearer）或 邮箱 + Global API Key 二选一。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["apitoken"])
		email := strings.TrimSpace(creds["email"])
		key := strings.TrimSpace(creds["apikey"])
		if token == "" && (email == "" || key == "") {
			return nil, fmt.Errorf("cloudflare: api token or email plus global api key required")
		}
		return &cloudflareProvider{base: newBase(creds), token: token, email: email, key: key}, nil
	})
}

type cloudflareProvider struct {
	base
	token string
	email string
	key   string
}

func (p *cloudflareProvider) Name() string { return "cloudflare" }

// headers builds the authentication headers for the configured credentials.
func (p *cloudflareProvider) headers() map[string]string {
	if p.token != "" {
		return map[string]string{"Authorization": "Bearer " + p.token}
	}
	return map[string]string{
		"X-Auth-Email": p.email,
		"X-Auth-Key":   p.key,
	}
}

type cloudflareEnvelope struct {
	Success  bool              `json:"success"`
	Errors   []cloudflareError `json:"errors"`
	Messages []any             `json:"messages"`
	Result   json.RawMessage   `json:"result"`
}

type cloudflareError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cloudflareZone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type cloudflareRecord struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Type    string `json:"type,omitempty"`
	Content string `json:"content,omitempty"`
	TTL     int    `json:"ttl,omitempty"`
	Proxied *bool  `json:"proxied,omitempty"`
	Comment string `json:"comment,omitempty"`
}

// request performs an API call and unwraps the Cloudflare envelope.
func (p *cloudflareProvider) request(ctx context.Context, method, path string, payload any) ([]byte, error) {
	res, err := p.callJSON(ctx, method, cloudflareAPI+path, payload, p.headers())
	if err != nil {
		return nil, fmt.Errorf("cloudflare %s %s: %w", method, path, err)
	}
	var envelope cloudflareEnvelope
	if err := res.decodeJSON(&envelope); err != nil {
		return nil, fmt.Errorf("cloudflare %s %s: %w", method, path, err)
	}
	if !envelope.Success {
		var msgs []string
		for _, item := range envelope.Errors {
			msgs = append(msgs, fmt.Sprintf("%d %s", item.Code, item.Message))
		}
		if len(msgs) == 0 {
			msgs = append(msgs, res.summary())
		}
		return nil, fmt.Errorf("cloudflare %s %s failed: %s", method, path, sanitize(strings.Join(msgs, "; "), p.creds, summaryLimit))
	}
	return envelope.Result, nil
}

// zoneID resolves the zone that owns the given root domain.
func (p *cloudflareProvider) zoneID(ctx context.Context, domain string) (string, error) {
	root := rootDomain(domain)
	query := url.Values{}
	query.Set("name", root)
	query.Set("per_page", "50")
	raw, err := p.request(ctx, http.MethodGet, "/zones?"+query.Encode(), nil)
	if err != nil {
		return "", err
	}
	var zones []cloudflareZone
	if err := jsonUnmarshal(raw, &zones); err != nil {
		return "", fmt.Errorf("cloudflare: decode zone list: %w", err)
	}
	for _, zone := range zones {
		if strings.EqualFold(zone.Name, root) {
			return zone.ID, nil
		}
	}
	if len(zones) == 1 {
		return zones[0].ID, nil
	}
	return "", fmt.Errorf("cloudflare: zone %q not found for this token", root)
}

// findRecord returns the first record matching name and type.
func (p *cloudflareProvider) findRecord(ctx context.Context, zoneID string, rec Record) (*cloudflareRecord, error) {
	name := rec.FQDN()
	query := url.Values{}
	query.Set("type", normalizeType(rec.Type))
	query.Set("name", name)
	query.Set("per_page", "100")
	raw, err := p.request(ctx, http.MethodGet, "/zones/"+zoneID+"/dns_records?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var records []cloudflareRecord
	if err := jsonUnmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("cloudflare: decode record list: %w", err)
	}
	for i := range records {
		if strings.EqualFold(records[i].Type, normalizeType(rec.Type)) && strings.EqualFold(records[i].Name, name) {
			return &records[i], nil
		}
	}
	return nil, nil
}

func (p *cloudflareProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("cloudflare: record value is empty")
	}
	zoneID, err := p.zoneID(ctx, rec.Domain)
	if err != nil {
		return err
	}
	existing, err := p.findRecord(ctx, zoneID, rec)
	if err != nil {
		return err
	}
	ttl := ttlOr(rec, 1)
	payload := cloudflareRecord{
		Type:    normalizeType(rec.Type),
		Name:    rec.FQDN(),
		Content: rec.Value,
		TTL:     ttl,
	}
	if existing == nil {
		if _, err := p.request(ctx, http.MethodPost, "/zones/"+zoneID+"/dns_records", payload); err != nil {
			return err
		}
		return nil
	}
	if existing.Content == rec.Value && existing.TTL == ttl {
		return nil
	}
	if _, err := p.request(ctx, http.MethodPut, "/zones/"+zoneID+"/dns_records/"+existing.ID, payload); err != nil {
		return err
	}
	return nil
}

func (p *cloudflareProvider) Delete(ctx context.Context, rec Record) error {
	zoneID, err := p.zoneID(ctx, rec.Domain)
	if err != nil {
		return err
	}
	existing, err := p.findRecord(ctx, zoneID, rec)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	_, err = p.request(ctx, http.MethodDelete, "/zones/"+zoneID+"/dns_records/"+existing.ID, nil)
	return err
}
