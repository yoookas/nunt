package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// dnspodEndpoint is the DNSPod (Tencent Cloud) legacy API root.
const dnspodEndpoint = "https://dnsapi.cn"

func registerDNSPod(r *Registry) {
	r.Register(Meta{
		ID:    "dnspod",
		Title: "DNSPod（腾讯云）",
		Fields: []Field{
			{
				Key:         "id",
				Label:       "登录 Token ID",
				Required:    true,
				Placeholder: "123456",
				Help:        "DNSPod 控制台「用户中心 → 安全设置 → API Token」中的 ID。",
			},
			{
				Key:         "token",
				Label:       "登录 Token",
				Secret:      true,
				Required:    true,
				Placeholder: "API Token",
				Help:        "与 Token ID 配对，明文仅显示一次；提交格式为 ID,Token。",
			},
		},
		AuthNote: "旧版 dnspod.cn API（login_token=ID,Token，POST 表单）。",
	}, func(creds Credentials) (Provider, error) {
		id := strings.TrimSpace(creds["id"])
		token := strings.TrimSpace(creds["token"])
		if id == "" || token == "" {
			return nil, fmt.Errorf("dnspod: token id and token required")
		}
		return &dnspodProvider{base: newBase(creds), loginToken: id + "," + token}, nil
	})
}

type dnspodProvider struct {
	base
	loginToken string
}

func (p *dnspodProvider) Name() string { return "dnspod" }

type dnspodStatus struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type dnspodRecord struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Value   string `json:"value"`
	Line    string `json:"line"`
	Enabled string `json:"enabled"`
}

type dnspodResponse struct {
	Status  dnspodStatus   `json:"status"`
	Records []dnspodRecord `json:"records"`
}

// call posts a signed form to one DNSPod endpoint.
func (p *dnspodProvider) call(ctx context.Context, path string, form map[string]string) (*dnspodResponse, error) {
	body := map[string]string{
		"login_token": p.loginToken,
		"format":      "json",
		"lang":        "cn",
	}
	for k, v := range form {
		body[k] = v
	}
	res, err := p.callForm(ctx, http.MethodPost, dnspodEndpoint+path, body, nil)
	if err != nil {
		return nil, fmt.Errorf("dnspod %s: %w", path, err)
	}
	var out dnspodResponse
	if err := res.decodeJSON(&out); err != nil {
		return nil, fmt.Errorf("dnspod %s: %w", path, err)
	}
	if out.Status.Code != "1" {
		return nil, fmt.Errorf("dnspod %s failed: %s %s", path, out.Status.Code, sanitize(out.Status.Message, p.creds, summaryLimit))
	}
	return &out, nil
}

func (p *dnspodProvider) find(ctx context.Context, rec Record) (*dnspodRecord, error) {
	out, err := p.call(ctx, "/Record.List", map[string]string{
		"domain":      rootDomain(rec.Domain),
		"sub_domain":  recordName(rec),
		"record_type": normalizeType(rec.Type),
	})
	if err != nil {
		return nil, err
	}
	for i := range out.Records {
		item := out.Records[i]
		if strings.EqualFold(item.Type, normalizeType(rec.Type)) {
			return &item, nil
		}
	}
	return nil, nil
}

func (p *dnspodProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("dnspod: record value is empty")
	}
	line := strings.TrimSpace(rec.Line)
	if line == "" {
		line = "默认"
	}
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	form := map[string]string{
		"domain":      rootDomain(rec.Domain),
		"sub_domain":  recordName(rec),
		"record_type": normalizeType(rec.Type),
		"record_line": line,
		"value":       rec.Value,
		"ttl":         strconv.Itoa(ttlOr(rec, 600)),
	}
	if existing == nil {
		_, err := p.call(ctx, "/Record.Create", form)
		return err
	}
	if existing.Value == rec.Value {
		return nil
	}
	form["record_id"] = existing.ID
	_, err = p.call(ctx, "/Record.Modify", form)
	return err
}

func (p *dnspodProvider) Delete(ctx context.Context, rec Record) error {
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	_, err = p.call(ctx, "/Record.Remove", map[string]string{
		"domain":    rootDomain(rec.Domain),
		"record_id": existing.ID,
	})
	return err
}
