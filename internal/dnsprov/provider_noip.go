package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/nunt/nunt/internal/httpc"
)

// noipUpdate is the No-IP dyndns2 compatible endpoint.
const noipUpdate = "https://dynupdate.no-ip.com/nic/update"

func registerNoIP(r *Registry) {
	r.Register(Meta{
		ID:    "noip",
		Title: "No-IP",
		Fields: []Field{
			{
				Key:         "username",
				Label:       "用户名",
				Required:    true,
				Placeholder: "you@example.com",
				Help:        "No-IP 账号邮箱；也可使用 DDNS Key 的用户名（形如 12345）。",
			},
			{
				Key:         "password",
				Label:       "密码 / DDNS Key",
				Secret:      true,
				Required:    true,
				Placeholder: "密码或 DDNS Key",
				Help:        "账号密码，或在 No-IP 控制台生成的 DDNS Key。",
			},
			{
				Key:         "hostname",
				Label:       "主机名（可选）",
				Placeholder: "myhost.ddns.net",
				Help:        "留空时使用 DDNS 规则里的完整域名。",
			},
		},
		AuthNote: "dyndns2 协议，HTTP Basic 认证，返回 good / nochg / nohost 等。",
	}, func(creds Credentials) (Provider, error) {
		user := strings.TrimSpace(creds["username"])
		pass := strings.TrimSpace(creds["password"])
		if user == "" || pass == "" {
			return nil, fmt.Errorf("noip: username and password required")
		}
		return &noIPProvider{
			base:     newBase(creds),
			username: user,
			password: pass,
			hostname: strings.TrimSpace(creds["hostname"]),
		}, nil
	})
}

type noIPProvider struct {
	base
	username string
	password string
	hostname string
}

func (p *noIPProvider) Name() string { return "noip" }

// host resolves the hostname to update.
func (p *noIPProvider) host(rec Record) string {
	if p.hostname != "" {
		return p.hostname
	}
	return rec.FQDN()
}

// updateQuery builds the dyndns2 query string.
func (p *noIPProvider) updateQuery(rec Record) url.Values {
	query := url.Values{}
	query.Set("hostname", p.host(rec))
	query.Set("myip", rec.Value)
	return query
}

func (p *noIPProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("noip: record value is empty")
	}
	query := p.updateQuery(rec)
	res, err := p.call(ctx, httpc.Request{
		Method:    http.MethodGet,
		URL:       noipUpdate + "?" + query.Encode(),
		BasicUser: p.username,
		BasicPass: p.password,
		Headers:   map[string]string{"User-Agent": "nunt/1.0 ddns-client"},
	})
	if err != nil {
		return fmt.Errorf("noip: update %s: %w", p.host(rec), err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("noip: update %s: %w", p.host(rec), err)
	}
	body := res.Text()
	if !successText(body, []string{"good", "nochg"}) {
		return fmt.Errorf("noip: update %s rejected: %s", p.host(rec), sanitize(body, p.creds, summaryLimit))
	}
	return nil
}

// Delete is a no-op: No-IP has no delete endpoint for dynamic hosts.
func (p *noIPProvider) Delete(_ context.Context, _ Record) error { return nil }
