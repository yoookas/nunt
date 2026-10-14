package acme

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
)

// challengeServerTimeout bounds every read/write of the temporary servers used
// during challenge validation.
const challengeServerTimeout = 15 * time.Second

// startHTTP01 answers one http-01 challenge on port 80.
//
// The CA connects to http://<domain>/.well-known/acme-challenge/<token>, so a
// minimal server is started for the duration of the validation. A bind failure
// is reported with the underlying error because it almost always means another
// process (the web service) already owns port 80.
func startHTTP01(client *acme.Client, chal *acme.Challenge, domain string) (func(), error) {
	if client == nil || chal == nil {
		return nil, fmt.Errorf("http-01 challenge is incomplete")
	}
	response, err := client.HTTP01ChallengeResponse(chal.Token)
	if err != nil {
		return nil, fmt.Errorf("build http-01 response: %w", err)
	}
	path := client.HTTP01ChallengePath(chal.Token)

	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(response))
	})

	ln, err := net.Listen("tcp", ":80")
	if err != nil {
		return nil, fmt.Errorf("listen on port 80 for the http-01 challenge of %s: %w (another service, for example the web module, may already use port 80)", domain, err)
	}
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: challengeServerTimeout,
		ReadTimeout:       challengeServerTimeout,
		WriteTimeout:      challengeServerTimeout,
		IdleTimeout:       challengeServerTimeout,
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		// The listener is closed by the cleanup function, so Serve always ends
		// with http.ErrServerClosed.
		_ = srv.Serve(ln)
	}()

	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	return cleanup, nil
}

// startTLSALPN01 serves one tls-alpn-01 challenge on port 443.
//
// The CA opens a TLS connection with SNI set to the domain and the
// "acme-tls/1" ALPN protocol; the answer is a self signed certificate that
// carries the challenge digest in a critical extension.
func startTLSALPN01(client *acme.Client, chal *acme.Challenge, domain string) (func(), error) {
	if client == nil || chal == nil {
		return nil, fmt.Errorf("tls-alpn-01 challenge is incomplete")
	}
	cert, err := client.TLSALPN01ChallengeCert(chal.Token, domain)
	if err != nil {
		return nil, fmt.Errorf("build tls-alpn-01 certificate for %s: %w", domain, err)
	}
	ln, err := net.Listen("tcp", ":443")
	if err != nil {
		return nil, fmt.Errorf("listen on port 443 for the tls-alpn-01 challenge of %s: %w (the port must be reachable from the internet; stop the web listener on 443 while validating)", domain, err)
	}
	tlsLn := tls.NewListener(ln, &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{acme.ALPNProto},
		MinVersion:   tls.VersionTLS12,
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := tlsLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				_ = c.SetDeadline(time.Now().Add(challengeServerTimeout))
				if tlsConn, ok := c.(*tls.Conn); ok {
					_ = tlsConn.HandshakeContext(context.Background())
				}
			}(conn)
		}
	}()

	cleanup := func() {
		_ = tlsLn.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
	return cleanup, nil
}

// reverseName joins DNS labels in the order used by zone files.
func reverseName(labels []string) string {
	out := make([]string, 0, len(labels))
	for i := len(labels) - 1; i >= 0; i-- {
		out = append(out, labels[i])
	}
	return strings.Join(out, ".")
}
