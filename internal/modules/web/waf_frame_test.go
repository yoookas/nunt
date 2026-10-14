package web

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/modules/waf"
)

// These tests run the gRPC request body policy of the WAF module through the
// real reverse proxy: the middleware, the h2c and TLS HTTP/2 paths of the web
// service and the error handler of the proxy (T10 of
// docs/PLAN-waf-body-policy.md).

// attack is a payload the bundled rule set refuses at paranoia level 1.
const attack = "user=admin&pass=1' OR '1'='1"

// cleanPayload is a payload without any rule match.
const cleanPayload = "user=nunt&pass=correct-horse-battery-staple"

// grpcFrame builds one gRPC frame around a payload.
func grpcFrame(payload []byte) []byte {
	out := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[5:], payload)
	return out
}

// grpcFrameWithFlags builds a frame with an explicit flags byte.
func grpcFrameWithFlags(flags byte, payload []byte) []byte {
	out := grpcFrame(payload)
	out[0] = flags
	return out
}

// grpcStatusOf reads the gRPC status of an answer, from the headers or from the
// trailers of the stream.
func grpcStatusOf(resp *http.Response) string {
	_, _ = io.Copy(io.Discard, resp.Body)
	if v := resp.Header.Get("Grpc-Status"); v != "" {
		return v
	}
	return resp.Trailer.Get("Grpc-Status")
}

// wafConfigStore builds a configuration store with the firewall enabled and the
// given body enforcement mode.
func wafConfigStore(t *testing.T, mode string, rules ...model.WebRule) *config.Store {
	t.Helper()
	store := testConfigStore(t, rules...)
	if err := store.Update(func(c *model.Config) error {
		c.WAF = model.WAFConfig{
			Enable:            true,
			Mode:              model.WAFModeBlock,
			UseCRS:            true,
			ParanoiaLevel:     1,
			ExecutingLevel:    1,
			InboundThreshold:  5,
			OutboundThreshold: 4,
			BodyLimitKB:       128,
			EnforcementMode:   mode,
			DefaultBodyPolicy: model.WAFBodyFull,
			PeekBytes:         65536,
			PeekTimeoutMS:     200,
		}
		return nil
	}); err != nil {
		t.Fatalf("waf configuration: %v", err)
	}
	return store
}

// grpcRule builds a proxy rule that protects a gRPC backend over h2c.
func grpcRule(t *testing.T, addr, upstream, policy string) model.WebRule {
	t.Helper()
	rule := mkRule(t, "grpc-"+policy, "grpc.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.WAF = true
	rule.BodyPolicy = policy
	rule.Proxy = &model.ProxyTarget{Targets: []string{upstream}, H2C: true}
	return rule
}

// grpcBackend is a cleartext HTTP/2 upstream that counts the calls it serves.
func grpcBackend(t *testing.T, calls *atomic.Int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h2c.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		// A gRPC server reads the whole request before it answers.
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/grpc")
		w.WriteHeader(http.StatusOK)
	}), &http2.Server{}))
	t.Cleanup(srv.Close)
	return srv
}

// h2cClient speaks cleartext HTTP/2, which is what a native gRPC client does.
func h2cClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, Transport: &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, address string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
		},
	}}
}

// postGRPC sends one gRPC request through the listener.
func postGRPC(t *testing.T, client *http.Client, addr string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1"+addr+"/pkg.Service/Method", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build the request: %v", err)
	}
	req.Host = "grpc.example.com"
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("Te", "trailers")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	return resp
}

// startWAFModule brings the web module up with the given configuration.
//
// The web module does not own the firewall: it shares the instance registered in
// module.Deps.Registry, exactly like the application does. The registry owns the
// lifecycle, so the firewall is started from there, before the web module.
func startWAFModule(t *testing.T, store *config.Store) *Web {
	t.Helper()
	return startWAFModuleWith(t, testDeps(t, store))
}

// startWAFModuleWith is startWAFModule for a test that prepared the
// dependencies itself (a custom certificate, for instance).
func startWAFModuleWith(t *testing.T, deps *module.Deps) *Web {
	t.Helper()
	firewall := registryWAF(t, deps)
	w := New(deps)
	if w.waf != firewall {
		t.Fatal("the web module must share the firewall registered in the registry")
	}
	if err := firewall.Start(context.Background()); err != nil {
		t.Fatalf("start the firewall: %v", err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = w.Stop(context.Background())
		_ = firewall.Stop(context.Background())
	})
	return w
}

// registryWAF returns the firewall the registry holds. It fails the test when
// the module is missing, so a wiring mistake cannot silently disable the tests.
func registryWAF(t *testing.T, deps *module.Deps) *waf.WAF {
	t.Helper()
	if deps == nil || deps.Registry == nil {
		t.Fatal("the test dependencies carry no registry")
	}
	mod, ok := deps.Registry.Get("waf")
	if !ok {
		t.Fatal("the registry holds no waf module")
	}
	firewall, ok := mod.(*waf.WAF)
	if !ok {
		t.Fatalf("the registry holds %T, want *waf.WAF", mod)
	}
	return firewall
}

// TestWAFGRPCAttackIsRefusedOverH2C is T1 over cleartext HTTP/2: the upstream
// must never be called.
func TestWAFGRPCAttackIsRefusedOverH2C(t *testing.T) {
	var calls atomic.Int64
	backend := grpcBackend(t, &calls)

	addr := freeAddr(t)
	rule := grpcRule(t, addr, backend.URL, model.WAFBodyGRPCUnary)
	w := startWAFModule(t, wafConfigStore(t, model.WAFEnforceEnforce, rule))

	resp := postGRPC(t, h2cClient(), addr, grpcFrame([]byte(attack)))
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := grpcStatusOf(resp); got != "7" {
		t.Fatalf("grpc-status = %q, want 7", got)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("the upstream served %d calls, want 0", n)
	}
	if resp.ProtoMajor != 2 {
		t.Fatalf("client protocol = %s, want HTTP/2", resp.Proto)
	}
	stats := w.waf.Stats()
	states, _ := stats["bodyStates"].(map[string]int64)
	if states["grpc-unary"] != 1 {
		t.Fatalf("bodyStates = %v, want one grpc-unary request", states)
	}
}

// TestWAFGRPCStreamOverTLS is T3 over TLS: the first message is inspected, the
// rest of the stream is forwarded frame by frame.
func TestWAFGRPCStreamOverTLS(t *testing.T) {
	var calls atomic.Int64
	backend := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/grpc")
		w.WriteHeader(http.StatusOK)
	}))
	backend.EnableHTTP2 = true
	backend.StartTLS()
	defer backend.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "grpc-stream", "grpc.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.WAF = true
	rule.BodyPolicy = model.WAFBodyGRPCStream
	rule.Proxy = &model.ProxyTarget{Targets: []string{backend.URL}, InsecureTLS: true}
	rule.TLS = model.WebTLS{Mode: model.TLSModeCustom, CertID: "grpc.example.com"}

	store := wafConfigStore(t, model.WAFEnforceEnforce, rule)
	deps := testDeps(t, store)
	certPEM, keyPEM := selfSignedPair(t, "grpc.example.com")
	if _, err := deps.Certs.Add([]string{"grpc.example.com"}, certPEM, keyPEM, "upload", "", false); err != nil {
		t.Fatalf("add certificate: %v", err)
	}
	w := startWAFModuleWith(t, deps)
	_ = w

	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http2.Transport{
			TLSClientConfig: &tls.Config{
				ServerName:         "grpc.example.com",
				InsecureSkipVerify: true, // #nosec G402 - self signed test certificate
				NextProtos:         []string{"h2"},
			},
		},
	}
	body := append(grpcFrame([]byte(cleanPayload)), grpcFrame([]byte(attack))...)
	req, err := http.NewRequest(http.MethodPost, "https://127.0.0.1"+addr+"/pkg.Service/Method", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build the request: %v", err)
	}
	req.Host = "grpc.example.com"
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("Te", "trailers")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("the upstream served %d calls, want 1", n)
	}
	stats := w.waf.Stats()
	states, _ := stats["bodyStates"].(map[string]int64)
	if states["grpc-stream"] != 1 {
		t.Fatalf("bodyStates = %v, want one grpc-stream request", states)
	}
}

// TestWAFGRPCSecondMessageReachesTheErrorHandler is T2 over h2c: the frame that
// follows the first message is refused by the proxy error handler, which answers
// with a gRPC status instead of a proxy error.
func TestWAFGRPCSecondMessageReachesTheErrorHandler(t *testing.T) {
	var calls atomic.Int64
	backend := grpcBackend(t, &calls)

	addr := freeAddr(t)
	rule := grpcRule(t, addr, backend.URL, model.WAFBodyGRPCUnary)
	startWAFModule(t, wafConfigStore(t, model.WAFEnforceEnforce, rule))

	body := append(grpcFrame([]byte(cleanPayload)), grpcFrame([]byte(cleanPayload))...)
	resp := postGRPC(t, h2cClient(), addr, body)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := grpcStatusOf(resp); got != "7" {
		t.Fatalf("grpc-status = %q, want 7", got)
	}
	// The first message is passed on, but refusing the frame that follows
	// aborts the stream: the upstream handler may be reset before it runs.
	if n := calls.Load(); n > 1 {
		t.Fatalf("the upstream served %d calls, want at most 1", n)
	}
}

// TestWAFGRPCMalformedFrameReachesTheErrorHandler covers the frame layer of a
// streaming route: the proxy error handler answers with RESOURCE_EXHAUSTED.
func TestWAFGRPCMalformedFrameReachesTheErrorHandler(t *testing.T) {
	var calls atomic.Int64
	backend := grpcBackend(t, &calls)

	addr := freeAddr(t)
	rule := grpcRule(t, addr, backend.URL, model.WAFBodyGRPCStream)
	startWAFModule(t, wafConfigStore(t, model.WAFEnforceEnforce, rule))

	body := append(grpcFrame([]byte(cleanPayload)), grpcFrameWithFlags(2, []byte(cleanPayload))...)
	resp := postGRPC(t, h2cClient(), addr, body)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := grpcStatusOf(resp); got != "8" {
		t.Fatalf("grpc-status = %q, want 8", got)
	}
	// The failure is detected while the body is written, which resets the
	// upstream stream: its handler may or may not have run by then.
	if n := calls.Load(); n > 1 {
		t.Fatalf("the upstream served %d calls, want at most 1", n)
	}
}

// TestWAFGRPCCleanUnaryIsForwarded proves a clean message is not disturbed: the
// upstream receives the frame byte for byte.
func TestWAFGRPCCleanUnaryIsForwarded(t *testing.T) {
	var calls atomic.Int64
	var got atomic.Value
	backend := httptest.NewServer(h2c.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		data, _ := io.ReadAll(r.Body)
		got.Store(data)
		w.Header().Set("Content-Type", "application/grpc")
		w.WriteHeader(http.StatusOK)
	}), &http2.Server{}))
	defer backend.Close()

	addr := freeAddr(t)
	rule := grpcRule(t, addr, backend.URL, model.WAFBodyGRPCUnary)
	startWAFModule(t, wafConfigStore(t, model.WAFEnforceEnforce, rule))

	frame := grpcFrame([]byte(cleanPayload))
	resp := postGRPC(t, h2cClient(), addr, frame)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	if n := calls.Load(); n != 1 {
		t.Fatalf("the upstream served %d calls, want 1", n)
	}
	data, _ := got.Load().([]byte)
	if !bytes.Equal(data, frame) {
		t.Fatalf("the upstream read %q, want %q", data, frame)
	}
	if got := resp.Header.Get("Grpc-Status"); got != "" {
		t.Fatalf("a forwarded call must not carry a local grpc-status: %q", got)
	}
}

// TestWAFChunkedUploadUnderTheFullPolicy is T6 through the real proxy: the
// request is refused before the upstream is contacted.
func TestWAFChunkedUploadUnderTheFullPolicy(t *testing.T) {
	var calls atomic.Int64
	backend := grpcBackend(t, &calls)

	addr := freeAddr(t)
	rule := mkRule(t, "upload", "app.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.WAF = true
	rule.BodyPolicy = model.WAFBodyFull
	rule.Proxy = &model.ProxyTarget{Targets: []string{backend.URL}, H2C: true}
	startWAFModule(t, wafConfigStore(t, model.WAFEnforceEnforce, rule))

	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1"+addr+"/upload", io.NopCloser(strings.NewReader(cleanPayload)))
	if err != nil {
		t.Fatalf("build the request: %v", err)
	}
	req.Host = "app.example.com"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.ContentLength = -1
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusLengthRequired {
		t.Fatalf("status = %d, want 411", resp.StatusCode)
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("the upstream served %d calls, want 0", n)
	}
}

// bodyStateCount reads one body policy counter out of the module statistics.
func bodyStateCount(t *testing.T, stats map[string]any, state string) int64 {
	t.Helper()
	states, ok := stats["bodyStates"].(map[string]int64)
	if !ok {
		t.Fatalf("bodyStates is missing from the statistics: %v", stats)
	}
	return states[state]
}

// TestWAFBodyPolicyCountersReachTheRegistry is the regression test for the two
// firewall instances: the rule level accounting used to land on an instance the
// admin API never reads, so the WAF page always showed zero. The request goes
// through a static rule whose WAF flag is set and the counters must show up on
// the instance held by the registry.
func TestWAFBodyPolicyCountersReachTheRegistry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}

	addr := freeAddr(t)
	rule := mkRule(t, "waf-static", "app.example.com", "/", 0, model.WebTypeStatic)
	rule.Listen = []string{addr}
	rule.WAF = true
	rule.BodyPolicy = model.WAFBodyFull
	rule.Static = &model.StaticTgt{Root: root, Listing: true}

	deps := testDeps(t, wafConfigStore(t, model.WAFEnforceObserve, rule))
	firewall := registryWAF(t, deps)
	w := startWAFModuleWith(t, deps)
	if w.waf != firewall {
		t.Fatal("the web module shares no firewall with the registry")
	}

	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1"+addr+"/upload", io.NopCloser(strings.NewReader(cleanPayload)))
	if err != nil {
		t.Fatalf("build the request: %v", err)
	}
	req.Host = "app.example.com"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// A declared length of -1 is what a chunked request carries: the policy
	// cannot size it, so observe mode records the refusal instead of enforcing it.
	req.ContentLength = -1
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusLengthRequired {
		t.Fatal("observe mode must not refuse the request with 411")
	}

	// The counters of the registry instance must describe the rule traffic.
	stats := firewall.Stats()
	if n := bodyStateCount(t, stats, "peeked"); n < 1 {
		t.Fatalf("bodyStates[peeked] = %d on the registry instance, want at least 1", n)
	}
	if n, _ := stats["wouldReject"].(int64); n < 1 {
		t.Fatalf("wouldReject = %v on the registry instance, want at least 1", stats["wouldReject"])
	}
}
