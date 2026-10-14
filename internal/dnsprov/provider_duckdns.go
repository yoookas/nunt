package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// duckdnsUpdate is the DuckDNS update endpoint.
const duckdnsUpdate = "https://www.duckdns.org/update"

func registerDuckDNS(r *Registry) {
	r.Register(Meta{
		ID:    "duckdns",
		Title: "DuckDNS",
		Fields: []Field{
			{
				Key:         "domain",
				Label:       "DuckDNS 子域名",
				Required:    true,
				Placeholder: "myhost",
				Help:        "只填 DuckDNS 子域名本身，不要带 .duckdns.org。DDNS 规则中的「域名」保持同一值即可。",
			},
			{
				Key:         "token",
				Label:       "Token",
				Secret:      true,
				Required:    true,
				Placeholder: "DuckDNS Token",
				Help:        "登录 duckdns.org 首页即可看到账号 Token。",
			},
		},
		AuthNote: "GET /update?domains=..&token=..&ip=..&ipv6=..，返回 OK / KO。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["token"])
		if token == "" {
			return nil, fmt.Errorf("duckdns: token required")
		}
		return &duckDNSProvider{
			base:   newBase(creds),
			domain: strings.ToLower(strings.TrimSuffix(strings.TrimSpace(creds["domain"]), ".duckdns.org")),
			token:  token,
		}, nil
	})
}

type duckDNSProvider struct {
	base
	domain string
	token  string
}

func (p *duckDNSProvider) Name() string { return "duckdns" }

// updateQuery builds the query string for one update call.
//
// DuckDNS keeps a single IPv4 and a single IPv6 field per subdomain, so an A
// record lands in "ip" and an AAAA record in "ipv6".
func (p *duckDNSProvider) updateQuery(rec Record) (url.Values, error) {
	query := url.Values{}
	query.Set("domains", p.domain)
	query.Set("token", p.token)
	switch normalizeType(rec.Type) {
	case "A":
		query.Set("ip", rec.Value)
	case "AAAA":
		query.Set("ipv6", rec.Value)
	default:
		return nil, fmt.Errorf("duckdns: record type %s is not supported", normalizeType(rec.Type))
	}
	return query, nil
}

func (p *duckDNSProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("duckdns: record value is empty")
	}
	query, err := p.updateQuery(rec)
	if err != nil {
		return err
	}
	res, err := p.req(ctx, http.MethodGet, duckdnsUpdate+"?"+query.Encode(), "", "", nil)
	if err != nil {
		return fmt.Errorf("duckdns: update %s: %w", p.domain, err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("duckdns: update %s: %w", p.domain, err)
	}
	if !successText(res.Text(), []string{"OK"}) {
		return fmt.Errorf("duckdns: update %s rejected: %s", p.domain, sanitize(res.Text(), p.creds, summaryLimit))
	}
	return nil
}

// Delete is a no-op: DuckDNS has no API to remove the address, clearing the
// record would be the closest equivalent but it would also break updates.
func (p *duckDNSProvider) Delete(_ context.Context, _ Record) error {
	return nil
}
