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

// acmeChallengePrefix is the well known path an ACME CA queries for http-01.
const acmeChallengePrefix = "/.well-known/acme-challenge/"

// ServeChallenge answers one active http-01 token. It reports whether the path
// belongs to a challenge this module is validating right now.
func (a *ACME) ServeChallenge(w http.ResponseWriter, r *http.Request) bool {
	value, ok := a.challenges.Load(r.URL.Path)
	if !ok {
		return false
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(value.(string)))
	return true
}

// webServesChallenges reports whether the web service is running, in which case
// it routes the well known challenge path to ServeChallenge and the standalone
// listener is not needed.
func (a *ACME) webServesChallenges() bool {
	if a.deps == nil || a.deps.Registry == nil {
		return false
	}
	mod, ok := a.deps.Registry.Get("web")
	if !ok {
		return false
	}
	return mod.Status().Running
}

// startHTTP01 answers one http-01 challenge.
//
// The answer is registered in memory first. When the web service already owns
// port 80 (the usual deployment: a web rule listens on :80) the request is
// served by that listener and no second server is started. The temporary
// listener below is only the fallback for a deployment that leaves port 80 free.
func (a *ACME) startHTTP01(client *acme.Client, chal *acme.Challenge, domain string) (func(), error) {
	if client == nil || chal == nil {
		return nil, fmt.Errorf("http-01 challenge is incomplete")
	}
	response, err := client.HTTP01ChallengeResponse(chal.Token)
	if err != nil {
		return nil, fmt.Errorf("build http-01 response: %w", err)
	}
	path := client.HTTP01ChallengePath(chal.Token)
	a.challenges.Store(path, response)
	drop := func() { a.challenges.Delete(path) }

	ln, err := net.Listen("tcp", ":80")
	if err != nil {
		if a.webServesChallenges() {
			// The web listeners answer the challenge; keep the answer registered
			// for the whole validation and let the caller drop it afterwards.
			return drop, nil
		}
		drop()
		return nil, fmt.Errorf("listen on port 80 for the http-01 challenge of %s: %w (another service, for example the web module, may already use port 80)", domain, err)
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(response))
	})
	srv := &http.Server{
		Handler:           handler,
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
		drop()
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
