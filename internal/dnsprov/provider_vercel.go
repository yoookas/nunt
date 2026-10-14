package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// vercelAPI is the Vercel REST API root.
const vercelAPI = "https://api.vercel.com"

func registerVercel(r *Registry) {
	r.Register(Meta{
		ID:    "vercel",
		Title: "Vercel",
		Fields: []Field{
			{
				Key:         "token",
				Label:       "Access Token",
				Secret:      true,
				Required:    true,
				Placeholder: "Vercel Access Token",
				Help:        "Vercel 控制台「Account Settings → Tokens」创建，需要域名的 DNS 管理权限。",
			},
			{
				Key:         "teamid",
				Label:       "Team ID（可选）",
				Placeholder: "team_xxx",
				Help:        "域名属于某个团队时填写，会作为 teamId 查询参数附加。",
			},
			{
				Key:         "slug",
				Label:       "Team Slug（可选）",
				Placeholder: "my-team",
				Help:        "与 Team ID 二选一，作为 slug 查询参数附加。",
			},
		},
		AuthNote: "REST API v4，Bearer Token；记录按 name+type 查询后 POST 新建或 PATCH 更新。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["token"])
		if token == "" {
			return nil, fmt.Errorf("vercel: token required")
		}
		return &vercelProvider{
			base:   newBase(creds),
			token:  token,
			teamID: strings.TrimSpace(creds["teamid"]),
			slug:   strings.TrimSpace(creds["slug"]),
		}, nil
	})
}

type vercelProvider struct {
	base
	token  string
	teamID string
	slug   string
}

func (p *vercelProvider) Name() string { return "vercel" }

type vercelRecord struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
	TTL   int    `json:"ttl,omitempty"`
}

type vercelRecordsPage struct {
	Records []vercelRecord `json:"records"`
}

func (p *vercelProvider) headers() map[string]string {
	return map[string]string{"Authorization": "Bearer " + p.token}
}

// scope appends the optional team parameters.
func (p *vercelProvider) scope(query url.Values) url.Values {
	if query == nil {
		query = url.Values{}
	}
	if p.teamID != "" {
		query.Set("teamId", p.teamID)
	}
	if p.slug != "" {
		query.Set("slug", p.slug)
	}
	return query
}

// find returns the record matching name and type.
func (p *vercelProvider) find(ctx context.Context, rec Record) (*vercelRecord, error) {
	query := url.Values{}
	query.Set("limit", "100")
	query.Set("name", rec.FQDN())
	query.Set("type", normalizeType(rec.Type))
	target := fmt.Sprintf("%s/v4/domains/%s/records?%s", vercelAPI, url.PathEscape(rootDomain(rec.Domain)), p.scope(query).Encode())
	res, err := p.req(ctx, http.MethodGet, target, "", "", p.headers())
	if err != nil {
		return nil, fmt.Errorf("vercel: list records: %w", err)
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("vercel: list records: %w", err)
	}
	var page vercelRecordsPage
	if err := res.decodeJSON(&page); err != nil {
		return nil, fmt.Errorf("vercel: decode records: %w", err)
	}
	for i := range page.Records {
		if strings.EqualFold(page.Records[i].Name, rec.FQDN()) && strings.EqualFold(page.Records[i].Type, normalizeType(rec.Type)) {
			return &page.Records[i], nil
		}
	}
	return nil, nil
}

func (p *vercelProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("vercel: record value is empty")
	}
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"name":  recordName(rec),
		"type":  normalizeType(rec.Type),
		"value": rec.Value,
		"ttl":   ttlOr(rec, 60),
	}
	base := fmt.Sprintf("%s/v4/domains/%s/records", vercelAPI, url.PathEscape(rootDomain(rec.Domain)))
	if existing == nil {
		target := base + "?" + p.scope(nil).Encode()
		if _, err := p.callJSON(ctx, http.MethodPost, strings.TrimSuffix(target, "?"), payload, p.headers()); err != nil {
			return fmt.Errorf("vercel: create record: %w", err)
		}
		return nil
	}
	if existing.Value == rec.Value {
		return nil
	}
	delete(payload, "name")
	delete(payload, "type")
	target := fmt.Sprintf("%s/%s?%s", base, url.PathEscape(existing.ID), p.scope(nil).Encode())
	if _, err := p.callJSON(ctx, http.MethodPatch, strings.TrimSuffix(target, "?"), payload, p.headers()); err != nil {
		return fmt.Errorf("vercel: update record: %w", err)
	}
	return nil
}

func (p *vercelProvider) Delete(ctx context.Context, rec Record) error {
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	target := fmt.Sprintf("%s/v4/domains/%s/records/%s?%s",
		vercelAPI, url.PathEscape(rootDomain(rec.Domain)), url.PathEscape(existing.ID), p.scope(nil).Encode())
	res, err := p.req(ctx, http.MethodDelete, strings.TrimSuffix(target, "?"), "", "", p.headers())
	if err != nil {
		return fmt.Errorf("vercel: delete record: %w", err)
	}
	if res.Status == http.StatusNotFound {
		return nil
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("vercel: delete record: %w", err)
	}
	return nil
}
