package dnsprov

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// nameSiloAPI is the NameSilo XML API endpoint.
const nameSiloAPI = "https://www.namesilo.com/api"

func registerNameSilo(r *Registry) {
	r.Register(Meta{
		ID:    "namesilo",
		Title: "NameSilo",
		Fields: []Field{
			{
				Key:         "apikey",
				Label:       "API Key",
				Secret:      true,
				Required:    true,
				Placeholder: "NameSilo API Key",
				Help:        "NameSilo 控制台「API Manager」生成；需要在同一页面为域名开启 API 访问。",
			},
		},
		AuthNote: "XML API（version=1&type=xml），返回体用 encoding/xml 解析。",
	}, func(creds Credentials) (Provider, error) {
		key := strings.TrimSpace(creds["apikey"])
		if key == "" {
			return nil, fmt.Errorf("namesilo: api key required")
		}
		return &nameSiloProvider{base: newBase(creds), apiKey: key}, nil
	})
}

type nameSiloProvider struct {
	base
	apiKey string
}

func (p *nameSiloProvider) Name() string { return "namesilo" }

// nameSiloReply mirrors <namesilo><reply>..</reply></namesilo>.
type nameSiloReply struct {
	Detail   string `xml:"reply>detail"`
	RecordID string `xml:"reply>record_id"`
	Resource struct {
		Record []nameSiloRecord `xml:"record"`
	} `xml:"reply>resource"`
}

type nameSiloRecord struct {
	RecordID string `xml:"record_id"`
	Type     string `xml:"type"`
	Host     string `xml:"host"`
	Value    string `xml:"value"`
	TTL      string `xml:"ttl"`
}

// nameSiloCall performs one XML API call.
func (p *nameSiloProvider) call(ctx context.Context, action string, extra map[string]string) (*nameSiloReply, error) {
	query := url.Values{}
	query.Set("version", "1")
	query.Set("type", "xml")
	query.Set("key", p.apiKey)
	query.Set("domain", rootDomain(extra["domain"]))
	for k, v := range extra {
		if k == "domain" {
			continue
		}
		query.Set(k, v)
	}
	res, err := p.req(ctx, http.MethodGet, nameSiloAPI+"/"+action+"?"+query.Encode(), "", "", nil)
	if err != nil {
		return nil, fmt.Errorf("namesilo %s: %w", action, err)
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("namesilo %s: %w", action, err)
	}
	var reply nameSiloReply
	if err := xml.Unmarshal(res.Body, &reply); err != nil {
		return nil, fmt.Errorf("namesilo %s: decode xml: %w", action, err)
	}
	if err := reply.err(); err != nil {
		return nil, fmt.Errorf("namesilo %s: %w", action, err)
	}
	return &reply, nil
}

// err reports API level failures. NameSilo answers either a numeric code
// (300 success, 301 no records, 3xx error) or a human readable detail such as
// "success" or "303 Invalid Request: Invalid api key".
func (r *nameSiloReply) err() error {
	detail := strings.TrimSpace(r.Detail)
	if detail == "" {
		return fmt.Errorf("missing response detail")
	}
	code := detail
	if idx := strings.IndexAny(code, " \t"); idx >= 0 {
		code = code[:idx]
	}
	switch {
	case code == "300", code == "301":
		return nil
	case strings.EqualFold(detail, "success"):
		return nil
	case strings.HasPrefix(code, "1"), strings.HasPrefix(code, "2"):
		return nil
	default:
		return fmt.Errorf("api error: %s", sanitize(detail, nil, summaryLimit))
	}
}

// find returns the record id of a matching name+type pair.
func (p *nameSiloProvider) find(ctx context.Context, rec Record) (string, string, error) {
	reply, err := p.call(ctx, "dnsListRecords", map[string]string{"domain": rootDomain(rec.Domain)})
	if err != nil {
		return "", "", err
	}
	fqdn := strings.ToLower(rec.FQDN())
	host := strings.ToLower(recordName(rec))
	for _, item := range reply.Resource.Record {
		if !strings.EqualFold(item.Type, normalizeType(rec.Type)) {
			continue
		}
		name := strings.ToLower(strings.Trim(item.Host, "."))
		if name == fqdn || name == host || (name == strings.ToLower(rootDomain(rec.Domain)) && host == "@") {
			return item.RecordID, item.Value, nil
		}
	}
	return "", "", nil
}

func (p *nameSiloProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("namesilo: record value is empty")
	}
	id, current, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	params := map[string]string{
		"domain":  rootDomain(rec.Domain),
		"rrhost":  recordName(rec),
		"rrtype":  normalizeType(rec.Type),
		"rrvalue": rec.Value,
		"rrttl":   fmt.Sprintf("%d", ttlOr(rec, 3600)),
	}
	if id == "" {
		_, err := p.call(ctx, "dnsAddRecord", params)
		return err
	}
	if current == rec.Value {
		return nil
	}
	params["rrid"] = id
	_, err = p.call(ctx, "dnsUpdateRecord", params)
	return err
}

func (p *nameSiloProvider) Delete(ctx context.Context, rec Record) error {
	id, _, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	_, err = p.call(ctx, "dnsDeleteRecord", map[string]string{
		"domain": rootDomain(rec.Domain),
		"rrid":   id,
	})
	return err
}
