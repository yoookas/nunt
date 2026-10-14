package acme

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/dnsprov"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
)

// certJobView is the API representation of a job: credentials are masked.
type certJobView struct {
	model.CertJob
	DNSCreds      map[string]string `json:"dnsCreds"`
	HasCreds      bool              `json:"hasCreds"`
	DomainsJoined string            `json:"domainsJoined"`
}

// certJobUpdate is the payload accepted by POST/PUT /jobs.
type certJobUpdate struct {
	Name         string            `json:"name"`
	Enable       bool              `json:"enable"`
	Domains      []string          `json:"domains"`
	KeyType      string            `json:"keyType"`
	Challenge    string            `json:"challenge"`
	DNSProvider  string            `json:"dnsProvider"`
	DNSCreds     map[string]string `json:"dnsCreds"`
	DNSResolvers []string          `json:"dnsResolvers"`
	RenewDays    int               `json:"renewDays"`
	Remark       string            `json:"remark"`
}

// certificateView is the API representation of a stored certificate.
type certificateView struct {
	ID        string    `json:"id"`
	Domains   []string  `json:"domains"`
	Issuer    string    `json:"issuer"`
	NotBefore time.Time `json:"notBefore"`
	NotAfter  time.Time `json:"notAfter"`
	Source    string    `json:"source"`
	JobID     string    `json:"jobId,omitempty"`
	AutoRenew bool      `json:"autoRenew"`
	UpdatedAt time.Time `json:"updatedAt"`
	KeyType   string    `json:"keyType,omitempty"`
	DaysLeft  int       `json:"daysLeft"`
	Expired   bool      `json:"expired"`
}

// certificateUpload is the payload accepted by POST /certificates/upload.
type certificateUpload struct {
	Domains []string `json:"domains"`
	Cert    string   `json:"cert"`
	Key     string   `json:"key"`
	// The admin UI sends both spellings; accepting the aliases keeps the
	// endpoint forgiving for hand written API clients as well.
	Certificate string `json:"certificate"`
	PrivateKey  string `json:"privateKey"`
	Chain       string `json:"chain"`
	Name        string `json:"name"`
}

// normalize fills the canonical fields from their aliases.
func (u *certificateUpload) normalize() {
	if u.Cert == "" {
		u.Cert = u.Certificate
	}
	if u.Key == "" {
		u.Key = u.PrivateKey
	}
	if strings.TrimSpace(u.Chain) != "" && !strings.Contains(u.Cert, strings.TrimSpace(u.Chain)) {
		if !strings.HasSuffix(u.Cert, "\n") {
			u.Cert += "\n"
		}
		u.Cert += u.Chain
	}
}

// registerAPI mounts every endpoint of the module.
func (a *ACME) registerAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/acme")
	g.Get("/jobs", a.handleListJobs)
	g.Post("/jobs", a.handleCreateJob)
	g.Put("/jobs/{id}", a.handleUpdateJob)
	g.Delete("/jobs/{id}", a.handleDeleteJob)
	g.Post("/jobs/{id}/issue", a.handleIssueJob)
	g.Post("/jobs/{id}/toggle", a.handleToggleJob)
	g.Get("/certificates", a.handleListCertificates)
	g.Post("/certificates/upload", a.handleUploadCertificate)
	g.Delete("/certificates/{id}", a.handleDeleteCertificate)
	g.Get("/providers", a.handleProviders)
	g.Get("/status", a.handleStatus)
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

func (a *ACME) handleListJobs(w http.ResponseWriter, r *http.Request) {
	cfg := a.deps.Cfg.Snapshot()
	items := make([]certJobView, 0, len(cfg.ACME.Jobs))
	for _, job := range cfg.ACME.Jobs {
		items = append(items, a.jobView(job))
	}
	rest.OK(w, map[string]any{
		"items":       items,
		"ca":          cfg.ACME.CA,
		"caCustom":    cfg.ACME.CACustomURL,
		"email":       cfg.ACME.Email,
		"keyType":     cfg.ACME.KeyType,
		"challenge":   defaultChallenge(),
		"authorities": caCatalog(),
		"keyTypes":    keyCatalog(),
	})
}

func (a *ACME) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req certJobUpdate
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	job, err := a.buildJob(req, nil)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	if err := a.deps.Cfg.Update(func(c *model.Config) error {
		c.ACME.Jobs = append(c.ACME.Jobs, *job)
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the certificate job: %s", err)
		return
	}
	a.Reload(a.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"id": job.ID})
}

func (a *ACME) handleUpdateJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req certJobUpdate
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	existing := findJob(a.deps.Cfg.Snapshot(), id)
	if existing == nil {
		rest.Fail(w, http.StatusNotFound, "certificate job %s does not exist", id)
		return
	}
	job, err := a.buildJob(req, existing)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	if err := a.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.ACME.Jobs {
			if c.ACME.Jobs[i].ID == id {
				c.ACME.Jobs[i] = *job
				return nil
			}
		}
		return fmt.Errorf("certificate job %s does not exist", id)
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the certificate job: %s", err)
		return
	}
	a.Reload(a.deps.Cfg.Snapshot())
	rest.NoContent(w)
}

func (a *ACME) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	found := false
	err := a.deps.Cfg.Update(func(c *model.Config) error {
		out := c.ACME.Jobs[:0]
		for _, job := range c.ACME.Jobs {
			if job.ID == id {
				found = true
				continue
			}
			out = append(out, job)
		}
		c.ACME.Jobs = out
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot delete the certificate job: %s", err)
		return
	}
	if !found {
		rest.Fail(w, http.StatusNotFound, "certificate job %s does not exist", id)
		return
	}
	a.schedMu.Lock()
	delete(a.attempts, id)
	a.schedMu.Unlock()
	rest.NoContent(w)
}

func (a *ACME) handleToggleJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	enabled := false
	err := a.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.ACME.Jobs {
			if c.ACME.Jobs[i].ID != id {
				continue
			}
			c.ACME.Jobs[i].Enable = !c.ACME.Jobs[i].Enable
			enabled = c.ACME.Jobs[i].Enable
			return nil
		}
		return fmt.Errorf("certificate job %s does not exist", id)
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "%s", err.Error())
		return
	}
	if !enabled {
		a.schedMu.Lock()
		delete(a.attempts, id)
		a.schedMu.Unlock()
	}
	a.Reload(a.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"id": id, "enable": enabled})
}

// handleIssueJob starts an issuance in the background and answers 202.
func (a *ACME) handleIssueJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job := findJob(a.deps.Cfg.Snapshot(), id)
	if job == nil {
		rest.Fail(w, http.StatusNotFound, "certificate job %s does not exist", id)
		return
	}
	jobCopy := *job
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), issueTimeout)
		defer cancel()
		a.runJob(ctx, jobCopy, false)
	}()
	rest.JSON(w, http.StatusAccepted, map[string]any{
		"status": "started",
		"id":     id,
		"job":    jobLabel(jobCopy),
	})
}

// buildJob validates a create/update payload and merges credentials with an
// existing job so masked values are never written back to disk.
func (a *ACME) buildJob(req certJobUpdate, existing *model.CertJob) (*model.CertJob, error) {
	domains, err := normalizeDomains(req.Domains)
	if err != nil {
		return nil, err
	}
	challenge, err := normalizeChallenge(req.Challenge)
	if err != nil {
		return nil, err
	}
	keyType, err := normalizeKeyType(req.KeyType)
	if err != nil {
		return nil, err
	}
	provider := strings.TrimSpace(req.DNSProvider)
	resolvers := normalizeResolvers(req.DNSResolvers)
	if challenge == challengeDNS {
		if provider == "" {
			return nil, fmt.Errorf("the dns-01 challenge requires a dns provider")
		}
		if _, ok := dnsprov.Default().Meta(provider); !ok {
			return nil, fmt.Errorf("unknown dns provider %q", provider)
		}
	}
	for _, d := range domains {
		if isWildcard(d) && challenge != challengeDNS {
			return nil, fmt.Errorf("domain %s is a wildcard and requires the dns-01 challenge", d)
		}
	}
	if req.RenewDays < 0 || req.RenewDays > 365 {
		return nil, fmt.Errorf("renewDays must be between 0 and 365")
	}

	job := model.CertJob{
		ID:           model.NewID(),
		Name:         strings.TrimSpace(req.Name),
		Enable:       req.Enable,
		Domains:      domains,
		KeyType:      keyType,
		Challenge:    challenge,
		DNSProvider:  provider,
		DNSResolvers: resolvers,
		RenewDays:    req.RenewDays,
		Remark:       strings.TrimSpace(req.Remark),
		CreatedAt:    time.Now(),
	}
	if job.Name == "" {
		job.Name = domains[0]
	}
	if job.RenewDays == 0 {
		job.RenewDays = defaultRenewDays
	}
	if existing != nil {
		job.ID = existing.ID
		job.CreatedAt = existing.CreatedAt
		if len(req.DNSCreds) == 0 {
			job.DNSCreds = existing.DNSCreds
		}
	}

	creds := mergeCreds(existingCreds(existing), req.DNSCreds)
	if len(creds) > 0 {
		sealed, err := a.deps.Box.SealMap(creds)
		if err != nil {
			return nil, fmt.Errorf("protect the dns credentials: %w", err)
		}
		job.DNSCreds = sealed
	}
	return &job, nil
}

func existingCreds(job *model.CertJob) map[string]string {
	if job == nil {
		return map[string]string{}
	}
	return job.DNSCreds
}

// jobView renders a job with masked credentials.
func (a *ACME) jobView(job model.CertJob) certJobView {
	return certJobView{
		CertJob:       job,
		DNSCreds:      maskCreds(job.DNSCreds),
		HasCreds:      len(job.DNSCreds) > 0,
		DomainsJoined: strings.Join(job.Domains, ", "),
	}
}

// ---------------------------------------------------------------------------
// certificates
// ---------------------------------------------------------------------------

func (a *ACME) handleListCertificates(w http.ResponseWriter, r *http.Request) {
	list := a.deps.Certs.List()
	items := make([]certificateView, 0, len(list))
	now := time.Now()
	for _, info := range list {
		view := certificateView{
			ID:        info.ID,
			Domains:   info.Domains,
			Issuer:    info.Issuer,
			NotBefore: info.NotBefore,
			NotAfter:  info.NotAfter,
			Source:    info.Source,
			JobID:     info.JobID,
			AutoRenew: info.AutoRenew,
			UpdatedAt: info.UpdatedAt,
			KeyType:   info.KeyType,
			Expired:   now.After(info.NotAfter),
		}
		if info.Domains == nil {
			view.Domains = []string{}
		}
		view.DaysLeft = int(info.NotAfter.Sub(now).Hours() / 24)
		items = append(items, view)
	}
	rest.OK(w, map[string]any{"items": items})
}

func (a *ACME) handleDeleteCertificate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := a.deps.Certs.Get(id); !ok {
		rest.Fail(w, http.StatusNotFound, "certificate %s does not exist", id)
		return
	}
	if err := a.deps.Certs.Delete(id); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "cannot delete the certificate: %s", err)
		return
	}
	a.refreshStats(nil)
	rest.NoContent(w)
}

func (a *ACME) handleUploadCertificate(w http.ResponseWriter, r *http.Request) {
	var req certificateUpload
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	req.normalize()
	if strings.TrimSpace(req.Cert) == "" || strings.TrimSpace(req.Key) == "" {
		rest.Fail(w, http.StatusBadRequest, "both the certificate chain and the private key are required")
		return
	}
	leaf, err := decodeLeaf([]byte(req.Cert))
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "invalid certificate: %s", err)
		return
	}
	if _, err := publicKeyOf([]byte(req.Key)); err != nil {
		rest.Fail(w, http.StatusBadRequest, "invalid private key: %s", err)
		return
	}
	domains, err := normalizeDomains(req.Domains)
	if err != nil {
		// Without an explicit domain list the certificate decides.
		domains = nil
	}
	if len(domains) > 0 {
		if missing := missingDomains(leaf.DNSNames, domains); len(missing) > 0 {
			rest.Fail(w, http.StatusBadRequest, "the certificate does not cover %s", strings.Join(missing, ", "))
			return
		}
	} else if len(leaf.DNSNames) > 0 {
		domains = leaf.DNSNames
	} else if leaf.Subject.CommonName != "" {
		domains = []string{leaf.Subject.CommonName}
	} else {
		rest.Fail(w, http.StatusBadRequest, "the certificate has no subject alternative names")
		return
	}
	info, err := a.deps.Certs.Add(domains, []byte(req.Cert), []byte(req.Key), "upload", "", false)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot store the certificate: %s", err)
		return
	}
	a.refreshStats(nil)
	rest.OK(w, info)
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

func (a *ACME) handleProviders(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, dnsprov.Default().List())
}

func (a *ACME) handleStatus(w http.ResponseWriter, r *http.Request) {
	a.refreshStats(nil)
	status := a.Status()
	rest.OK(w, map[string]any{"status": status, "challenges": challengeCatalog(), "authorities": caCatalog()})
}

// challengeCatalog lists the supported challenge types for the UI.
func challengeCatalog() []map[string]string {
	return []map[string]string{
		{"id": challengeHTTP, "wire": wireHTTP01, "title": "HTTP-01 (port 80)"},
		{"id": challengeDNS, "wire": wireDNS01, "title": "DNS-01 (TXT record)"},
		{"id": challengeTLSALPN, "wire": wireTLSALPN01, "title": "TLS-ALPN-01 (port 443)"},
	}
}
