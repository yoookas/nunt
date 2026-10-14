package acme

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/acme"

	"github.com/nunt/nunt/internal/dnsprov"
)

// DNS-01 tuning. defaultDNSResolvers are public resolvers used to confirm that
// a TXT record has propagated before the CA is asked to validate it.
var (
	defaultDNSResolvers = []string{"1.1.1.1:53", "8.8.8.8:53", "223.5.5.5:53"}
	dnsWaitWindow       = 5 * time.Minute
	dnsPollInterval     = 5 * time.Second
	dnsQueryTimeout     = 5 * time.Second
)

// startDNS01 creates the _acme-challenge TXT record, waits for it to propagate
// and returns a cleanup function that removes it again.
func (a *ACME) startDNS01(ctx context.Context, client *acme.Client, chal *acme.Challenge, req request, domain string) (func(), error) {
	value, err := dns01Record(client, chal)
	if err != nil {
		return nil, err
	}
	recName, err := challengeRecordName(domain)
	if err != nil {
		return nil, fmt.Errorf("dns-01 record name for %q: %w", domain, err)
	}

	creds, err := a.deps.Box.OpenMap(req.dnsCreds)
	if err != nil {
		return nil, fmt.Errorf("open the credentials of dns provider %s: %w", req.dnsProvider, err)
	}
	provider, err := dnsprov.Default().New(req.dnsProvider, dnsprov.Credentials(creds))
	if err != nil {
		return nil, fmt.Errorf("create dns provider %s: %w", req.dnsProvider, err)
	}

	zone, sub, err := splitZone(ctx, resolverFor(req), recName)
	if err != nil {
		return nil, fmt.Errorf("find the dns zone of %s: %w", recName, err)
	}
	record := dnsprov.Record{
		Domain:    zone,
		SubDomain: sub,
		Type:      "TXT",
		Value:     value,
		TTL:       60,
	}

	// Creating the record and removing it again must survive the caller going
	// away, otherwise a cancelled request leaves a stale TXT record behind.
	// The context given by the caller still bounds an explicit timeout.
	ownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), issueTimeout)
	if err := provider.Set(ownCtx, record); err != nil {
		cancel()
		return nil, fmt.Errorf("create TXT record %s at %s: %w", recName, req.dnsProvider, err)
	}

	resolvers := req.dnsResolvers
	if len(resolvers) == 0 {
		resolvers = defaultDNSResolvers
	}
	waitErr := waitForTXT(ownCtx, resolvers, recName, value)
	if waitErr != nil {
		removeCtx, removeCancel := context.WithTimeout(context.Background(), time.Minute)
		if derr := provider.Delete(removeCtx, record); derr != nil {
			a.log.Warn("cannot remove the TXT record after a failed validation", "record", recName, "error", derr)
		}
		removeCancel()
		cancel()
		return nil, fmt.Errorf("dns-01 challenge for %s: %w", domain, waitErr)
	}
	a.log.Info("dns-01 record is visible on every resolver", "record", recName, "zone", zone)

	cleanup := func() {
		defer cancel()
		removeCtx, removeCancel := context.WithTimeout(context.Background(), time.Minute)
		defer removeCancel()
		if err := provider.Delete(removeCtx, record); err != nil {
			a.log.Warn("cannot remove the TXT record", "record", recName, "error", err)
		}
	}
	return cleanup, nil
}

// dns01Record computes the TXT value for a dns-01 challenge. It is the base64
// encoded SHA-256 digest of the key authorization.
func dns01Record(client *acme.Client, chal *acme.Challenge) (string, error) {
	if client == nil || chal == nil {
		return "", fmt.Errorf("dns-01 challenge is incomplete")
	}
	value, err := client.DNS01ChallengeRecord(chal.Token)
	if err != nil {
		return "", fmt.Errorf("build dns-01 response: %w", err)
	}
	return value, nil
}

// resolverFor builds a resolver that uses the job's own DNS servers when it
// defines any; zone lookups then work even behind a split horizon DNS.
func resolverFor(req request) *net.Resolver {
	if len(req.dnsResolvers) == 0 {
		return net.DefaultResolver
	}
	return &net.Resolver{PreferGo: true, Dial: dialerFor(req.dnsResolvers)}
}

// dialerFor returns a dial function for the given resolver addresses.
func dialerFor(resolvers []string) func(ctx context.Context, network, address string) (net.Conn, error) {
	servers := normalizeResolvers(resolvers)
	return func(ctx context.Context, network, _ string) (net.Conn, error) {
		var lastErr error
		for _, server := range servers {
			dialer := &net.Dialer{Timeout: dnsQueryTimeout}
			conn, err := dialer.DialContext(ctx, network, server)
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr == nil {
			lastErr = fmt.Errorf("no dns resolver configured")
		}
		return nil, lastErr
	}
}

// normalizeResolvers adds the default DNS port and drops empty entries.
func normalizeResolvers(in []string) []string {
	out := make([]string, 0, len(in))
	for _, raw := range in {
		addr := strings.TrimSpace(raw)
		if addr == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(addr); err != nil {
			addr = net.JoinHostPort(addr, "53")
		}
		out = append(out, addr)
	}
	return out
}

// splitZone finds the DNS zone that holds name and returns the zone plus the
// host part relative to it. The zone is the longest suffix served by any NS
// record, falling back to the last two labels.
func splitZone(ctx context.Context, resolver *net.Resolver, name string) (string, string, error) {
	labels := strings.Split(strings.TrimSuffix(strings.ToLower(name), "."), ".")
	if len(labels) < 2 {
		return "", "", fmt.Errorf("%q is not a fully qualified domain name", name)
	}
	for i := 0; i < len(labels)-1; i++ {
		candidate := strings.Join(labels[i:], ".")
		lookupCtx, cancel := context.WithTimeout(ctx, dnsQueryTimeout)
		nss, err := resolver.LookupNS(lookupCtx, candidate)
		cancel()
		if err == nil && len(nss) > 0 {
			sub := strings.Join(labels[:i], ".")
			if sub == "" {
				sub = "@"
			}
			return candidate, sub, nil
		}
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
	}
	return "", "", fmt.Errorf("no dns zone with an NS record found for %q", name)
}

// waitForTXT polls every resolver until the expected TXT value is visible, the
// window elapses or ctx is done.
func waitForTXT(ctx context.Context, resolvers []string, name, want string) error {
	servers := normalizeResolvers(resolvers)
	if len(servers) == 0 {
		servers = normalizeResolvers(defaultDNSResolvers)
	}
	deadline := time.Now().Add(dnsWaitWindow)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}

	var last map[string]string
	for {
		last = queryTXT(ctx, servers, name)
		missing := 0
		for _, server := range servers {
			if last[server] != want {
				missing++
			}
		}
		if missing == 0 {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return fmt.Errorf("the TXT record %s did not propagate within %s (last answers: %s)",
				name, dnsWaitWindow, describeAnswers(last))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(dnsPollInterval):
		}
	}
}

// queryTXT asks every resolver for the TXT record and returns one answer per
// resolver: the matching value, the first value seen or the error.
func queryTXT(ctx context.Context, servers []string, name string) map[string]string {
	out := make(map[string]string, len(servers))
	type result struct {
		server string
		value  string
	}
	results := make(chan result, len(servers))
	for _, server := range servers {
		go func(server string) {
			res := result{server: server}
			queryCtx, cancel := context.WithTimeout(ctx, dnsQueryTimeout)
			defer cancel()
			resolver := &net.Resolver{PreferGo: true, Dial: dialerFor([]string{server})}
			values, err := resolver.LookupTXT(queryCtx, name)
			switch {
			case err != nil:
				res.value = "error: " + err.Error()
			case len(values) == 0:
				res.value = "no TXT record"
			default:
				res.value = strings.Join(values, ",")
			}
			results <- res
		}(server)
	}
	for i := 0; i < len(servers); i++ {
		res := <-results
		out[res.server] = res.value
	}
	return out
}

// describeAnswers renders the per resolver answers for an error message.
func describeAnswers(answers map[string]string) string {
	if len(answers) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(answers))
	for k := range answers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, answers[k]))
	}
	return strings.Join(parts, "; ")
}
