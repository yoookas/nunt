package dnsprov

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/httpc"
)

// alidnsEndpoint is the Aliyun DNS RPC entry point.
const alidnsEndpoint = "https://alidns.aliyuncs.com/"

// alidnsVersion is the Aliyun DNS API version.
const alidnsVersion = "2015-01-09"

func registerAliDNS(r *Registry) {
	r.Register(Meta{
		ID:    "alidns",
		Title: "阿里云解析 DNS",
		Fields: []Field{
			{
				Key:         "accesskeyid",
				Label:       "AccessKey ID",
				Required:    true,
				Placeholder: "LTAI...",
				Help:        "RAM 用户的 AccessKey ID，需要 AliyunDNSFullAccess 权限。",
			},
			{
				Key:         "accesskeysecret",
				Label:       "AccessKey Secret",
				Secret:      true,
				Required:    true,
				Placeholder: "AccessKey Secret",
				Help:        "与 AccessKey ID 配对，仅在创建时显示一次。",
			},
		},
		AuthNote: "RPC 签名 v1.0（HMAC-SHA1），密钥来自阿里云 RAM 控制台。",
	}, func(creds Credentials) (Provider, error) {
		id := strings.TrimSpace(creds["accesskeyid"])
		secret := strings.TrimSpace(creds["accesskeysecret"])
		if id == "" || secret == "" {
			return nil, fmt.Errorf("alidns: access key id and secret required")
		}
		return &aliDNSProvider{base: newBase(creds), accessKeyID: id, accessKeySecret: secret}, nil
	})
}

type aliDNSProvider struct {
	base
	accessKeyID     string
	accessKeySecret string
}

func (p *aliDNSProvider) Name() string { return "alidns" }

type aliDNSRecord struct {
	RecordID string `json:"RecordId"`
	Domain   string `json:"DomainName"`
	RR       string `json:"RR"`
	Type     string `json:"Type"`
	Value    string `json:"Value"`
	TTL      int    `json:"TTL"`
	Line     string `json:"Line"`
}

type aliDNSResponse struct {
	RequestID string `json:"RequestId"`
	Code      string `json:"Code"`
	Message   string `json:"Message"`
	RecordID  string `json:"RecordId"`
	Total     int    `json:"TotalCount"`
	Records   struct {
		Record []aliDNSRecord `json:"Record"`
	} `json:"DomainRecords"`
}

// rpc runs one signed RPC call and returns the decoded response.
func (p *aliDNSProvider) rpc(ctx context.Context, action string, params map[string]string) (*aliDNSResponse, error) {
	query := url.Values{}
	for k, v := range params {
		if strings.TrimSpace(v) != "" {
			query.Set(k, v)
		}
	}
	query.Set("Action", action)
	query.Set("Format", "JSON")
	query.Set("Version", alidnsVersion)
	query.Set("AccessKeyId", p.accessKeyID)
	query.Set("SignatureMethod", "HMAC-SHA1")
	query.Set("SignatureVersion", "1.0")
	query.Set("SignatureNonce", randomNonce())
	query.Set("Timestamp", time.Now().UTC().Format("2006-01-02T15:04:05Z"))
	query.Set("Signature", signAliyunRPC(http.MethodGet, query, p.accessKeySecret))

	res, err := p.call(ctx, httpc.Request{Method: http.MethodGet, URL: alidnsEndpoint + "?" + query.Encode()})
	if err != nil {
		return nil, fmt.Errorf("alidns %s: %w", action, err)
	}
	var out aliDNSResponse
	if err := res.decodeJSON(&out); err != nil {
		return nil, fmt.Errorf("alidns %s: %w", action, err)
	}
	if out.Code != "" {
		return nil, fmt.Errorf("alidns %s failed: %s %s", action, out.Code, sanitize(out.Message, p.creds, summaryLimit))
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("alidns %s: %w", action, err)
	}
	return &out, nil
}

// pickAliDNSRecord chooses the record to update: the one matching both the
// RR and the type wins, then a type match, then the first returned row.
func pickAliDNSRecord(records []aliDNSRecord, rr, typ string) *aliDNSRecord {
	wantRR := strings.Trim(strings.TrimSpace(rr), ".")
	wantType := normalizeType(typ)
	for i := range records {
		if !strings.EqualFold(records[i].Type, wantType) {
			continue
		}
		gotRR := strings.Trim(strings.TrimSpace(records[i].RR), ".")
		if gotRR == wantRR || (gotRR == "" && wantRR == "@") || (wantRR == "@" && strings.EqualFold(gotRR, "@")) {
			return &records[i]
		}
	}
	for i := range records {
		if strings.EqualFold(records[i].Type, wantType) {
			return &records[i]
		}
	}
	if len(records) > 0 {
		return &records[0]
	}
	return nil
}

// find returns the record that should be updated, if any.
func (p *aliDNSProvider) find(ctx context.Context, rec Record) (*aliDNSRecord, error) {
	out, err := p.rpc(ctx, "DescribeSubDomainRecords", map[string]string{
		"DomainName": rootDomain(rec.Domain),
		"SubDomain":  rec.FQDN(),
		"Type":       normalizeType(rec.Type),
		"PageSize":   "100",
	})
	if err != nil {
		return nil, err
	}
	return pickAliDNSRecord(out.Records.Record, recordName(rec), rec.Type), nil
}

func (p *aliDNSProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("alidns: record value is empty")
	}
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	ttl := strconv.Itoa(ttlOr(rec, 600))
	line := strings.TrimSpace(rec.Line)
	if line == "" {
		line = "default"
	}
	if existing == nil {
		_, err := p.rpc(ctx, "AddDomainRecord", map[string]string{
			"DomainName": rootDomain(rec.Domain),
			"RR":         recordName(rec),
			"Type":       normalizeType(rec.Type),
			"Value":      rec.Value,
			"TTL":        ttl,
			"Line":       line,
		})
		return err
	}
	if existing.Value == rec.Value {
		return nil
	}
	_, err = p.rpc(ctx, "UpdateDomainRecord", map[string]string{
		"RecordId": existing.RecordID,
		"RR":       recordName(rec),
		"Type":     normalizeType(rec.Type),
		"Value":    rec.Value,
		"TTL":      ttl,
		"Line":     line,
	})
	return err
}

func (p *aliDNSProvider) Delete(ctx context.Context, rec Record) error {
	existing, err := p.find(ctx, rec)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	_, err = p.rpc(ctx, "DeleteDomainRecord", map[string]string{"RecordId": existing.RecordID})
	return err
}

// signAliyunRPC implements the Aliyun RPC signature version 1.0 (HMAC-SHA1).
func signAliyunRPC(method string, params url.Values, secret string) string {
	canonical := canonicalAliyunQuery(params)
	stringToSign := strings.ToUpper(method) + "&%2F&" + aliyunEncode(canonical)
	mac := hmac.New(sha1.New, []byte(secret+"&"))
	mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// canonicalAliyunQuery sorts the parameters and encodes them the way the
// Aliyun RPC signature expects.
func canonicalAliyunQuery(params url.Values) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		if k == "Signature" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, aliyunEncode(k)+"="+aliyunEncode(params.Get(k)))
	}
	return strings.Join(parts, "&")
}

// aliyunEncode percent encodes a string per the Aliyun POP spec: unreserved
// characters A-Za-z0-9-_.~ stay, space becomes %20 and everything else is
// upper case hex.
func aliyunEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == ' ':
			b.WriteString("%20")
		default:
			const hex = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}
