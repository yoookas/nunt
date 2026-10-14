package dnsprov

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/nunt/nunt/internal/httpc"
)

func registerCustom(r *Registry) {
	r.Register(Meta{
		ID:    "custom",
		Title: "自定义回调（Custom Callback）",
		Fields: []Field{
			{
				Key:         "url",
				Label:       "请求 URL",
				Required:    true,
				Placeholder: "https://example.com/ddns?host={fqdn}&ip={ip}&type={type}",
				Help:        "支持占位符 {ip} {domain} {fqdn} {type} {sub} {ttl}；URL 中的占位符会自动做 URL 编码。",
			},
			{
				Key:         "method",
				Label:       "请求方法",
				Placeholder: "POST",
				Help:        "GET / POST / PUT / PATCH / DELETE，留空默认 POST。",
			},
			{
				Key:         "headers",
				Label:       "请求头",
				Placeholder: "Authorization: Bearer xxx | Content-Type: application/json",
				Help:        "每行一个「名称: 值」，同样支持占位符。",
			},
			{
				Key:         "body",
				Label:       "请求体",
				Placeholder: "{\"host\":\"{fqdn}\",\"ip\":\"{ip}\",\"type\":\"{type}\"}",
				Help:        "留空表示不带请求体；内容以 { 开头时自动使用 application/json。",
			},
			{
				Key:         "user",
				Label:       "BasicAuth 用户名",
				Placeholder: "可选",
				Help:        "填写后使用 HTTP Basic 认证。",
			},
			{
				Key:         "pass",
				Label:       "BasicAuth 密码",
				Secret:      true,
				Placeholder: "可选",
				Help:        "与用户名一起使用；不会出现在错误信息里。",
			},
		},
		AuthNote: "不调用固定 API：把记录渲染进你配置的 URL 与请求体，返回 2xx 视为成功（可用 ok/success 关键字判定）。",
	}, func(creds Credentials) (Provider, error) {
		rawURL := strings.TrimSpace(creds["url"])
		if rawURL == "" {
			return nil, fmt.Errorf("custom: url required")
		}
		return &customProvider{base: newBase(creds), rawURL: rawURL, secrets: []string{rawURL}}, nil
	})
}

type customProvider struct {
	base
	rawURL  string
	secrets []string
}

func (p *customProvider) Name() string { return "custom" }

// render expands the supported placeholders in a template. urlEscape selects
// the escaping used for values interpolated into a URL.
func renderTemplate(text string, rec Record, urlEscape bool) string {
	if text == "" {
		return text
	}
	value := func(v string) string {
		if urlEscape {
			return escapeURLValue(v)
		}
		return v
	}
	replacer := strings.NewReplacer(
		"{ip}", value(rec.Value),
		"{domain}", value(rootDomain(rec.Domain)),
		"{fqdn}", value(rec.FQDN()),
		"{type}", value(normalizeType(rec.Type)),
		"{sub}", value(recordName(rec)),
		"{ttl}", value(fmt.Sprintf("%d", rec.TTL)),
	)
	return replacer.Replace(text)
}

// escapeURLValue escapes a value interpolated into a URL. The wildcard label
// is encoded explicitly because a bare "*" is invalid in a path segment.
func escapeURLValue(v string) string {
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			const hex = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

// parseHeaderLines parses "Name: value" lines into a header map. Lines
// without a colon and empty names are ignored.
func parseHeaderLines(raw string) map[string]string {
	headers := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, ":")
		if idx <= 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "" {
			continue
		}
		headers[name] = strings.TrimSpace(line[idx+1:])
	}
	if len(headers) == 0 {
		return nil
	}
	return headers
}

// contentTypeFor guesses the content type of a request body.
func contentTypeFor(body string) string {
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return "application/json"
	}
	if strings.Contains(trimmed, "=") {
		return "application/x-www-form-urlencoded"
	}
	return "text/plain; charset=utf-8"
}

// joinPath renders the URL template with url encoded placeholders. The
// rendered URL is dropped when it carries a credential, so a token pasted
// into the URL never reaches an error message.
func (p *customProvider) joinPath(template string, rec Record) string {
	rendered := renderTemplate(template, rec, true)
	// A literal query value in the template is likely a token; hide the whole
	// URL rather than risk echoing it back in an error message.
	for _, value := range urlQueryValues(template) {
		if len(value) >= 4 && strings.Contains(rendered, value) {
			return "(url hidden)"
		}
	}
	for _, secret := range p.secrets {
		secret = strings.TrimSpace(secret)
		if len(secret) >= 3 && strings.Contains(rendered, secret) {
			return "(url hidden)"
		}
	}
	return rendered
}

// urlQueryValues returns the literal (non placeholder) values of the query
// string, which is where providers usually carry a token.
func urlQueryValues(rawURL string) []string {
	idx := strings.Index(rawURL, "?")
	if idx < 0 {
		return nil
	}
	query := rawURL[idx+1:]
	if end := strings.Index(query, "#"); end >= 0 {
		query = query[:end]
	}
	var out []string
	for _, pair := range strings.Split(query, "&") {
		eq := strings.Index(pair, "=")
		if eq < 0 {
			continue
		}
		value := strings.TrimSpace(pair[eq+1:])
		if value == "" || strings.Contains(value, "{") {
			continue
		}
		out = append(out, value)
	}
	return out
}

// buildRequest renders the configured template for one record.
func (p *customProvider) buildRequest(rec Record) httpc.Request {
	method := strings.ToUpper(strings.TrimSpace(p.cred("method")))
	if method == "" {
		method = http.MethodPost
	}
	body := renderTemplate(p.cred("body"), rec, false)
	req := httpc.Request{
		Method:      method,
		URL:         p.joinPath(p.rawURL, rec),
		Body:        body,
		Headers:     parseHeaderLines(renderTemplate(p.cred("headers"), rec, false)),
		BasicUser:   p.cred("user"),
		BasicPass:   p.cred("pass"),
		ContentType: contentTypeFor(body),
	}
	return req
}

func (p *customProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("custom: record value is empty")
	}
	req := p.buildRequest(rec)
	res, err := p.call(ctx, req)
	if err != nil {
		return fmt.Errorf("custom: call %s: %w", req.URL, err)
	}
	if err := res.statusError(); err != nil {
		return fmt.Errorf("custom: call %s: %w", req.URL, err)
	}
	body := res.Text()
	if body != "" && !successText(body, nil) {
		return fmt.Errorf("custom: call %s rejected: %s", req.URL, p.sanitize(body))
	}
	return nil
}

// Delete is a no-op: a free form callback has no generic way to remove a
// record, the operator is expected to point the URL at a delete endpoint.
func (p *customProvider) Delete(_ context.Context, _ Record) error { return nil }

// sanitize keeps the credentials out of the error text, including the URL
// template which often carries a token in its query string.
func (p *customProvider) sanitize(text string) string {
	out := sanitize(text, p.creds, summaryLimit)
	for _, secret := range p.secrets {
		out = redact(out, secret)
	}
	return out
}
