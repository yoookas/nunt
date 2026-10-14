package dnsprov

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// nameCheapAPI is the Namecheap XML API endpoint.
const nameCheapAPI = "https://api.namecheap.com/xml.response"

func registerNamecheap(r *Registry) {
	r.Register(Meta{
		ID:    "namecheap",
		Title: "Namecheap",
		Fields: []Field{
			{
				Key:         "apiuser",
				Label:       "ApiUser",
				Required:    true,
				Placeholder: "Namecheap 用户名",
				Help:        "通常与 UserName 相同，即 Namecheap 登录用户名。",
			},
			{
				Key:         "apikey",
				Label:       "API Key",
				Secret:      true,
				Required:    true,
				Placeholder: "Namecheap API Key",
				Help:        "在 Namecheap「Profile → Tools → API Access」中生成。",
			},
			{
				Key:         "username",
				Label:       "UserName",
				Required:    true,
				Placeholder: "Namecheap 用户名",
				Help:        "执行 API 调用的账号，一般为登录用户名。",
			},
			{
				Key:         "clientip",
				Label:       "ClientIp",
				Required:    true,
				Placeholder: "1.2.3.4",
				Help:        "已在 Namecheap 白名单中的公网 IP，留空会直接被拒绝。",
			},
		},
		AuthNote: "先 getHosts 取回整份解析，改完再 setHosts 整体提交（全量覆盖）。",
	}, func(creds Credentials) (Provider, error) {
		apiUser := strings.TrimSpace(creds["apiuser"])
		apiKey := strings.TrimSpace(creds["apikey"])
		userName := strings.TrimSpace(creds["username"])
		clientIP := strings.TrimSpace(creds["clientip"])
		if apiUser == "" || apiKey == "" || userName == "" || clientIP == "" {
			return nil, fmt.Errorf("namecheap: apiuser, apikey, username and clientip required")
		}
		return &nameCheapProvider{
			base:     newBase(creds),
			apiUser:  apiUser,
			apiKey:   apiKey,
			userName: userName,
			clientIP: clientIP,
		}, nil
	})
}

type nameCheapProvider struct {
	base
	apiUser  string
	apiKey   string
	userName string
	clientIP string
}

func (p *nameCheapProvider) Name() string { return "namecheap" }

// nameCheapHost is one row of a Namecheap host table.
type nameCheapHost struct {
	Name    string `xml:"Name,attr"`
	Type    string `xml:"Type,attr"`
	Address string `xml:"Address,attr"`
	MXPref  string `xml:"MXPref,attr"`
	TTL     string `xml:"TTL,attr"`
}

type nameCheapHosts struct {
	Hosts []nameCheapHost `xml:"Host"`
}

type nameCheapResponse struct {
	Status          string           `xml:"Status,attr"`
	Errors          []nameCheapError `xml:"Errors>Error"`
	CommandResponse struct {
		Result struct {
			IsSuccess string         `xml:"IsSuccess,attr"`
			Domain    string         `xml:"Domain,attr"`
			Hosts     nameCheapHosts `xml:"Hosts"`
		} `xml:"DomainGetHostsResult"`
		SetResult struct {
			IsSuccess string `xml:"IsSuccess,attr"`
		} `xml:"DomainSetHostsResult"`
	} `xml:"CommandResponse"`
}

// nameCheapError is one <Error> element of a failed command.
type nameCheapError struct {
	Number  string `xml:"Number,attr"`
	Message string `xml:",chardata"`
}

// call performs one API command.
func (p *nameCheapProvider) call(ctx context.Context, command string, extra map[string]string) (*nameCheapResponse, error) {
	query := url.Values{}
	query.Set("ApiUser", p.apiUser)
	query.Set("ApiKey", p.apiKey)
	query.Set("UserName", p.userName)
	query.Set("ClientIp", p.clientIP)
	query.Set("Command", command)
	for k, v := range extra {
		query.Set(k, v)
	}
	res, err := p.req(ctx, http.MethodGet, nameCheapAPI+"?"+query.Encode(), "", "", nil)
	if err != nil {
		return nil, fmt.Errorf("namecheap %s: %w", command, err)
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("namecheap %s: %w", command, err)
	}
	var out nameCheapResponse
	if err := xml.Unmarshal(res.Body, &out); err != nil {
		return nil, fmt.Errorf("namecheap %s: decode xml: %w", command, err)
	}
	if !strings.EqualFold(out.Status, "OK") {
		var msgs []string
		for _, item := range out.Errors {
			msgs = append(msgs, strings.TrimSpace(item.Number+" "+item.Message))
		}
		if len(msgs) == 0 {
			msgs = append(msgs, res.summary())
		}
		return nil, fmt.Errorf("namecheap %s failed: %s", command, sanitize(strings.Join(msgs, "; "), p.creds, summaryLimit))
	}
	return &out, nil
}

// splitDomain splits a registrable domain into SLD and TLD parts.
func splitDomain(domain string) (string, string) {
	labels := strings.Split(strings.Trim(rootDomain(domain), "."), ".")
	if len(labels) < 2 {
		return strings.Join(labels, "."), ""
	}
	return strings.Join(labels[:len(labels)-1], "."), labels[len(labels)-1]
}

// getHosts reads the whole host table of a domain.
func (p *nameCheapProvider) getHosts(ctx context.Context, domain string) ([]nameCheapHost, error) {
	sld, tld := splitDomain(domain)
	out, err := p.call(ctx, "namecheap.domains.dns.getHosts", map[string]string{"SLD": sld, "TLD": tld})
	if err != nil {
		return nil, err
	}
	return out.CommandResponse.Result.Hosts.Hosts, nil
}

// setHosts submits the whole host table.
func (p *nameCheapProvider) setHosts(ctx context.Context, domain string, hosts []nameCheapHost) error {
	sld, tld := splitDomain(domain)
	params := map[string]string{"SLD": sld, "TLD": tld}
	for i, host := range hosts {
		idx := strconv.Itoa(i + 1)
		params["HostName"+idx] = host.Name
		params["RecordType"+idx] = host.Type
		params["Address"+idx] = host.Address
		params["TTL"+idx] = host.TTL
		params["MXPref"+idx] = host.MXPref
	}
	out, err := p.call(ctx, "namecheap.domains.dns.setHosts", params)
	if err != nil {
		return err
	}
	if !strings.EqualFold(out.CommandResponse.SetResult.IsSuccess, "true") {
		return fmt.Errorf("namecheap setHosts for %s was rejected", rootDomain(domain))
	}
	return nil
}

// applyRecord returns the host table with rec created, updated or removed.
// The second result reports whether anything was dropped or added. It is a
// pure function so the merge rules stay unit testable.
func applyRecord(hosts []nameCheapHost, rec Record, remove bool) ([]nameCheapHost, bool) {
	name := strings.Trim(recordName(rec), ".")
	typ := normalizeType(rec.Type)
	out := make([]nameCheapHost, 0, len(hosts)+1)
	matched := false
	for _, host := range hosts {
		if strings.EqualFold(strings.Trim(host.Name, "."), name) && strings.EqualFold(host.Type, typ) {
			matched = true
			continue
		}
		out = append(out, host)
	}
	if remove {
		return out, matched
	}
	out = append(out, nameCheapHost{
		Name:    name,
		Type:    typ,
		Address: nameCheapAddress(rec),
		TTL:     strconv.Itoa(ttlOr(rec, 1800)),
	})
	return out, true
}

// nameCheapAddress formats the Address column; TXT values need at least
// 10 characters or the API rejects the whole table.
func nameCheapAddress(rec Record) string {
	value := strings.TrimSpace(rec.Value)
	if normalizeType(rec.Type) == "TXT" && len(value) < 10 {
		value += strings.Repeat(" ", 10-len(value))
	}
	return value
}

func (p *nameCheapProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("namecheap: record value is empty")
	}
	hosts, err := p.getHosts(ctx, rec.Domain)
	if err != nil {
		return err
	}
	updated, _ := applyRecord(hosts, rec, false)
	return p.setHosts(ctx, rec.Domain, updated)
}

func (p *nameCheapProvider) Delete(ctx context.Context, rec Record) error {
	hosts, err := p.getHosts(ctx, rec.Domain)
	if err != nil {
		return err
	}
	updated, changed := applyRecord(hosts, rec, true)
	if !changed {
		return nil
	}
	return p.setHosts(ctx, rec.Domain, updated)
}
