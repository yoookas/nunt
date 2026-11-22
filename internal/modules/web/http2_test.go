package web

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/modules/waf"
	"github.com/nunt/nunt/internal/mounts"
	"github.com/nunt/nunt/internal/secret"
)

// testDeps wires the minimum a web module needs. The firewall is registered
// exactly like the application does it, and before the web module is built: the
// web module shares the instance of the registry instead of building its own.
func testDeps(t *testing.T, store *config.Store) *module.Deps {
	t.Helper()
	box, err := secret.Open(filepath.Join(filepath.Dir(store.Path()), "secret.key"))
	if err != nil {
		t.Fatal(err)
	}
	certStore, err := certs.Open(filepath.Join(filepath.Dir(store.Path()), "certs"))
	if err != nil {
		t.Fatal(err)
	}
	deps := &module.Deps{
		Cfg:      store,
		Certs:    certStore,
		Mounts:   mounts.New(store, box, nil),
		DataDir:  filepath.Dir(store.Path()),
		Registry: module.NewRegistry(),
	}
	if err := deps.Registry.Register(waf.New(deps)); err != nil {
		t.Fatalf("register the firewall: %v", err)
	}
	return deps
}

// TestH2CClientIsAccepted proves that a cleartext HTTP/2 client (the transport
// native gRPC uses without TLS) can reach a virtual host.
func TestH2CClientIsAccepted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream ok")
	}))
	defer upstream.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "h2c-in", "h2c.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}}

	w := New(testDeps(t, testConfigStore(t, rule)))
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })

	client := &http.Client{Transport: &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, address string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
		},
	}}
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1"+addr+"/grpc", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "h2c.example.com"
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("h2c request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "upstream ok" {
		t.Fatalf("h2c response = %d %q", resp.StatusCode, body)
	}
	if resp.ProtoMajor != 2 {
		t.Fatalf("client protocol = %s, want HTTP/2", resp.Proto)
	}
}

// TestH2CUpstream proves that a rule with the h2c option talks HTTP/2 to a
// cleartext upstream, which is what a plain gRPC backend speaks.
func TestH2CUpstream(t *testing.T) {
	var upstreamProto string
	upstream := httptest.NewServer(h2c.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamProto = r.Proto
		_, _ = io.WriteString(w, "grpc backend")
	}), &http2.Server{}))
	defer upstream.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "h2c-out", "grpc.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, H2C: true}

	w := New(testDeps(t, testConfigStore(t, rule)))
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })

	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1"+addr+"/pkg.Service/Method", strings.NewReader("payload"))
	req.Host = "grpc.example.com"
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "grpc backend" {
		t.Fatalf("response = %d %q", resp.StatusCode, body)
	}
	if upstreamProto != "HTTP/2.0" {
		t.Fatalf("upstream protocol = %q, want HTTP/2.0", upstreamProto)
	}
}

// TestGRPCOverTLS proves the end to end HTTP/2 path gRPC uses with TLS:
// ALPN negotiates h2 on the listener and the proxy speaks h2 to the backend.
func TestGRPCOverTLS(t *testing.T) {
	var upstreamProto string
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamProto = r.Proto
		w.Header().Set("Content-Type", "application/grpc")
		w.WriteHeader(http.StatusOK)
	}))
	upstream.EnableHTTP2 = true
	upstream.StartTLS()
	defer upstream.Close()

	addr := freeAddr(t)
	rule := mkRule(t, "grpc", "grpc.example.com", "/", 0, model.WebTypeProxy)
	rule.Listen = []string{addr}
	rule.Proxy = &model.ProxyTarget{Targets: []string{upstream.URL}, InsecureTLS: true}
	rule.TLS = model.WebTLS{Mode: model.TLSModeCustom, CertID: "grpc.example.com"}

	store := testConfigStore(t, rule)
	deps := testDeps(t, store)
	certPEM, keyPEM := selfSignedPair(t, "grpc.example.com")
	if _, err := deps.Certs.Add([]string{"grpc.example.com"}, certPEM, keyPEM, "upload", "", "", false); err != nil {
		t.Fatalf("add certificate: %v", err)
	}

	w := New(deps)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = w.Stop(context.Background()) })

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
	req, _ := http.NewRequest(http.MethodPost, "https://127.0.0.1"+addr+"/pkg.Service/Method", strings.NewReader("grpc-frame"))
	req.Host = "grpc.example.com"
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("grpc over tls request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if resp.ProtoMajor != 2 {
		t.Fatalf("client protocol = %s, want HTTP/2", resp.Proto)
	}
	if upstreamProto != "HTTP/2.0" {
		t.Fatalf("upstream protocol = %q, want HTTP/2.0", upstreamProto)
	}
}

// selfSignedPair returns a certificate and key for the given host.
func selfSignedPair(t *testing.T, host string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              []string{host},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}
