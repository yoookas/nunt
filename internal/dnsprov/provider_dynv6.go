package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// dynv6API is the dynv6 v2 API root.
const dynv6API = "https://dynv6.com/api/v2"

func registerDynv6(r *Registry) {
	r.Register(Meta{
		ID:    "dynv6",
		Title: "dynv6",
		Fields: []Field{
			{
				Key:         "token",
				Label:       "HTTP Token",
				Secret:      true,
				Required:    true,
				Placeholder: "dynv6 HTTP Token",
				Help:        "dynv6 控制台 Zones → 你的域名 → HTTP Token。",
			},
			{
				Key:         "zoneid",
				Label:       "Zone ID（可选）",
				Placeholder: "12345",
				Help:        "留空时按域名自动查询 /zones/by-name/{domain}。",
			},
		},
		AuthNote: "REST API v2，Bearer Token 认证。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["token"])
		if token == "" {
			return nil, fmt.Errorf("dynv6: token required")
		}
		return &dynv6Provider{base: newBase(creds), token: token, zoneID: strings.TrimSpace(creds["zoneid"])}, nil
	})
}

type dynv6Provider struct {
	base
	token  string
	zoneID string
}

func (p *dynv6Provider) Name() string { return "dynv6" }

func (p *dynv6Provider) headers() map[string]string {
	return map[string]string{"Authorization": "Bearer " + p.token}
}

type dynv6Zone struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type dynv6Record struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
}

// zone resolves the numeric zone id for a domain.
func (p *dynv6Provider) zone(ctx context.Context, domain string) (string, error) {
	if p.zoneID != "" {
		return p.zoneID, nil
	}
	name := url.PathEscape(rootDomain(domain))
	res, err := p.req(ctx, http.MethodGet, dynv6API+"/zones/by-name/"+name, "", "", p.headers())
	if err != nil {
		return "", fmt.Errorf("dynv6: look up zone %s: %w", rootDomain(domain), err)
	}
	if err := res.statusError(); err != nil {
		return "", fmt.Errorf("dynv6: look up zone %s: %w", rootDomain(domain), err)
	}
	var zone dynv6Zone
	if err := res.decodeJSON(&zone); err != nil {
		return "", fmt.Errorf("dynv6: decode zone: %w", err)
	}
	if zone.ID == 0 {
		return "", fmt.Errorf("dynv6: zone %s has no id", rootDomain(domain))
	}
	return strconv.FormatInt(zone.ID, 10), nil
}

func (p *dynv6Provider) find(ctx context.Context, zoneID string, rec Record) (*dynv6Record, error) {
	res, err := p.req(ctx, http.MethodGet, dynv6API+"/zones/"+zoneID+"/records", "", "", p.headers())
	if err != nil {
		return nil, fmt.Errorf("dynv6: list records: %w", err)
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("dynv6: list records: %w", err)
	}
	var records []dynv6Record
	if err := res.decodeJSON(&records); err != nil {
		return nil, fmt.Errorf("dynv6: decode records: %w", err)
	}
	want := normalizeType(rec.Type)
	for i := range records {
		if strings.EqualFold(records[i].Name, rec.FQDN()) && strings.EqualFold(records[i].Type, want) {
			return &records[i], nil
		}
	}
	return nil, nil
}

func (p *dynv6Provider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("dynv6: record value is empty")
	}
	zoneID, err := p.zone(ctx, rec.Domain)
	if err != nil {
		return err
	}
	existing, err := p.find(ctx, zoneID, rec)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"name": rec.FQDN(),
		"type": normalizeType(rec.Type),
		"data": rec.Value,
	}
	if ttl := rec.TTL; ttl > 0 {
		payload["ttl"] = ttl
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("dynv6: encode record: %w", err)
	}
	method := http.MethodPost
	target := dynv6API + "/zones/" + zoneID + "/records"
	if existing != nil {
		if existing.Data == rec.Value {
			return nil
		}
		method = http.MethodPatch
		target = fmt.Sprintf("%s/zones/%s/records/%d", dynv6API, zoneID, existing.ID)
	}
	res, err := p.req(ctx, method, target, string(body), "application/json", p.headers())
	if err != nil {
		return fmt.Errorf("dynv6: %s record: %w", strings.ToLower(method), err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("dynv6: %s record: %w", strings.ToLower(method), err)
	}
	return nil
}

func (p *dynv6Provider) Delete(ctx context.Context, rec Record) error {
	zoneID, err := p.zone(ctx, rec.Domain)
	if err != nil {
		return err
	}
	existing, err := p.find(ctx, zoneID, rec)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	res, err := p.req(ctx, http.MethodDelete, fmt.Sprintf("%s/zones/%s/records/%d", dynv6API, zoneID, existing.ID), "", "", p.headers())
	if err != nil {
		return fmt.Errorf("dynv6: delete record: %w", err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("dynv6: delete record: %w", err)
	}
	return nil
}
