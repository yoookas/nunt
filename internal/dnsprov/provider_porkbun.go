package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// porkbunAPI is the Porkbun DNS API root.
const porkbunAPI = "https://api.porkbun.com/api/json/v3/dns"

func registerPorkbun(r *Registry) {
	r.Register(Meta{
		ID:    "porkbun",
		Title: "Porkbun",
		Fields: []Field{
			{
				Key:         "apikey",
				Label:       "API Key",
				Required:    true,
				Placeholder: "pk1_...",
				Help:        "Porkbun 控制台「Account → API Access」中生成的 API Key。",
			},
			{
				Key:         "secretapikey",
				Label:       "Secret API Key",
				Secret:      true,
				Required:    true,
				Placeholder: "sk1_...",
				Help:        "与 API Key 配对；调用时需要同时开启对应域名的 API 访问权限。",
			},
		},
		AuthNote: "JSON API v3，apikey/secretapikey 放在请求体里。",
	}, func(creds Credentials) (Provider, error) {
		key := strings.TrimSpace(creds["apikey"])
		secret := strings.TrimSpace(creds["secretapikey"])
		if key == "" || secret == "" {
			return nil, fmt.Errorf("porkbun: apikey and secretapikey required")
		}
		return &porkbunProvider{base: newBase(creds), apiKey: key, secretKey: secret}, nil
	})
}

type porkbunProvider struct {
	base
	apiKey    string
	secretKey string
}

func (p *porkbunProvider) Name() string { return "porkbun" }

type porkbunResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Records []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Type    string `json:"type"`
		Content string `json:"content"`
		TTL     string `json:"ttl"`
		Prio    string `json:"prio"`
	} `json:"records"`
}

// call posts one JSON request with the credentials attached.
func (p *porkbunProvider) call(ctx context.Context, path string, extra map[string]any) (*porkbunResponse, error) {
	payload := map[string]any{
		"apikey":       p.apiKey,
		"secretapikey": p.secretKey,
	}
	for k, v := range extra {
		payload[k] = v
	}
	res, err := p.callJSON(ctx, http.MethodPost, porkbunAPI+path, payload, nil)
	if err != nil {
		return nil, fmt.Errorf("porkbun %s: %w", path, err)
	}
	var out porkbunResponse
	if err := res.decodeJSON(&out); err != nil {
		return nil, fmt.Errorf("porkbun %s: %w", path, err)
	}
	if !strings.EqualFold(out.Status, "SUCCESS") {
		return nil, fmt.Errorf("porkbun %s failed: %s %s", path, out.Status, sanitize(out.Message, p.creds, summaryLimit))
	}
	return &out, nil
}

// find returns the first record matching the name and type.
func (p *porkbunProvider) find(ctx context.Context, rec Record) (string, string, error) {
	out, err := p.call(ctx, "/retrieveByNameType/"+rootDomain(rec.Domain)+"/"+normalizeType(rec.Type)+"/"+escapeHost(absoluteName(rec)), nil)
	if err != nil {
		return "", "", err
	}
	for _, item := range out.Records {
		if strings.EqualFold(item.Type, normalizeType(rec.Type)) {
			return item.ID, item.Content, nil
		}
	}
	return "", "", nil
}

func (p *porkbunProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("porkbun: record value is empty")
	}
	id, current, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"name":    absoluteName(rec),
		"type":    normalizeType(rec.Type),
		"content": rec.Value,
		"ttl":     fmt.Sprintf("%d", ttlOr(rec, 600)),
	}
	if id == "" {
		_, err := p.call(ctx, "/create/"+rootDomain(rec.Domain), payload)
		return err
	}
	if current == rec.Value {
		return nil
	}
	delete(payload, "name")
	delete(payload, "type")
	_, err = p.call(ctx, fmt.Sprintf("/edit/%s/%s", rootDomain(rec.Domain), id), payload)
	return err
}

func (p *porkbunProvider) Delete(ctx context.Context, rec Record) error {
	id, _, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	_, err = p.call(ctx, fmt.Sprintf("/delete/%s/%s", rootDomain(rec.Domain), id), nil)
	return err
}
