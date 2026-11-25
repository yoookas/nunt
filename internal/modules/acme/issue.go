package acme

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"golang.org/x/crypto/acme"

	"github.com/nunt/nunt/internal/model"
)

// request is a fully resolved issuance request.
type request struct {
	jobID        string
	domains      []string
	challenge    string // wire value: http-01, dns-01 or tls-alpn-01
	dnsProvider  string
	dnsCreds     map[string]string // decrypted
	dnsResolvers []string
	keyType      string
	renewDays    int
	remark       string
	// persist stores the key type back into the job configuration.
	persist bool
}

// Result reports what one issuance produced.
type Result struct {
	JobID     string    `json:"jobId"`
	Domains   []string  `json:"domains"`
	CertID    string    `json:"certId"`
	NotAfter  time.Time `json:"notAfter"`
	Issuer    string    `json:"issuer"`
	KeyType   string    `json:"keyType"`
	Challenge string    `json:"challenge"`
}

// newRequest resolves a job into an issuance request.
func newRequest(cfg *model.Config, job model.CertJob) request {
	challenge, err := normalizeChallenge(job.Challenge)
	if err != nil {
		challenge = defaultChallenge()
	}
	keyType := job.KeyType
	if keyType == "" && cfg != nil {
		keyType = cfg.ACME.KeyType
	}
	if _, err := normalizeKeyType(keyType); err != nil {
		keyType = keyEC256
	}
	renewDays := job.RenewDays
	if renewDays <= 0 {
		renewDays = defaultRenewDays
	}
	return request{
		jobID:        job.ID,
		domains:      append([]string{}, job.Domains...),
		challenge:    challenge,
		dnsProvider:  job.DNSProvider,
		dnsCreds:     job.DNSCreds,
		dnsResolvers: append([]string{}, job.DNSResolvers...),
		keyType:      strings.ToLower(strings.TrimSpace(keyType)),
		renewDays:    renewDays,
		remark:       job.Remark,
	}
}

// validate checks the request as a whole and cleans the domain list.
func (r *request) validate(cfg *model.Config) error {
	domains, err := normalizeDomains(r.domains)
	if err != nil {
		return err
	}
	r.domains = domains

	switch r.challenge {
	case challengeHTTP, challengeDNS, challengeTLSALPN:
	default:
		return fmt.Errorf("unsupported challenge %q", r.challenge)
	}
	for _, d := range r.domains {
		if isWildcard(d) && r.challenge != challengeDNS {
			return fmt.Errorf("domain %s is a wildcard and requires the dns-01 challenge", d)
		}
	}
	if r.challenge == challengeDNS && strings.TrimSpace(r.dnsProvider) == "" {
		return fmt.Errorf("the dns-01 challenge requires a dns provider")
	}
	if _, err := normalizeKeyType(r.keyType); err != nil {
		return err
	}
	if cfg != nil && strings.TrimSpace(cfg.ACME.Email) != "" && !strings.Contains(cfg.ACME.Email, "@") {
		return fmt.Errorf("invalid contact email %q", cfg.ACME.Email)
	}
	return nil
}

// issue runs the full ACME flow: order, challenges, finalize, store.
func (a *ACME) issue(ctx context.Context, req request) (result Result, err error) {
	result = Result{JobID: req.jobID, Challenge: req.challenge}
	cfg := a.deps.Cfg.Snapshot()
	if err := req.validate(cfg); err != nil {
		return result, err
	}
	result.Domains = req.domains
	result.KeyType = req.keyType

	client, err := a.account.clientFor(ctx, &cfg.ACME)
	if err != nil {
		return result, fmt.Errorf("prepare acme account: %w", err)
	}

	// A failed issuance leaves authorizations pending on the account, and the
	// CA counts them against the pending authorization limit until they
	// expire. Freeing them on the way out keeps repeated retries from being
	// refused, the same thing acmez does.
	var authorizations []*acme.Authorization
	defer func() {
		if err != nil {
			a.deactivateAuthorizations(ctx, client, authorizations)
		}
	}()

	order, err := client.AuthorizeOrder(ctx, acme.DomainIDs(req.domains...))
	if err != nil {
		return result, fmt.Errorf("create order for %s: %w", strings.Join(req.domains, ", "), err)
	}

	// Present every answer first, then let the CA validate, like acmez does.
	// One name can hold several TXT values (an apex and its wildcard share the
	// challenge name), so all of them must be in place before validation
	// starts. The cleanup functions run at the end of the whole issuance.
	type pendingAuthz struct {
		domain string
		chal   *acme.Challenge
		uri    string
	}
	var pending []pendingAuthz
	for _, authzURL := range order.AuthzURLs {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		authz, err := client.GetAuthorization(ctx, authzURL)
		if err != nil {
			return result, fmt.Errorf("read authorization %s: %w", authzURL, err)
		}
		authorizations = append(authorizations, authz)
		// The CA must only authorise names this job asked for. Otherwise a
		// dishonest CA could use the operator's DNS credentials as an oracle
		// for a zone outside the job.
		if authz.Identifier.Type != "dns" || !authorizationCovers(req.domains, authz.Identifier.Value) {
			return result, fmt.Errorf("the ca returned an authorization for %q, which is not one of the requested domains", authz.Identifier.Value)
		}
		if authz.Status == acme.StatusValid {
			continue
		}
		chal, cleanup, err := a.provisionChallenge(ctx, client, req, authz)
		if err != nil {
			return result, err
		}
		if cleanup != nil {
			defer cleanup()
		}
		if chal == nil {
			continue
		}
		pending = append(pending, pendingAuthz{domain: authz.Identifier.Value, chal: chal, uri: authz.URI})
	}

	// Tell the server to validate every challenge ...
	for _, item := range pending {
		if _, err := client.Accept(ctx, item.chal); err != nil {
			return result, fmt.Errorf("accept the %s challenge for %s: %w", req.challenge, item.domain, err)
		}
	}
	// ... and wait for each authorization to settle.
	for _, item := range pending {
		if _, err := client.WaitAuthorization(ctx, item.uri); err != nil {
			return result, fmt.Errorf("authorization for %s failed: %w", item.domain, err)
		}
		a.log.Info("挑战验证通过", "domain", item.domain, "challenge", req.challenge)
	}

	ready, err := client.WaitOrder(ctx, order.URI)
	if err != nil {
		return result, fmt.Errorf("wait for order: %w", err)
	}

	key, err := generateKey(req.keyType)
	if err != nil {
		return result, err
	}
	csr, err := createCSR(key, req.domains)
	if err != nil {
		return result, err
	}
	der, _, err := client.CreateOrderCert(ctx, ready.FinalizeURL, csr, true)
	if err != nil {
		return result, fmt.Errorf("finalize order: %w", err)
	}
	if len(der) == 0 {
		return result, fmt.Errorf("the ca returned an empty certificate chain")
	}

	certPEM, err := encodeChainPEM(der)
	if err != nil {
		return result, err
	}
	keyPEM, err := encodeKeyPEM(key)
	if err != nil {
		return result, err
	}
	if err := verifyChain(certPEM, keyPEM, req.domains, a.log); err != nil {
		return result, err
	}

	info, err := a.deps.Certs.Add(req.domains, certPEM, keyPEM, source, req.jobID, req.remark, true)
	if err != nil {
		return result, fmt.Errorf("store certificate: %w", err)
	}
	result.CertID = info.ID
	result.NotAfter = info.NotAfter
	result.Issuer = info.Issuer

	if req.persist {
		a.persistKeyType(req)
	}
	return result, nil
}

// provisionChallenge publishes the answer of one authorization and returns the
// challenge plus the function that undoes the temporary changes. Accepting the
// challenge is left to the caller, which presents every answer first so the CA
// never starts validating before all of them are in place.
func (a *ACME) provisionChallenge(ctx context.Context, client *acme.Client, req request, authz *acme.Authorization) (*acme.Challenge, func(), error) {
	wireType, err := wireChallenge(req.challenge)
	if err != nil {
		return nil, nil, err
	}
	var chal *acme.Challenge
	for _, c := range authz.Challenges {
		if c.Type == wireType {
			chal = c
			break
		}
	}
	if chal == nil {
		return nil, nil, fmt.Errorf("the ca offers no %s challenge for %s", wireType, authz.Identifier.Value)
	}
	if chal.Status == acme.StatusValid {
		return nil, nil, nil
	}

	domain := authz.Identifier.Value
	var cleanup func()
	switch req.challenge {
	case challengeHTTP:
		cleanup, err = a.startHTTP01(client, chal, domain)
	case challengeDNS:
		cleanup, err = a.startDNS01(ctx, client, chal, req, domain)
	case challengeTLSALPN:
		cleanup, err = a.startTLSALPN01(client, chal, domain)
	default:
		err = fmt.Errorf("unsupported challenge %q", req.challenge)
	}
	if err != nil {
		return nil, nil, err
	}
	return chal, cleanup, nil
}

// authorizationCovers reports whether an authorization identifier belongs to
// the requested domain set. A wildcard order is authorised under its base name,
// which is why "*.example.com" also accepts "example.com".
func authorizationCovers(domains []string, identifier string) bool {
	for _, d := range domains {
		if d == identifier {
			return true
		}
		if strings.HasPrefix(d, "*.") && d[2:] == identifier {
			return true
		}
	}
	return false
}

// deactivateAuthorizations releases the pending authorizations of a failed
// issuance. They would otherwise stay on the account (counting against its
// pending authorization limit) until the CA expires them. The caller's context
// may already be cancelled, so the calls get their own short deadline.
func (a *ACME) deactivateAuthorizations(ctx context.Context, client *acme.Client, authzs []*acme.Authorization) {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	for _, authz := range authzs {
		// Only pending authorizations are released: they count against the
		// account's pending authorization limit, while a valid one is reusable
		// by the next order and costs no new validation.
		if authz == nil || authz.Status != acme.StatusPending {
			continue
		}
		if err := client.RevokeAuthorization(releaseCtx, authz.URI); err != nil {
			a.log.Warn("无法撤销授权", "domain", authz.Identifier.Value, "error", err)
			continue
		}
		a.log.Info("已撤销未完成的授权", "domain", authz.Identifier.Value)
	}
}

// persistKeyType records the key type used for a certificate so a later change
// is visible in the UI.
func (a *ACME) persistKeyType(req request) {
	if req.jobID == "" || strings.HasPrefix(req.jobID, "on-demand-") {
		return
	}
	err := a.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.ACME.Jobs {
			if c.ACME.Jobs[i].ID != req.jobID {
				continue
			}
			if c.ACME.Jobs[i].KeyType == "" {
				c.ACME.Jobs[i].KeyType = req.keyType
			}
			return nil
		}
		return nil
	})
	if err != nil {
		a.log.Warn("无法记录证书密钥类型", "job", req.jobID, "error", err)
	}
}

// createCSR builds a DER encoded PKCS#10 request for the domains.
func createCSR(key crypto.Signer, domains []string) ([]byte, error) {
	if len(domains) == 0 {
		return nil, fmt.Errorf("a csr needs at least one domain")
	}
	template := &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: domains[0]},
		DNSNames: append([]string{}, domains...),
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, template, key)
	if err != nil {
		return nil, fmt.Errorf("create csr: %w", err)
	}
	if _, err := x509.ParseCertificateRequest(der); err != nil {
		return nil, fmt.Errorf("verify csr: %w", err)
	}
	return der, nil
}

// encodeChainPEM converts the DER chain returned by the CA into PEM blocks.
func encodeChainPEM(der [][]byte) ([]byte, error) {
	var out []byte
	for i, block := range der {
		if len(block) == 0 {
			continue
		}
		if _, err := x509.ParseCertificate(block); err != nil {
			return nil, fmt.Errorf("parse certificate %d in the chain: %w", i, err)
		}
		out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: block})...)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the certificate chain is empty")
	}
	return out, nil
}

// verifyChain makes sure the key pair parses and the leaf covers the domains.
func verifyChain(certPEM, keyPEM []byte, domains []string, log *slog.Logger) error {
	leaf, err := decodeLeaf(certPEM)
	if err != nil {
		return err
	}
	pub, err := publicKeyOf(keyPEM)
	if err != nil {
		return err
	}
	if !keysMatch(leaf, pub) {
		return fmt.Errorf("the issued certificate does not match the generated private key")
	}
	if missing := missingDomains(leaf.DNSNames, domains); len(missing) > 0 {
		return fmt.Errorf("the issued certificate is missing the domain(s) %s", strings.Join(missing, ", "))
	}
	if log != nil {
		log.Debug("证书校验通过", "domains", domains, "notAfter", leaf.NotAfter.Format(time.RFC3339))
	}
	return nil
}

// decodeLeaf parses the first certificate of a PEM bundle.
func decodeLeaf(certPEM []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, fmt.Errorf("the certificate chain is not pem encoded")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse leaf certificate: %w", err)
	}
	return leaf, nil
}

// publicKeyOf parses the public key of a PEM encoded private key.
func publicKeyOf(keyPEM []byte) (crypto.PublicKey, error) {
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, fmt.Errorf("the private key is not pem encoded")
	}
	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key.Public(), nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key.Public(), nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	signer, ok := parsed.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("private key type %T cannot sign", parsed)
	}
	return signer.Public(), nil
}

// keysMatch compares the certificate public key with a private key.
func keysMatch(leaf *x509.Certificate, pub crypto.PublicKey) bool {
	type equaler interface{ Equal(crypto.PublicKey) bool }
	if e, ok := leaf.PublicKey.(equaler); ok {
		return e.Equal(pub)
	}
	return false
}

// missingDomains returns the requested domains that the certificate lacks.
func missingDomains(sans, want []string) []string {
	var out []string
	for _, w := range want {
		found := false
		for _, s := range sans {
			if strings.EqualFold(s, w) {
				found = true
				break
			}
		}
		if !found && !hasWildcardCover(sans, w) {
			out = append(out, w)
		}
	}
	return out
}

// hasWildcardCover reports whether a wildcard SAN covers the domain.
func hasWildcardCover(sans []string, domain string) bool {
	parts := strings.Split(domain, ".")
	for i := 1; i < len(parts)-1; i++ {
		wild := "*." + strings.Join(parts[i:], ".")
		for _, s := range sans {
			if strings.EqualFold(s, wild) {
				return true
			}
		}
	}
	return false
}
