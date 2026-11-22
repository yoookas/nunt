package acme

import (
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/secret"
)

// source marks every certificate stored by this module.
const source = "acme"

// Challenge types as stored in model.CertJob.Challenge. The configuration
// normaliser of internal/config writes the short form and the ACME server uses
// the RFC 8555 long form; the short form is canonical here and both are
// accepted on input.
const (
	challengeHTTP    = "http"
	challengeDNS     = "dns"
	challengeTLSALPN = "tls"
)

// Wire challenge types as defined by RFC 8555.
const (
	wireHTTP01    = "http-01"
	wireDNS01     = "dns-01"
	wireTLSALPN01 = "tls-alpn-01"
)

// caDirectories maps the configured CA name to its ACME directory URL. A
// custom CA is configured with ACME.CACustomURL instead.
var caDirectories = map[string]string{
	"letsencrypt":         "https://acme-v02.api.letsencrypt.org/directory",
	"letsencrypt-staging": "https://acme-staging-v02.api.letsencrypt.org/directory",
}

// caCatalog lists the selectable certificate authorities in a stable order.
func caCatalog() []map[string]string {
	ids := []string{"letsencrypt", "letsencrypt-staging", "custom"}
	out := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]string{"id": id, "title": caTitle(id), "directory": caDirectories[id]})
	}
	return out
}

// caTitle returns a human readable name for the CA selector.
func caTitle(id string) string {
	switch id {
	case "letsencrypt":
		return "Let's Encrypt"
	case "letsencrypt-staging":
		return "Let's Encrypt (staging)"
	case "custom":
		return "Custom ACME directory"
	default:
		return id
	}
}

// directoryURL resolves the ACME directory URL for a configuration.
func directoryURL(cfg *model.ACMEConfig) (string, error) {
	if cfg == nil {
		return "", fmt.Errorf("acme configuration is missing")
	}
	name := strings.ToLower(strings.TrimSpace(cfg.CA))
	switch name {
	case "", "letsencrypt":
		return caDirectories["letsencrypt"], nil
	case "custom":
		url := strings.TrimSpace(cfg.CACustomURL)
		if url == "" {
			return "", fmt.Errorf("the custom CA requires a directory url")
		}
		if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
			return "", fmt.Errorf("custom CA url %q must be an absolute http(s) url", url)
		}
		return url, nil
	}
	if url, ok := caDirectories[name]; ok {
		return url, nil
	}
	return "", fmt.Errorf("unknown certificate authority %q", cfg.CA)
}

// normalizeCA validates a certificate authority selector. An empty value means
// "use the instance default".
func normalizeCA(v string) (string, error) {
	ca := strings.ToLower(strings.TrimSpace(v))
	if ca == "" {
		return "", nil
	}
	if ca == "custom" {
		return ca, nil
	}
	if _, ok := caDirectories[ca]; !ok {
		return "", fmt.Errorf("unknown certificate authority %q", v)
	}
	return ca, nil
}

// normalizeChallenge returns the canonical (stored) form of a challenge
// selector. Both the short form used by the configuration and the RFC 8555
// wire name are accepted.
func normalizeChallenge(v string) (string, error) {
	kind := strings.ToLower(strings.TrimSpace(v))
	switch kind {
	case "", challengeHTTP, wireHTTP01:
		return challengeHTTP, nil
	case challengeDNS, wireDNS01:
		return challengeDNS, nil
	case challengeTLSALPN, wireTLSALPN01:
		return challengeTLSALPN, nil
	default:
		return "", fmt.Errorf("unknown challenge type %q", v)
	}
}

// wireChallenge maps a canonical challenge to its ACME wire name.
func wireChallenge(canonical string) (string, error) {
	switch canonical {
	case challengeHTTP:
		return wireHTTP01, nil
	case challengeDNS:
		return wireDNS01, nil
	case challengeTLSALPN:
		return wireTLSALPN01, nil
	default:
		return "", fmt.Errorf("unknown challenge type %q", canonical)
	}
}

// defaultChallenge is used for one shot issuance, i.e. when the web service
// asks for a certificate without a configured job.
func defaultChallenge() string { return challengeHTTP }

// normalizeKeyType validates a certificate key type selector.
func normalizeKeyType(v string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", keyEC256:
		return keyEC256, nil
	case keyEC384, keyRSA2048, keyRSA4096:
		return strings.ToLower(strings.TrimSpace(v)), nil
	default:
		return "", fmt.Errorf("unknown key type %q", v)
	}
}

// jobLabel returns a display name for a job.
func jobLabel(job model.CertJob) string {
	if strings.TrimSpace(job.Name) != "" {
		return job.Name
	}
	if len(job.Domains) > 0 {
		return job.Domains[0]
	}
	return job.ID
}

// findJob returns a copy of the configured job with the given id.
func findJob(cfg *model.Config, id string) *model.CertJob {
	if cfg == nil || id == "" {
		return nil
	}
	for i := range cfg.ACME.Jobs {
		if cfg.ACME.Jobs[i].ID == id {
			job := cfg.ACME.Jobs[i]
			return &job
		}
	}
	return nil
}

// matchJob finds an enabled job covering exactly the requested domains.
func matchJob(cfg *model.Config, domains []string) (model.CertJob, bool) {
	if cfg == nil {
		return model.CertJob{}, false
	}
	for _, job := range cfg.ACME.Jobs {
		if !job.Enable {
			continue
		}
		if coversAll(job.Domains, domains) && coversAll(domains, job.Domains) {
			return job, true
		}
	}
	return model.CertJob{}, false
}

// renewWindow returns the widest renewal window configured, so that
// certs.DueForRenew does not filter out a certificate that a job with a larger
// renewDays value still considers due.
func renewWindow(cfg *model.Config) time.Duration {
	days := defaultRenewDays
	if cfg != nil {
		for _, job := range cfg.ACME.Jobs {
			if job.Enable && job.RenewDays > days {
				days = job.RenewDays
			}
		}
	}
	if days > maxRenewDays {
		days = maxRenewDays
	}
	return time.Duration(days) * 24 * time.Hour
}

// coversAll reports whether every domain in need is present in have.
func coversAll(have, need []string) bool {
	if len(need) == 0 {
		return false
	}
	for _, n := range need {
		found := false
		for _, h := range have {
			if strings.EqualFold(strings.TrimSpace(h), strings.TrimSpace(n)) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// domainsKey builds a stable, case insensitive key for a domain set.
func domainsKey(domains []string) string {
	seen := map[string]struct{}{}
	for _, d := range domains {
		d = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(d), "."))
		if d != "" {
			seen[d] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// normalizeDomains validates and cleans a user supplied domain list.
func normalizeDomains(domains []string) ([]string, error) {
	if len(domains) == 0 {
		return nil, fmt.Errorf("at least one domain is required")
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(domains))
	for _, raw := range domains {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" {
			continue
		}
		name = strings.TrimSuffix(name, ".")
		name = netutil.HostOnly(name)
		name = strings.TrimSuffix(name, ".")
		if name == "" {
			continue
		}
		if err := validateDomain(name); err != nil {
			return nil, err
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one domain is required")
	}
	return out, nil
}

// validateDomain rejects anything that is not a plain or wildcard DNS name.
func validateDomain(name string) error {
	if strings.ContainsAny(name, "/\\\r\n\t ") {
		return fmt.Errorf("invalid domain %q", name)
	}
	bare := strings.TrimPrefix(name, "*.")
	if bare == "" || strings.Contains(bare, "*") {
		return fmt.Errorf("invalid domain %q", name)
	}
	if ip := net.ParseIP(bare); ip != nil {
		return fmt.Errorf("%q is an ip address, which this module does not support", name)
	}
	if len(bare) > 253 {
		return fmt.Errorf("domain %q is too long", name)
	}
	for _, label := range strings.Split(bare, ".") {
		if label == "" || len(label) > 63 {
			return fmt.Errorf("invalid domain %q", name)
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return fmt.Errorf("invalid domain %q", name)
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			default:
				return fmt.Errorf("invalid character %q in domain %q", r, name)
			}
		}
	}
	if !strings.Contains(bare, ".") {
		return fmt.Errorf("domain %q must contain a dot", name)
	}
	return nil
}

// isWildcard reports whether the domain is a wildcard name.
func isWildcard(name string) bool { return strings.HasPrefix(name, "*.") }

// challengeRecordName returns the DNS name carrying the dns-01 TXT record.
func challengeRecordName(domain string) (string, error) {
	bare := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(domain)), "*.")
	bare = strings.TrimSuffix(bare, ".")
	if bare == "" {
		return "", fmt.Errorf("empty domain")
	}
	return "_acme-challenge." + bare, nil
}

// maskCreds hides every credential value for API responses.
func maskCreds(creds map[string]string) map[string]string {
	if len(creds) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(creds))
	for k, v := range creds {
		out[k] = secret.Mask(v)
	}
	return out
}

// mergeCreds keeps the stored value when the client sends a masked or empty
// credential, so a round trip through the UI cannot destroy a secret.
func mergeCreds(old, in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		if isMasked(v) {
			if prev, ok := old[k]; ok {
				out[k] = prev
				continue
			}
			out[k] = ""
			continue
		}
		out[k] = v
	}
	return out
}

// isMasked reports whether v is the placeholder produced by secret.Mask.
func isMasked(v string) bool { return strings.Contains(v, "********") }
