package web

import (
	"context"
	"crypto/tls"
	"fmt"
	"time"

	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
)

// acmeTimeout bounds one on demand certificate request.
const acmeTimeout = 3 * time.Minute

// acmeRetryDelay is the pause between two attempts for the same host set.
const acmeRetryDelay = 10 * time.Minute

// tlsSetup installs the per rule certificate selection on a TLS listener and
// reports the rules that need a certificate.
func (w *Web) tlsSetup(m *matcher, cfg *tls.Config) *tls.Config {
	out := cfg.Clone()
	hosts := m.hosts()
	wildcards := m.wildcardHosts()
	previousConfig := out.GetConfigForClient
	// A tls-alpn-01 handshake carries the acme-tls/1 protocol and must be
	// answered with the challenge certificate, not with a rule certificate, so
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
		host := hostOnly(hello.ServerName)
		if r, ok := hosts[host]; ok {
			cert, err := w.certificateFor(r)
			if err == nil && cert != nil {
				return cert, nil
			}
		}
		for _, r := range wildcards {
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

// certificateFor loads the certificate of one rule from the certificate store.
func (w *Web) certificateFor(r *rule) (*tls.Certificate, error) {
	if r.tls.cert != nil {
		return r.tls.cert, nil
	}
	if w.deps.Certs == nil {
		return nil, fmt.Errorf("web: certificate store is unavailable")
	}
	domains := r.tls.certDomains
	if len(domains) == 0 {
		return nil, fmt.Errorf("web: rule %q has no certificate domain", r.name)
	}
	cert, err := w.deps.Certs.GetCertificate(&tls.ClientHelloInfo{ServerName: domains[0]})
	if err != nil {
		return nil, err
	}
	r.tls.cert = cert
	return cert, nil
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
func (w *Web) ensureCertificates(m *matcher) {
	if w.deps.Registry == nil || len(m.tlsDomains) == 0 {
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
	missing := make([]string, 0, len(m.tlsDomains))
	for _, d := range m.tlsDomains {
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

// scheduleCertificate ensures the certificate of a rule that is created after
// the listener has been built.
func (w *Web) scheduleCertificate(r *rule, domains []string) {
	if len(domains) == 0 || w.deps.Registry == nil {
		return
	}
	mod, ok := w.deps.Registry.Get("acme")
	if !ok {
		return
	}
	provider, ok := mod.(module.CertProvider)
	if !ok || provider.HasCertificate(domains) {
		return
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		ctx, cancel := context.WithTimeout(w.baseContext(), acmeTimeout)
		defer cancel()
		if err := provider.EnsureCertificate(ctx, domains); err != nil {
			w.logger().Warn("web: cannot obtain a certificate", "domains", domains, "error", err)
			return
		}
		w.logger().Info("web: certificate ready", "domains", domains)
	}()
}

// hostOnly normalises a ServerName value.
func hostOnly(host string) string {
	return netutil.HostOnly(host)
}
