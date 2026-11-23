// Package httpc builds the outbound HTTP clients used by DDNS providers,
// ACME and DNS providers.
package httpc

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// New returns a client with conservative timeouts and connection reuse.
func New(timeout time.Duration, insecureSkipVerify bool) *http.Client {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 2 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	if insecureSkipVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 - explicit opt-in
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

// Default is a shared client for short requests.
var Default = New(20*time.Second, false)

// Request describes a simple outbound call.
type Request struct {
	Method      string
	URL         string
	Headers     map[string]string
	Body        string
	ContentType string
	BasicUser   string
	BasicPass   string
	Client      *http.Client
	Timeout     time.Duration
}

// Do performs the request and returns status code and body (bounded).
func Do(ctx context.Context, req Request) (int, []byte, error) {
	client := req.Client
	if client == nil {
		client = Default
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, req.URL, body)
	if err != nil {
		return 0, nil, fmt.Errorf("build request: %w", err)
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	if req.ContentType != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	if req.BasicUser != "" || req.BasicPass != "" {
		httpReq.SetBasicAuth(req.BasicUser, req.BasicPass)
	}
	if httpReq.Header.Get("User-Agent") == "" {
		httpReq.Header.Set("User-Agent", "nunt/1.0 (+https://github.com/nunt/nunt)")
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read response: %w", err)
	}
	return resp.StatusCode, data, nil
}

// GetJSON performs a GET and decodes the JSON response into out.
func GetJSON(ctx context.Context, url string, headers map[string]string, out any) error {
	code, data, err := Do(ctx, Request{Method: http.MethodGet, URL: url, Headers: headers})
	if err != nil {
		return err
	}
	if code < 200 || code > 299 {
		return fmt.Errorf("unexpected status %d: %s", code, truncate(string(data), 200))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode json: %w", err)
	}
	return nil
}

// PublicIPServices are queried in order to discover the public address.
var PublicIPServices = map[string][]string{
	"4": {
		"https://api.ipify.org",
		"https://ipv4.icanhazip.com",
		"https://ifconfig.co/ip",
		"https://myip.ipip.net/s",
	},
	"6": {
		"https://api6.ipify.org",
		"https://ipv6.icanhazip.com",
		"https://ifconfig.co/ip",
	},
}

// PublicIP asks external services for the public address of the given family
// ("4" or "6").
func PublicIP(ctx context.Context, family string, extraURLs []string) (string, error) {
	urls := append([]string{}, extraURLs...)
	urls = append(urls, PublicIPServices[family]...)
	var lastErr error
	for _, u := range urls {
		code, data, err := Do(ctx, Request{Method: http.MethodGet, URL: u, Timeout: 8 * time.Second})
		if err != nil {
			lastErr = err
			continue
		}
		if code != http.StatusOK {
			lastErr = fmt.Errorf("%s returned %d", u, code)
			continue
		}
		text := strings.TrimSpace(string(data))
		if i := strings.IndexAny(text, " \n\r\t"); i > 0 {
			text = text[:i]
		}
		text = strings.TrimSpace(text)
		if net.ParseIP(text) == nil {
			lastErr = fmt.Errorf("%s returned %q which is not an ip", u, truncate(text, 60))
			continue
		}
		return text, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no ip service configured")
	}
	return "", lastErr
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
