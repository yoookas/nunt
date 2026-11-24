package dnsprov

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// tencentEndpoint is the Tencent Cloud API 3.0 entry point for DNSPod. It is a
// variable so tests can point the provider at a local server.
var tencentEndpoint = "https://dnspod.tencentcloudapi.com"

const (
	// tencentVersion is the DNSPod API version.
	tencentVersion = "2021-03-23"
	// tencentService is the signing scope of every DNSPod call.
	tencentService = "dnspod"
	// tencentContentType is both sent and signed; the API rejects a different
	// value in the canonical request.
	tencentContentType = "application/json"
	// tencentNoDataCode is how DNSPod answers a DescribeRecordList for a name
	// that has no records yet: an error inside a 200 response. It is not a
	// failure, it means "the list is empty".
	tencentNoDataCode = "ResourceNotFound.NoDataOfRecord"

	// tencentSignedHeaders lists the headers covered by the signature. The
	// official SDK signs exactly these two; X-TC-Action travels unsigned. It
	// used to be listed here without being part of the canonical headers,
	// which made every request fail with AuthFailure.SignatureFailure.
	tencentSignedHeaders = "content-type;host"
)

func registerTencent(r *Registry) {
	r.Register(Meta{
		ID:    "tencent",
		Title: "腾讯云",
		Fields: []Field{
			{
				Key:         "secretid",
				Label:       "SecretId",
				Required:    true,
				Placeholder: "AKID...",
				Help:        "腾讯云控制台「访问管理 → API 密钥管理」的 SecretId（AKID 开头），不是 DNSPod 账号的 Token ID。",
			},
			{
				Key:         "secretkey",
				Label:       "SecretKey",
				Secret:      true,
				Required:    true,
				Placeholder: "SecretKey",
				Help:        "与 SecretId 配对的 SecretKey；域名需要在「DNS 解析 DNSPod」里托管。",
			},
		},
		AuthNote: "腾讯云 API 3.0（TC3-HMAC-SHA256），凭据是腾讯云 API 密钥（SecretId/SecretKey），不是 DNSPod 个人版的登录 Token；子账号需要「DNS 解析 DNSPod」的解析读写权限。",
	}, func(creds Credentials) (Provider, error) {
		id := strings.TrimSpace(creds["secretid"])
		key := strings.TrimSpace(creds["secretkey"])
		if id == "" || key == "" {
			return nil, fmt.Errorf("tencent: secret id and secret key required")
		}
		return &tencentProvider{
			base:      newBase(creds),
			secretID:  id,
			secretKey: key,
			now:       time.Now,
		}, nil
	})
}

type tencentProvider struct {
	base
	secretID  string
	secretKey string
	// now is injectable so tests can pin the timestamp.
	now func() time.Time
}

func (p *tencentProvider) Name() string { return "tencent" }

type tencentRecord struct {
	RecordID int64  `json:"RecordId"`
	Name     string `json:"Name"`
	Type     string `json:"Type"`
	Value    string `json:"Value"`
	Line     string `json:"Line"`
	TTL      int    `json:"TTL"`
}

type tencentError struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

type tencentEnvelope struct {
	Response struct {
		RequestID  string          `json:"RequestId"`
		Error      *tencentError   `json:"Error"`
		RecordList []tencentRecord `json:"RecordList"`
	} `json:"Response"`
}

// call performs one signed API 3.0 request.
func (p *tencentProvider) call(ctx context.Context, action string, payload any) (*tencentEnvelope, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("tencent %s: encode request: %w", action, err)
	}
	endpoint, err := url.Parse(tencentEndpoint)
	if err != nil {
		return nil, fmt.Errorf("tencent %s: bad endpoint: %w", action, err)
	}
	ts := p.now().Unix()
	headers := map[string]string{
		"Host":           endpoint.Host,
		"Content-Type":   tencentContentType,
		"X-TC-Action":    action,
		"X-TC-Version":   tencentVersion,
		"X-TC-Timestamp": strconv.FormatInt(ts, 10),
		"Authorization":  tc3Authorization(p.secretID, p.secretKey, tencentService, endpoint.Host, ts, string(body)),
	}
	res, err := p.req(ctx, http.MethodPost, endpoint.String(), string(body), tencentContentType, headers)
	if err != nil {
		return nil, fmt.Errorf("tencent %s: %w", action, err)
	}
	if err := res.statusError(); err != nil {
		return nil, fmt.Errorf("tencent %s: %w", action, err)
	}
	var out tencentEnvelope
	if err := res.decodeJSON(&out); err != nil {
		return nil, fmt.Errorf("tencent %s: %w", action, err)
	}
	if out.Response.Error != nil {
		if out.Response.Error.Code == tencentNoDataCode {
			// The first issuance for a name always lands here: the API reports
			// the empty list as an error. Treat it as "no record found" so the
			// caller creates the TXT record instead of failing the renewal.
			out.Response.Error = nil
			out.Response.RecordList = nil
			return &out, nil
		}
		return nil, fmt.Errorf("tencent %s failed: %s %s", action,
			out.Response.Error.Code, sanitize(out.Response.Error.Message, p.creds, summaryLimit))
	}
	return &out, nil
}

// find returns the record of the given type and line, or nil when it does not
// exist. A nil line matches the provider default line.
func (p *tencentProvider) find(ctx context.Context, domain, sub, typ, line string) (*tencentRecord, error) {
	out, err := p.call(ctx, "DescribeRecordList", map[string]any{
		"Domain":     domain,
		"Subdomain":  sub,
		"RecordType": typ,
		"Limit":      100,
	})
	if err != nil {
		return nil, err
	}
	for i := range out.Response.RecordList {
		item := out.Response.RecordList[i]
		if !strings.EqualFold(item.Type, typ) {
			continue
		}
		if line != "" && item.Line != "" && item.Line != line {
			continue
		}
		return &item, nil
	}
	return nil, nil
}

func (p *tencentProvider) Set(ctx context.Context, rec Record) error {
	if strings.TrimSpace(rec.Value) == "" {
		return fmt.Errorf("tencent: record value is empty")
	}
	domain := rootDomain(rec.Domain)
	sub := recordName(rec)
	typ := normalizeType(rec.Type)
	line := strings.TrimSpace(rec.Line)
	if line == "" {
		line = "默认"
	}
	existing, err := p.find(ctx, domain, sub, typ, line)
	if err != nil {
		return err
	}
	if existing != nil && existing.Value == rec.Value {
		return nil
	}
	payload := map[string]any{
		"Domain":     domain,
		"Subdomain":  sub,
		"RecordType": typ,
		"RecordLine": line,
		"Value":      rec.Value,
		"TTL":        ttlOr(rec, 600),
	}
	if existing == nil {
		_, err = p.call(ctx, "CreateRecord", payload)
		return err
	}
	payload["RecordId"] = existing.RecordID
	_, err = p.call(ctx, "ModifyRecord", payload)
	return err
}

func (p *tencentProvider) Delete(ctx context.Context, rec Record) error {
	line := strings.TrimSpace(rec.Line)
	existing, err := p.find(ctx, rootDomain(rec.Domain), recordName(rec), normalizeType(rec.Type), line)
	if err != nil {
		return err
	}
	if existing == nil {
		return nil
	}
	_, err = p.call(ctx, "DeleteRecord", map[string]any{
		"Domain":   rootDomain(rec.Domain),
		"RecordId": existing.RecordID,
	})
	return err
}

// tc3Authorization builds the Authorization header of a Tencent Cloud API 3.0
// request (TC3-HMAC-SHA256).
// tc3CanonicalRequest is the canonical request of a TC3-HMAC-SHA256 POST.
func tc3CanonicalRequest(host, body string) string {
	canonicalHeaders := "content-type:" + tencentContentType + "\n" +
		"host:" + host + "\n"
	return "POST\n/\n\n" + canonicalHeaders + "\n" + tencentSignedHeaders + "\n" + sha256Hex(body)
}

func tc3Authorization(secretID, secretKey, service, host string, ts int64, body string) string {
	date := time.Unix(ts, 0).UTC().Format("2006-01-02")
	canonicalRequest := tc3CanonicalRequest(host, body)
	scope := date + "/" + service + "/tc3_request"
	stringToSign := "TC3-HMAC-SHA256\n" + strconv.FormatInt(ts, 10) + "\n" + scope + "\n" + sha256Hex(canonicalRequest)

	key := hmacSHA256([]byte("TC3"+secretKey), date)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "tc3_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))
	return "TC3-HMAC-SHA256 Credential=" + secretID + "/" + scope +
		", SignedHeaders=" + tencentSignedHeaders + ", Signature=" + signature
}

func hmacSHA256(key []byte, message string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return mac.Sum(nil)
}

func sha256Hex(message string) string {
	sum := sha256.Sum256([]byte(message))
	return hex.EncodeToString(sum[:])
}
