package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// goDaddyAPI is the GoDaddy domains API root.
const goDaddyAPI = "https://api.godaddy.com/v1"

func registerGoDaddy(r *Registry) {
	r.Register(Meta{
		ID:    "godaddy",
		Title: "GoDaddy",
		Fields: []Field{
			{
				Key:         "key",
				Label:       "API Key",
				Required:    true,
				Placeholder: "API Key",
				Help:        "GoDaddy 开发者门户生成的 Production Key。",
			},
			{
				Key:         "secret",
				Label:       "API Secret",
				Secret:      true,
				Required:    true,
				Placeholder: "API Secret",
				Help:        "与 API Key 配对，形如 sso-key KEY:SECRET 放在 Authorization 头里。",
			},
		},
		AuthNote: "REST v1，Authorization: sso-key KEY:SECRET；PUT 为整体覆盖写。",
	}, func(creds Credentials) (Provider, error) {
		key := strings.TrimSpace(creds["key"])
		secret := strings.TrimSpace(creds["secret"])
		if key == "" || secret == "" {
			return nil, fmt.Errorf("godaddy: key and secret required")
		}
		return &goDaddyProvider{base: newBase(creds), auth: "sso-key " + key + ":" + secret}, nil
	})
}

type goDaddyProvider struct {
	base
	auth string
}

func (p *goDaddyProvider) Name() string { return "godaddy" }

type goDaddyRecord struct {
	Data string `json:"data"`
	Name string `json:"name"`
	TTL  int    `json:"ttl,omitempty"`
	Type string `json:"type,omitempty"`
}

func (p *goDaddyProvider) headers() map[string]string {
	return map[string]string{"Authorization": p.auth}
}

// recordURL builds the per name+type endpoint.
func goDaddyRecordURL(rec Record) string {
	return fmt.Sprintf("%s/domains/%s/records/%s/%s",
		goDaddyAPI, url.PathEscape(rootDomain(rec.Domain)), normalizeType(rec.Type), escapeHost(recordName(rec)))
}

func (p *goDaddyProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("godaddy: record value is empty")
	}
	payload := []goDaddyRecord{{
		Data: rec.Value,
		Name: recordName(rec),
		TTL:  ttlOr(rec, 600),
	}}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("godaddy: encode record: %w", err)
	}
	res, err := p.req(ctx, http.MethodPut, goDaddyRecordURL(rec), string(body), "application/json", p.headers())
	if err != nil {
		return fmt.Errorf("godaddy: write record: %w", err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("godaddy: write record: %w", err)
	}
	return nil
}

// Delete clears the records stored under one name and type. GoDaddy's DELETE
// takes the data values to remove; a missing record reports 404 which is not
// an error for us.
func (p *goDaddyProvider) Delete(ctx context.Context, rec Record) error {
	body := "[]"
	if strings.TrimSpace(rec.Value) != "" {
		raw, err := json.Marshal([]string{rec.Value})
		if err != nil {
			return fmt.Errorf("godaddy: encode record: %w", err)
		}
		body = string(raw)
	}
	res, err := p.req(ctx, http.MethodDelete, goDaddyRecordURL(rec), body, "application/json", p.headers())
	if err != nil {
		return fmt.Errorf("godaddy: delete record: %w", err)
	}
	if res.Status == http.StatusNotFound {
		return nil
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("godaddy: delete record: %w", err)
	}
	return nil
}
