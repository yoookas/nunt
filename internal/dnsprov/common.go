package dnsprov

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/httpc"
)

// providerTimeout bounds every outbound call made by a provider.
const providerTimeout = 20 * time.Second

// summaryLimit is the number of response bytes echoed back in errors.
const summaryLimit = 200

// base is embedded by every HTTP based provider. It carries the shared client
// and the credential map so providers can redact secrets from error output.
type base struct {
	client *http.Client
	creds  Credentials
}

func newBase(creds Credentials) base {
	return base{client: httpc.New(providerTimeout, false), creds: creds}
}

// cred returns a trimmed credential value.
func (b base) cred(key string) string {
	return strings.TrimSpace(b.creds[key])
}

// firstCred returns the first non empty credential among keys.
func (b base) firstCred(keys ...string) string {
	for _, key := range keys {
		if v := b.cred(key); v != "" {
			return v
		}
	}
	return ""
}

// result describes one HTTP exchange.
type result struct {
	Status int
	Body   []byte
}

// Text returns the body as a trimmed string.
func (r result) Text() string { return strings.TrimSpace(string(r.Body)) }

// summary returns a short redacted digest of the response body.
func (r result) summary() string {
	return sanitize(string(r.Body), nil, summaryLimit)
}

// decodeJSON unmarshals the response body into out.
func (r result) decodeJSON(out any) error {
	if err := json.Unmarshal(r.Body, out); err != nil {
		return fmt.Errorf("decode json: %w", err)
	}
	return nil
}

// call performs one request through internal/httpc.
func (b base) call(ctx context.Context, in httpc.Request) (result, error) {
	if in.Client == nil {
		in.Client = b.client
	}
	if in.Timeout <= 0 {
		in.Timeout = providerTimeout
	}
	status, body, err := httpc.Do(ctx, in)
	if err != nil {
		return result{}, err
	}
	return result{Status: status, Body: body}, nil
}

// req performs one request through internal/httpc and returns the result
// without inspecting the status code.
func (b base) req(ctx context.Context, method, endpoint, payload string, contentType string, headers map[string]string) (result, error) {
	return b.call(ctx, httpc.Request{
		Method:      method,
		URL:         endpoint,
		Headers:     headers,
		Body:        payload,
		ContentType: contentType,
	})
}

// callJSON performs a request carrying a JSON payload.
func (b base) callJSON(ctx context.Context, method, url string, payload any, headers map[string]string) (result, error) {
	body := ""
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return result{}, fmt.Errorf("encode request: %w", err)
		}
		body = string(raw)
	}
	res, err := b.call(ctx, httpc.Request{
		Method:      method,
		URL:         url,
		Headers:     headers,
		Body:        body,
		ContentType: "application/json",
	})
	if err != nil {
		return res, err
	}
	return res, res.statusError()
}

// callForm performs a request with an url encoded form body.
func (b base) callForm(ctx context.Context, method, endpoint string, form map[string]string, headers map[string]string) (result, error) {
	values := make([]string, 0, len(form))
	for k, v := range form {
		values = append(values, url.QueryEscape(k)+"="+url.QueryEscape(v))
	}
	sort.Strings(values)
	return b.call(ctx, httpc.Request{
		Method:      method,
		URL:         endpoint,
		Headers:     headers,
		Body:        strings.Join(values, "&"),
		ContentType: "application/x-www-form-urlencoded",
	})
}

// statusError reports a non 2xx response with a redacted body digest.
func (r result) statusError() error {
	if r.Status >= 200 && r.Status <= 299 {
		return nil
	}
	msg := fmt.Sprintf("unexpected status %d", r.Status)
	if digest := r.summary(); digest != "" {
		msg += ": " + digest
	}
	return fmt.Errorf("%s", msg)
}

// sanitize trims a text for error output: whitespace collapses, secrets from
// the credential map are replaced by ***, and the result is truncated.
func sanitize(text string, creds Credentials, limit int) string {
	clean := strings.Join(strings.Fields(text), " ")
	for _, secret := range secretValues(creds) {
		clean = redact(clean, secret)
	}
	return truncateRunes(clean, limit)
}

// secretValues collects the credential values worth hiding in error output.
func secretValues(creds Credentials) []string {
	if len(creds) == 0 {
		return nil
	}
	out := make([]string, 0, len(creds)*2)
	for _, v := range creds {
		v = strings.TrimSpace(v)
		if len(v) < 3 {
			continue
		}
		out = append(out, v, url.QueryEscape(v))
	}
	return out
}

func redact(text, secret string) string {
	// A very short secret would redact unrelated text.
	if len(secret) < 3 || !strings.Contains(text, secret) {
		return text
	}
	return strings.ReplaceAll(text, secret, "***")
}

func truncateRunes(s string, limit int) string {
	if limit <= 0 || len(s) <= limit {
		return s
	}
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return strings.TrimSpace(string(runes[:limit])) + "..."
}

// jsonUnmarshal decodes a raw JSON payload, tolerating an empty body.
func jsonUnmarshal(raw []byte, out any) error {
	if len(raw) == 0 {
		return fmt.Errorf("empty response body")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode json: %w", err)
	}
	return nil
}

// rootDomain strips "www." like decorations from a user supplied domain so
// zone lookups can succeed when a full host name was entered.
func rootDomain(domain string) string {
	d := strings.Trim(strings.TrimSpace(domain), ".")
	return strings.TrimPrefix(strings.ToLower(d), "*.")
}

// normalizeType upper cases a record type.
func normalizeType(t string) string {
	out := strings.ToUpper(strings.TrimSpace(t))
	if out == "" {
		return "A"
	}
	return out
}

// recordName returns the name relative to the zone as most APIs expect it
// ("@" for the zone apex).
func recordName(rec Record) string {
	sub := strings.Trim(strings.TrimSpace(rec.SubDomain), ".")
	if sub == "" {
		return "@"
	}
	return sub
}

// absoluteName returns the lower case full record name without the "@"
// shorthand, which is what the vendor APIs expect.
func absoluteName(rec Record) string {
	name := strings.ToLower(rec.FQDN())
	if name == "" {
		return "@"
	}
	return name
}

// ttlOr returns the record TTL, or fallback when unset.
func ttlOr(rec Record, fallback int) int {
	if rec.TTL > 0 {
		return rec.TTL
	}
	return fallback
}

// escapeHost percent encodes a DNS name for use inside a URL path. The
// wildcard label is escaped because a bare "*" is not a valid path segment.
func escapeHost(name string) string {
	return strings.ReplaceAll(strings.ReplaceAll(name, "*", "%2A"), " ", "%20")
}

// randomNonce returns a hex string suitable for request nonces.
func randomNonce() string {
	buf := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buf)
}

// successText reports whether a plain text provider answer means success.
func successText(body string, okTokens []string) bool {
	lower := strings.ToLower(strings.TrimSpace(body))
	if lower == "" {
		return false
	}
	for _, bad := range []string{"error", "failed", "failure", "invalid", "denied", "unauthor", "abuse", "badauth", "nohost", "notfound", "not found"} {
		if strings.Contains(lower, bad) {
			return false
		}
	}
	for _, token := range okTokens {
		if strings.Contains(lower, strings.ToLower(token)) {
			return true
		}
	}
	return false
}
