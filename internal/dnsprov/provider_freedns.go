package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// freeDNSUpdate is the afraid.org dynamic update endpoint.
const freeDNSUpdate = "https://freedns.afraid.org/dynamic/update.php"

func registerFreeDNS(r *Registry) {
	r.Register(Meta{
		ID:    "freedns",
		Title: "FreeDNS (afraid.org)",
		Fields: []Field{
			{
				Key:         "token",
				Label:       "更新 Token",
				Secret:      true,
				Required:    true,
				Placeholder: "从 update.php?xxxx 中取 xxxx",
				Help:        "FreeDNS 的 Dynamic DNS 页面给出的更新地址形如 https://freedns.afraid.org/dynamic/update.php?XXXX，这里只填问号后的部分。",
			},
			{
				Key:         "address",
				Label:       "记录地址（可选）",
				Placeholder: "myhost.example.com",
				Help:        "留空时使用 DDNS 规则里的完整域名。",
			},
		},
		AuthNote: "GET /dynamic/update.php?<token>&address=..&ip=..，返回 Updated / No change。",
	}, func(creds Credentials) (Provider, error) {
		token := strings.TrimSpace(creds["token"])
		if token == "" {
			return nil, fmt.Errorf("freedns: token required")
		}
		return &freeDNSProvider{base: newBase(creds), token: token, address: strings.TrimSpace(creds["address"])}, nil
	})
}

type freeDNSProvider struct {
	base
	token   string
	address string
}

func (p *freeDNSProvider) Name() string { return "freedns" }

// target resolves the address to update.
func (p *freeDNSProvider) target(rec Record) string {
	if p.address != "" {
		return p.address
	}
	return rec.FQDN()
}

func (p *freeDNSProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("freedns: record value is empty")
	}
	query := url.Values{}
	query.Set("address", p.target(rec))
	query.Set("ip", rec.Value)
	// The token travels as the bare query string of the update URL.
	res, err := p.req(ctx, http.MethodGet, freeDNSUpdate+"?"+url.QueryEscape(p.token)+"&"+query.Encode(), "", "", nil)
	if err != nil {
		return fmt.Errorf("freedns: update %s: %w", p.target(rec), err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("freedns: update %s: %w", p.target(rec), err)
	}
	body := res.Text()
	if !successText(body, []string{"Updated", "No change", "has not changed"}) {
		return fmt.Errorf("freedns: update %s rejected: %s", p.target(rec), sanitize(body, p.creds, summaryLimit))
	}
	return nil
}

// Delete is a no-op: afraid.org only offers an update endpoint.
func (p *freeDNSProvider) Delete(_ context.Context, _ Record) error { return nil }
