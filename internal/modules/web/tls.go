package web

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
)

// clientAuthFor maps the configured mode to the TLS constant. Unknown values
// behave like "off" (the normaliser already repaired them).
func clientAuthFor(mode string) (tls.ClientAuthType, bool) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case model.ClientAuthRequest:
		return tls.RequestClientCert, true
	case model.ClientAuthRequire:
		return tls.RequireAndVerifyClientCert, true
	default:
		return tls.NoClientCert, false
	}
}

// clientCAPool parses the configured PEM bundle. An empty or invalid bundle
// yields an error so the listener can refuse to start rather than silently
// accepting any client certificate.
func clientCAPool(bundle string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	rest := []byte(bundle)
	added := 0
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse client CA: %w", err)
		}
		pool.AddCert(cert)
		added++
	}
	if added == 0 {
		return nil, fmt.Errorf("client CA bundle contains no certificate")
	}
	return pool, nil
}

// acmeTimeout bounds one on demand certificate request.
const acmeTimeout = 3 * time.Minute

// acmeRetryDelay is the pause between two attempts for the same host set.
const acmeRetryDelay = 10 * time.Minute

// tlsSetup installs certificate selection on a TLS listener. The matcher and
// the plan are looked up per handshake, so adding a domain or changing the
// pinned certificate takes effect without restarting the socket.
func (w *Web) tlsSetup(nextMatcher func() *matcher, nextPlan func() *listenerPlan, cfg *tls.Config) *tls.Config {
	out := cfg.Clone()
	previousConfig := out.GetConfigForClient
	// A tls-alpn-01 handshake carries the acme-tls/1 protocol and must be
	// answered with the challenge certificate, not with a route certificate, so
	// the ACME module gets the first look at every ClientHello.
	out.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if challenge, ok := w.alpnChallengeConfig(hello); ok {
			return challenge, nil
		}
		if previousConfig != nil {
			return previousConfig(hello)
		}
		return nil, nil
	}

	fallback := out.GetCertificate
	out.GetCertificate = func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		// The TLS mode of the listener can change without rebinding the socket,
		// so the decision is made per handshake from the current plan.
		if plan := nextPlan(); plan != nil && plan.tls.mode == model.TLSModeCustom {
			return w.customCertificate(plan)
		}
		m := nextMatcher()
		if m == nil {
			return nil, fmt.Errorf("web: no configuration for this listener")
		}
		host := hostOnly(hello.ServerName)
		if r, ok := m.hosts[host]; ok {
			if cert, err := w.certificateFor(r); err == nil && cert != nil {
				return cert, nil
			}
		}
		for _, r := range m.wildcards {
			if !ruleHasWildcard(r, host) {
				continue
			}
			if cert, err := w.certificateFor(r); err == nil && cert != nil {
				return cert, nil
			}
		}
		if fallback != nil {
			return fallback(hello)
		}
		return nil, fmt.Errorf("web: no certificate for %q", hello.ServerName)
	}
	return out
}

// customCertificate returns the certificate pinned by the listener.
func (w *Web) customCertificate(plan *listenerPlan) (*tls.Certificate, error) {
	if w.deps.Certs == nil {
		return nil, fmt.Errorf("web: certificate store is unavailable")
	}
	if plan == nil || len(plan.tls.certDomains) == 0 {
		return nil, fmt.Errorf("web: the listener has no certificate")
	}
	return w.deps.Certs.GetCertificate(&tls.ClientHelloInfo{ServerName: plan.tls.certDomains[0]})
}

// certificateFor loads the certificate of one rule from the certificate store.
func (w *Web) certificateFor(r *rule) (*tls.Certificate, error) {
	// The certificate store keeps the parsed certificate and swaps it on
	// renewal, so the rule must not hold its own copy: a per rule cache raced
	// between handshakes and kept serving the old certificate after a renewal.
	if w.deps.Certs == nil {
		return nil, fmt.Errorf("web: certificate store is unavailable")
	}
	domains := r.certDomains
	if len(domains) == 0 {
		return nil, fmt.Errorf("web: rule %q has no certificate domain", r.name)
	}
	return w.deps.Certs.GetCertificate(&tls.ClientHelloInfo{ServerName: domains[0]})
}

// ruleHasWildcard reports whether a rule declares a wildcard domain matching
// the requested host.
func ruleHasWildcard(r *rule, host string) bool {
	for _, d := range r.domains {
		if wildcardMatches(d, host) {
			return true
		}
	}
	return false
}

// ensureCertificates asks the ACME module for the missing certificates of a
// listener. It never blocks a request: the work happens in the background with
// its own timeout and failures are only logged.
func (w *Web) ensureCertificates(plan *listenerPlan) {
	if plan == nil || plan.tls.mode != model.TLSModeAuto || w.deps.Registry == nil {
		return
	}
	seen := map[string]bool{}
	domains := make([]string, 0, len(plan.rules))
	for _, r := range plan.rules {
		for _, d := range r.certDomains {
			if seen[d] {
				continue
			}
			seen[d] = true
			domains = append(domains, d)
		}
	}
	if len(domains) == 0 {
		return
	}
	mod, ok := w.deps.Registry.Get("acme")
	if !ok {
		return
	}
	provider, ok := mod.(module.CertProvider)
	if !ok {
		w.logger().Debug("web: the acme module does not provide certificates")
		return
	}
	missing := make([]string, 0, len(domains))
	for _, d := range domains {
		if w.deps.Certs != nil && w.deps.Certs.Has(d) {
			continue
		}
		missing = append(missing, d)
	}
	if len(missing) == 0 {
		return
	}
	w.wg.Add(1)
	go func(domains []string) {
		defer w.wg.Done()
		var last error
		for _, d := range domains {
			ctx, cancel := context.WithTimeout(w.baseContext(), acmeTimeout)
			err := provider.EnsureCertificate(ctx, []string{d})
			cancel()
			if err != nil {
				last = err
				w.logger().Warn("web: cannot obtain a certificate", "domain", d, "error", err)
				continue
			}
			w.logger().Info("web: certificate ready", "domain", d)
		}
		if last != nil {
			w.SetError(fmt.Errorf("certificate for %s: %w", domains[0], last))
		}
	}(missing)
}

// hostOnly normalises a ServerName value.
func hostOnly(host string) string {
	return netutil.HostOnly(host)
}
