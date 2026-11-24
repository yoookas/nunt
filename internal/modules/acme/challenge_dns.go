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

// DNS-01 tuning. Propagation is checked against the zone's authoritative
// nameservers unless the job names its own resolvers.
var (
	dnsWaitWindow = 5 * time.Minute
	// certmagic polls every two seconds; the shorter interval finds a record
	// that is already served much sooner and keeps the whole issuance short.
	dnsPollInterval = 2 * time.Second
	dnsQueryTimeout = 5 * time.Second
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

	resolver := resolverFor(req)
	// _acme-challenge may be a CNAME into another zone (a common way to let a
	// dedicated account hold the challenge records). The CA follows the CNAME,
	// so the TXT record belongs at the end of the chain.
	writeName := recName
	if canonical, cerr := resolver.LookupCNAME(ctx, recName); cerr == nil {
		if name := strings.TrimSuffix(strings.TrimSpace(canonical), "."); name != "" && !strings.EqualFold(name, recName) {
			writeName = name
		}
	}
	zone, sub, err := splitZone(ctx, resolver, writeName)
	if err != nil {
		return nil, fmt.Errorf("find the dns zone of %s: %w", writeName, err)
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
		return nil, fmt.Errorf("create TXT record %s at %s: %w", writeName, req.dnsProvider, err)
	}

	waitErr := waitForTXT(ownCtx, resolver, zone, req.dnsResolvers, writeName, value)
	if waitErr != nil {
		removeCtx, removeCancel := context.WithTimeout(context.Background(), time.Minute)
		if derr := provider.Delete(removeCtx, record); derr != nil {
			a.log.Warn("验证失败后无法删除 TXT 记录", "record", writeName, "error", derr)
		}
		removeCancel()
		cancel()
		return nil, fmt.Errorf("dns-01 challenge for %s: %w", domain, waitErr)
	}
	a.log.Info("dns-01 的 TXT 记录已传播", "record", writeName, "zone", zone)

	cleanup := func() {
		defer cancel()
		removeCtx, removeCancel := context.WithTimeout(context.Background(), time.Minute)
		defer removeCancel()
		if err := provider.Delete(removeCtx, record); err != nil {
			a.log.Warn("无法删除 TXT 记录", "record", writeName, "error", err)
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

// waitForTXT waits until the TXT value is visible where the CA will look.
//
// The CA queries the zone's authoritative nameservers, so that is the source of
// truth. Recursive resolvers are not: once a name has been answered, they keep
// the answer for its TTL, and the minimum TTL DNSPod accepts is 600 seconds. A
// second TXT value at the same name (an apex and its wildcard) therefore stays
// invisible to those resolvers for up to ten minutes while the authoritative
// servers already serve it.
//
// A job that names its own resolvers (split horizon, or an environment where
// the authoritative servers are not reachable) is checked against those
// instead, exactly like certmagic's Resolvers option. Without them the
// authoritative servers are the only check: a zone whose nameservers cannot be
// resolved fails here rather than being waved through by a cache.
func waitForTXT(ctx context.Context, zoneResolver *net.Resolver, zone string, custom []string, name, want string) error {
	deadline := time.Now().Add(dnsWaitWindow)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}

	if len(custom) > 0 {
		return waitForTXTOn(ctx, normalizeResolvers(custom), name, want, deadline, "配置的解析器")
	}

	if zoneResolver == nil {
		zoneResolver = net.DefaultResolver
	}
	lookupCtx, cancel := context.WithTimeout(ctx, dnsQueryTimeout)
	authoritative, err := authoritativeServers(lookupCtx, zoneResolver, zone)
	cancel()
	if err != nil {
		return fmt.Errorf("cannot resolve the authoritative nameservers of %s: %w", zone, err)
	}
	if len(authoritative) == 0 {
		return fmt.Errorf("no authoritative nameserver answered for %s", zone)
	}
	return waitForTXTOn(ctx, authoritative, name, want, deadline, "权威服务器")
}

// waitForTXTOn polls the given servers until one of them answers the expected
// value, the deadline passes or ctx is done. One server answering is enough:
// that is how certmagic treats the authoritative set, and requiring every
// server would hang on a single lagging or unreachable one.
func waitForTXTOn(ctx context.Context, servers []string, name, want string, deadline time.Time, label string) error {
	var last map[string][]string
	for {
		last = queryTXT(ctx, servers, name)
		for _, server := range servers {
			if hasTXT(last[server], want) {
				return nil
			}
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return fmt.Errorf("the TXT record %s did not propagate within %s; no %s served it (last answers: %s)",
				name, dnsWaitWindow, label, describeAnswers(last))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(dnsPollInterval):
		}
	}
}

// authoritativeServers returns the addresses of the zone's nameservers.
func authoritativeServers(ctx context.Context, resolver *net.Resolver, zone string) ([]string, error) {
	names, err := resolver.LookupNS(ctx, zone)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(names))
	for _, ns := range names {
		host := strings.TrimSuffix(strings.TrimSpace(ns.Host), ".")
		if host == "" {
			continue
		}
		ips, err := resolver.LookupHost(ctx, host)
		if err != nil {
			continue
		}
		for _, ip := range ips {
			out = append(out, net.JoinHostPort(ip, "53"))
		}
	}
	return out, nil
}

// hasTXT reports whether the expected value is one of the answers. A name can
// hold several TXT records (the apex and its wildcard share one), so the whole
// set matters, not just the first value.
func hasTXT(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// queryTXT asks every resolver for the TXT record and returns the values each
// one answered, or a single diagnostic entry when the query failed.
func queryTXT(ctx context.Context, servers []string, name string) map[string][]string {
	out := make(map[string][]string, len(servers))
	type result struct {
		server string
		value  []string
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
				res.value = []string{"error: " + err.Error()}
			case len(values) == 0:
				res.value = []string{"no TXT record"}
			default:
				res.value = values
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
func describeAnswers(answers map[string][]string) string {
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
		parts = append(parts, fmt.Sprintf("%s=%s", k, strings.Join(answers[k], ",")))
	}
	return strings.Join(parts, "; ")
}
