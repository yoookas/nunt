package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// desecAPI is the deSEC REST API root.
const desecAPI = "https://desec.io/api/v1"

func registerDESEC(r *Registry) {
	r.Register(Meta{
		ID:    "desec",
		Title: "deSEC",
		Fields: []Field{
			{
				Key:         "token",
				Label:       "API Token",
				Secret:      true,
				Required:    true,
				Placeholder: "deSEC API Token",
				Help:        "在 deSEC 控制台「Token」页面创建，需要域名的读写的权限。",
			},
		},
		AuthNote: "REST API v1，Authorization: Token <token>，按 RRset 整体读写。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["token"])
		if token == "" {
			return nil, fmt.Errorf("desec: token required")
		}
		return &desecProvider{base: newBase(creds), token: token, api: desecAPI}, nil
	})
}

type desecProvider struct {
	base
	token string
	// api is the REST root; tests point it at a local server.
	api string
}

func (p *desecProvider) Name() string { return "desec" }

type desecRRset struct {
	Domain  string   `json:"domain"`
	Subname string   `json:"subname"`
	Type    string   `json:"type"`
	TTL     int      `json:"ttl,omitempty"`
	Records []string `json:"records"`
}

func (p *desecProvider) headers() map[string]string {
	return map[string]string{"Authorization": "Token " + p.token}
}

// subname returns the RRset subname: empty for the apex.
func desecSubname(rec Record) string {
	sub := strings.Trim(strings.TrimSpace(rec.SubDomain), ".")
	if sub == "" || sub == "@" {
		return ""
	}
	return sub
}

// rrsetURL builds the RRset endpoint for one record.
func desecRRsetURL(base string, rec Record) string {
	parts := []string{base, "domains", url.PathEscape(rootDomain(rec.Domain)), "rrsets"}
	if sub := desecSubname(rec); sub != "" {
		parts = append(parts, escapeHost(sub))
	}
	parts = append(parts, normalizeType(rec.Type))
	return strings.Join(parts, "/") + "/"
}

// find returns the RRset when it exists, nil when the API answers 404.
func (p *desecProvider) find(ctx context.Context, rec Record) (*desecRRset, error) {
	res, err := p.req(ctx, http.MethodGet, desecRRsetURL(p.api, rec), "", "", p.headers())
	if err != nil {
		return nil, fmt.Errorf("desec: read rrset: %w", err)
	}
	if res.Status == http.StatusNotFound {
		return nil, nil
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("desec: read rrset: %w", err)
	}
	var out desecRRset
	if err := res.decodeJSON(&out); err != nil {
		return nil, fmt.Errorf("desec: decode rrset: %w", err)
	}
	return &out, nil
}

func (p *desecProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("desec: record value is empty")
	}
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	records := []string{rec.Value}
	if existing != nil && normalizeType(rec.Type) == "TXT" {
		// Keep the other values of the same TXT set (ACME publishes one per
		// challenge); replacing the set would invalidate the pending order.
		records = mergeTXTRecords(existing.Records, rec.Value)
	}
	payload := desecRRset{
		Subname: desecSubname(rec),
		Type:    normalizeType(rec.Type),
		Records: records,
	}
	if ttl := rec.TTL; ttl > 0 {
		payload.TTL = ttl
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("desec: encode rrset: %w", err)
	}
	method := http.MethodPost
	if existing != nil {
		method = http.MethodPut
	}
	res, err := p.req(ctx, method, desecRRsetURL(p.api, rec), string(body), "application/json", p.headers())
	if err != nil {
		return fmt.Errorf("desec: write rrset: %w", err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("desec: write rrset: %w", err)
	}
	return nil
}

func (p *desecProvider) Delete(ctx context.Context, rec Record) error {
	res, err := p.req(ctx, http.MethodDelete, desecRRsetURL(p.api, rec), "", "", p.headers())
	if err != nil {
		return fmt.Errorf("desec: delete rrset: %w", err)
	}
	if res.Status == http.StatusNotFound {
		return nil
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("desec: delete rrset: %w", err)
	}
	return nil
}
