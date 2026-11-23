package dnsprov

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// spaceshipEndpoint is the Spaceship API v1 entry point. It is a variable so
// tests can point the provider at a local server.
var spaceshipEndpoint = "https://spaceship.dev/api/v1"

func registerSpaceship(r *Registry) {
	r.Register(Meta{
		ID:    "spaceship",
		Title: "Spaceship",
		Fields: []Field{
			{
				Key:         "apikey",
				Label:       "API Key",
				Required:    true,
				Placeholder: "API Key",
				Help:        "Spaceship → API Manager 创建的 Key，需要 dnsrecords:read 与 dnsrecords:write 权限。",
			},
			{
				Key:         "apisecret",
				Label:       "API Secret",
				Secret:      true,
				Required:    true,
				Placeholder: "API Secret",
				Help:        "与 API Key 成对出现，只在创建时显示一次。",
			},
		},
		AuthNote: "Spaceship API v1（X-Api-Key / X-Api-Secret）；域名必须已经在该账号下。",
	}, func(creds Credentials) (Provider, error) {
		key := strings.TrimSpace(creds["apikey"])
		secret := strings.TrimSpace(creds["apisecret"])
		if key == "" || secret == "" {
			return nil, fmt.Errorf("spaceship: api key and secret required")
		}
		return &spaceshipProvider{base: newBase(creds), apiKey: key, apiSecret: secret}, nil
	})
}

type spaceshipProvider struct {
	base
	apiKey    string
	apiSecret string
}

func (p *spaceshipProvider) Name() string { return "spaceship" }

// spaceshipRecord is one entry of the record set. Spaceship uses "address" for
// the content of A/AAAA/TXT records and relative names ("@" for the root).
type spaceshipRecord struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	TTL     int    `json:"ttl,omitempty"`
	Address string `json:"address,omitempty"`
}

type spaceshipList struct {
	Items []spaceshipRecord `json:"items"`
	Total int               `json:"total"`
}

func (p *spaceshipProvider) headers() map[string]string {
	return map[string]string{
		"X-Api-Key":    p.apiKey,
		"X-Api-Secret": p.apiSecret,
	}
}

// zone is the domain whose record set is managed.
func (p *spaceshipProvider) zone(rec Record) (string, error) {
	domain := strings.Trim(strings.TrimSpace(rec.Domain), ".")
	if domain == "" {
		return "", fmt.Errorf("spaceship: domain is required")
	}
	return domain, nil
}

// name is the relative label Spaceship expects ("@" for the apex).
func spaceshipName(rec Record) string {
	sub := strings.TrimSpace(rec.SubDomain)
	switch sub {
	case "", "@":
		return "@"
	default:
		return sub
	}
}

// list reads the whole record set, paging until the API returns everything.
func (p *spaceshipProvider) list(ctx context.Context, zone string) ([]spaceshipRecord, error) {
	const page = 200
	out := make([]spaceshipRecord, 0, 16)
	for skip := 0; ; skip += page {
		path := fmt.Sprintf("/dns/records/%s?take=%d&skip=%d", url.PathEscape(zone), page, skip)
		res, err := p.base.callJSON(ctx, http.MethodGet, spaceshipEndpoint+path, nil, p.headers())
		if err != nil {
			return nil, fmt.Errorf("spaceship: list records: %w", err)
		}
		var pageData spaceshipList
		if err := json.Unmarshal(res.Body, &pageData); err != nil {
			return nil, fmt.Errorf("spaceship: decode records: %w", err)
		}
		out = append(out, pageData.Items...)
		if len(pageData.Items) < page {
			break
		}
		if pageData.Total > 0 && len(out) >= pageData.Total {
			break
		}
	}
	return out, nil
}

// put replaces the record set with items. Spaceship applies DNS changes as one
// batch, so every write has to send the complete set: the caller must list
// first and only change the records it owns.
func (p *spaceshipProvider) put(ctx context.Context, zone string, items []spaceshipRecord) error {
	body := map[string]any{"items": items, "force": true}
	path := "/dns/records/" + url.PathEscape(zone)
	if _, err := p.base.callJSON(ctx, http.MethodPut, spaceshipEndpoint+path, body, p.headers()); err != nil {
		return fmt.Errorf("spaceship: save records: %w", err)
	}
	return nil
}

// matches reports whether an existing record is the one being managed.
func matches(item spaceshipRecord, name, typ string) bool {
	return strings.EqualFold(item.Name, name) && strings.EqualFold(item.Type, typ)
}

// Set replaces the managed record and keeps every other record untouched.
func (p *spaceshipProvider) Set(ctx context.Context, rec Record) error {
	zone, err := p.zone(rec)
	if err != nil {
		return err
	}
	existing, err := p.list(ctx, zone)
	if err != nil {
		return err
	}
	name := spaceshipName(rec)
	typ := strings.ToUpper(strings.TrimSpace(rec.Type))
	items := make([]spaceshipRecord, 0, len(existing)+1)
	for _, item := range existing {
		if matches(item, name, typ) {
			continue
		}
		items = append(items, item)
	}
	items = append(items, spaceshipRecord{Type: typ, Name: name, TTL: rec.TTL, Address: rec.Value})
	return p.put(ctx, zone, items)
}

// Delete removes the managed record and keeps the rest of the set.
func (p *spaceshipProvider) Delete(ctx context.Context, rec Record) error {
	zone, err := p.zone(rec)
	if err != nil {
		return err
	}
	existing, err := p.list(ctx, zone)
	if err != nil {
		return err
	}
	name := spaceshipName(rec)
	typ := strings.ToUpper(strings.TrimSpace(rec.Type))
	items := make([]spaceshipRecord, 0, len(existing))
	for _, item := range existing {
		if matches(item, name, typ) {
			continue
		}
		items = append(items, item)
	}
	if len(items) == len(existing) {
		return nil
	}
	return p.put(ctx, zone, items)
}
