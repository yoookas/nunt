// Package acme issues and renews TLS certificates through ACME
// (RFC 8555) using golang.org/x/crypto/acme.
//
// The module owns three things:
//
//   - the ACME account (key + registration) shared by every job,
//   - certificate jobs persisted in the configuration document,
//   - a renewal loop that keeps stored certificates valid.
//
// It also implements module.CertProvider so the web service can obtain a
// certificate on demand for a host it is about to serve.
package acme

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/certs"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
)

// Module tuning constants.
const (
	// moduleName is the module id used by the API and the task module.
	moduleName = "acme"
	// moduleTitle is the short human readable name.
	moduleTitle = "Certificates"

	// defaultRenewDays is used when a job does not set renewDays.
	defaultRenewDays = 30
	// maxRenewDays is the widest renewal window a job may ask for. A window
	// wider than the lifetime of the certificate would renew it on every check.
	maxRenewDays = 30
	// checkInterval is how often the renewal loop wakes up.
	checkInterval = 12 * time.Hour
	// initialDelay staggers the first check after Start.
	initialDelay = 5 * time.Second
	// retryBase and retryMax bound the exponential backoff of a failing job.
	retryBase = time.Hour
	retryMax  = 6 * time.Hour
	// issueTimeout bounds one issuance attempt.
	issueTimeout = 10 * time.Minute
)

// ACME is the certificate module.
type ACME struct {
	module.Base
	deps *module.Deps
	log  *slog.Logger

	account *accountManager

	// mu guards stopCh/wg.
	mu     sync.Mutex
	stopCh chan struct{}
	wg     sync.WaitGroup

	// schedMu guards the renewal schedule and the per job backoff state.
	schedMu   sync.Mutex
	nextCheck time.Time
	attempts  map[string]*attempt

	// flightMu implements single flight issuance per domain set.
	flightMu sync.Mutex
	flight   map[string]*flightCall

	// jobMu serialises issuance per job so the renewal loop and an explicit
	// "issue now" never run the same order twice.
	jobMu map[string]*sync.Mutex

	// challenges maps a /.well-known/acme-challenge/<token> path to its answer
	// while the CA validates it. The web service reads it when it owns port 80.
	challenges sync.Map

	// statMu guards the counters shown on the dashboard.
	statMu  sync.Mutex
	lastErr string
}

// attempt tracks the retry state of a failing job.
type attempt struct {
	count int
	next  time.Time
}

// flightCall is one in-flight issuance shared by concurrent callers.
type flightCall struct {
	done chan struct{}
	err  error
}

// New creates the module.
func New(deps *module.Deps) *ACME {
	a := &ACME{
		deps:     deps,
		log:      deps.Logger(moduleName),
		attempts: map[string]*attempt{},
		flight:   map[string]*flightCall{},
		jobMu:    map[string]*sync.Mutex{},
	}
	a.Init(deps, moduleName, moduleTitle)
	a.account = newAccountManager(deps, a.log)
	return a
}

// Start launches the renewal loop. It is safe to call more than once.
func (a *ACME) Start(ctx context.Context) error {
	a.mu.Lock()
	if a.stopCh != nil {
		a.mu.Unlock()
		a.SetRunning(true)
		return nil
	}
	stop := make(chan struct{})
	a.stopCh = stop
	a.mu.Unlock()

	a.schedMu.Lock()
	a.nextCheck = time.Now().Add(initialDelay)
	a.schedMu.Unlock()

	a.wg.Add(1)
	go a.loop(stop)

	a.SetRunning(true)
	a.SetDetail("renewal loop running")
	a.refreshStats(nil)
	return nil
}

// Stop cancels the renewal loop and waits for it to exit. It is idempotent.
func (a *ACME) Stop(ctx context.Context) error {
	a.mu.Lock()
	stop := a.stopCh
	a.stopCh = nil
	a.mu.Unlock()

	if stop != nil {
		close(stop)
	}
	waitTimeout(&a.wg, 5*time.Second)
	a.SetRunning(false)
	a.SetDetail("stopped")
	return nil
}

// Reload applies a new configuration. It never blocks and never writes the
// configuration back.
func (a *ACME) Reload(cfg *model.Config) {
	if cfg == nil {
		return
	}
	a.schedMu.Lock()
	for id := range a.attempts {
		if findJob(cfg, id) == nil {
			delete(a.attempts, id)
		}
	}
	a.schedMu.Unlock()

	a.mu.Lock()
	stop := a.stopCh
	a.mu.Unlock()
	if stop != nil {
		a.kick()
	}
}

// kick wakes the renewal loop without waiting for the next tick.
func (a *ACME) kick() {
	a.schedMu.Lock()
	if a.nextCheck.After(time.Now()) {
		a.nextCheck = time.Now()
	}
	a.schedMu.Unlock()
}

// loop is the renewal scheduler. It returns as soon as stop is closed.
func (a *ACME) loop(stop chan struct{}) {
	defer a.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), issueTimeout+time.Minute)
			a.tick(ctx)
			cancel()
		}
	}
}

// tick runs whatever the schedule says is due.
func (a *ACME) tick(ctx context.Context) {
	cfg := a.deps.Cfg.Snapshot()
	now := time.Now()

	a.schedMu.Lock()
	due := !now.Before(a.nextCheck)
	var retries []string
	if !due {
		for id, at := range a.attempts {
			if at != nil && !now.Before(at.next) {
				retries = append(retries, id)
			}
		}
	}
	if due {
		a.nextCheck = now.Add(checkInterval)
	}
	sort.Strings(retries)
	a.schedMu.Unlock()

	if due {
		a.checkDue(ctx, cfg)
	}
	for _, id := range retries {
		job := findJob(cfg, id)
		if job == nil || !job.Enable {
			a.schedMu.Lock()
			delete(a.attempts, id)
			a.schedMu.Unlock()
			continue
		}
		a.runJob(ctx, *job, true)
	}
	a.refreshStats(cfg)
}

// checkDue renews every stored certificate that is close to expiry.
func (a *ACME) checkDue(ctx context.Context, cfg *model.Config) {
	if a.deps.Certs == nil {
		return
	}
	window := renewWindow(cfg)
	for _, info := range a.deps.Certs.DueForRenew(window) {
		if ctx.Err() != nil {
			return
		}
		if info.Source != source && info.JobID == "" {
			// Certificates uploaded by hand are never touched.
			continue
		}
		job := findJob(cfg, info.JobID)
		if job == nil || !job.Enable {
			continue
		}
		// Re-check the threshold with the job's own renewDays value.
		days := job.RenewDays
		if days <= 0 {
			days = defaultRenewDays
		}
		if days > maxRenewDays {
			days = maxRenewDays
		}
		if time.Until(info.NotAfter) > time.Duration(days)*24*time.Hour {
			continue
		}
		a.log.Info("certificate due for renewal", "job", job.Name, "domains", info.Domains,
			"notAfter", info.NotAfter.Format(time.RFC3339))
		a.SetDetail(fmt.Sprintf("renewing certificate for %s", info.Domains[0]))
		a.runJob(ctx, *job, true)
	}
}

// runJob issues one job synchronously and updates the backoff state. It is a
// no-op when the same job is already being issued.
func (a *ACME) runJob(ctx context.Context, job model.CertJob, automatic bool) {
	lock := a.jobLock(job.ID)
	if !lock.TryLock() {
		return
	}
	defer lock.Unlock()

	cfg := a.deps.Cfg.Snapshot()
	req := newRequest(cfg, job)
	_, err := a.issue(ctx, req)
	if err != nil {
		a.recordFailure(job.ID, err)
		a.deps.Notify.Emit(notifyCertFailed, "certificate issuance failed",
			fmt.Sprintf("%s: %s", jobLabel(job), err),
			map[string]any{"jobId": job.ID, "domains": job.Domains, "automatic": automatic})
		a.log.Error("certificate issuance failed", "job", job.Name, "error", err)
		a.refreshStats(cfg)
		return
	}
	a.recordSuccess(job.ID)
	a.deps.Notify.Emit(notifyCertIssued, "certificate issued",
		fmt.Sprintf("%s: certificate stored", jobLabel(job)),
		map[string]any{"jobId": job.ID, "domains": job.Domains, "automatic": automatic})
	a.SetError(nil)
	a.log.Info("certificate issued", "job", job.Name, "domains", job.Domains)
	a.refreshStats(cfg)
}

// jobLock returns the per job issuance mutex.
func (a *ACME) jobLock(id string) *sync.Mutex {
	a.schedMu.Lock()
	defer a.schedMu.Unlock()
	if a.jobMu == nil {
		a.jobMu = map[string]*sync.Mutex{}
	}
	if mu, ok := a.jobMu[id]; ok {
		return mu
	}
	mu := &sync.Mutex{}
	a.jobMu[id] = mu
	return mu
}

func (a *ACME) recordFailure(id string, err error) {
	a.schedMu.Lock()
	at := a.attempts[id]
	if at == nil {
		at = &attempt{}
		a.attempts[id] = at
	}
	at.count++
	at.next = time.Now().Add(backoff(at.count))
	delay := time.Until(at.next)
	a.schedMu.Unlock()

	a.SetError(fmt.Errorf("job %s: %w", id, err))
	a.statMu.Lock()
	a.lastErr = err.Error()
	a.statMu.Unlock()
	a.SetDetail(fmt.Sprintf("retrying in %s", delay.Round(time.Minute)))
}

func (a *ACME) recordSuccess(id string) {
	a.schedMu.Lock()
	delete(a.attempts, id)
	a.schedMu.Unlock()
	a.statMu.Lock()
	a.lastErr = ""
	a.statMu.Unlock()
}

// backoff returns the delay before the nth retry (1 based): 1h, 2h, 4h, 6h.
func backoff(n int) time.Duration {
	if n < 1 {
		n = 1
	}
	d := retryBase
	for i := 1; i < n && d < retryMax; i++ {
		d *= 2
	}
	if d > retryMax {
		d = retryMax
	}
	return d
}

// ---------------------------------------------------------------------------
// module.CertProvider
// ---------------------------------------------------------------------------

// EnsureCertificate implements module.CertProvider. Concurrent calls for the
// same domain set share a single issuance attempt.
func (a *ACME) EnsureCertificate(ctx context.Context, domains []string) error {
	names, err := normalizeDomains(domains)
	if err != nil {
		return err
	}
	if a.HasCertificate(names) {
		return nil
	}

	key := domainsKey(names)
	a.flightMu.Lock()
	if call, ok := a.flight[key]; ok {
		a.flightMu.Unlock()
		select {
		case <-call.done:
			return call.err
		case <-ctx.Done():
			return fmt.Errorf("waiting for certificate for %v: %w", names, ctx.Err())
		}
	}
	call := &flightCall{done: make(chan struct{})}
	a.flight[key] = call
	a.flightMu.Unlock()

	// The issuance runs on its own context so that one caller giving up does
	// not abort a certificate another caller is still waiting for. It is still
	// bounded and honours a shorter deadline passed by the caller.
	runCtx, cancel := context.WithTimeout(ctx, issueTimeout)
	defer cancel()

	call.err = a.ensureOnce(runCtx, names)
	close(call.done)

	a.flightMu.Lock()
	delete(a.flight, key)
	a.flightMu.Unlock()
	return call.err
}

// ensureOnce issues a certificate for the domains, preferring a configured job.
func (a *ACME) ensureOnce(ctx context.Context, names []string) error {
	cfg := a.deps.Cfg.Snapshot()
	job, hasJob := matchJob(cfg, names)
	if !hasJob {
		// No job covers these domains: build a one shot job from the defaults.
		job = model.CertJob{
			ID:        "on-demand-" + domainsKey(names),
			Name:      "on demand: " + names[0],
			Enable:    true,
			Domains:   names,
			Challenge: defaultChallenge(),
			KeyType:   cfg.ACME.KeyType,
			RenewDays: defaultRenewDays,
			CreatedAt: time.Now(),
		}
	}
	lock := a.jobLock(job.ID)
	if !lock.TryLock() {
		return fmt.Errorf("another issuance for %s is already running", jobLabel(job))
	}
	defer lock.Unlock()

	req := newRequest(cfg, job)
	if hasJob {
		req.persist = true
	}
	_, err := a.issue(ctx, req)
	if err != nil {
		a.recordFailure(job.ID, err)
		a.SetError(fmt.Errorf("issue for %v: %w", names, err))
		a.deps.Notify.Emit(notifyCertFailed, "on demand certificate failed",
			fmt.Sprintf("%s: %s", jobLabel(job), err),
			map[string]any{"jobId": job.ID, "domains": names})
		return err
	}
	a.recordSuccess(job.ID)
	a.SetError(nil)
	a.deps.Notify.Emit(notifyCertIssued, "certificate issued",
		fmt.Sprintf("%s: certificate stored", jobLabel(job)),
		map[string]any{"jobId": job.ID, "domains": names})
	a.refreshStats(cfg)
	return nil
}

// HasCertificate implements module.CertProvider.
func (a *ACME) HasCertificate(domains []string) bool {
	if a.deps.Certs == nil {
		return false
	}
	names, err := normalizeDomains(domains)
	if err != nil {
		return false
	}
	for _, info := range a.deps.Certs.List() {
		if time.Now().After(info.NotAfter) {
			continue
		}
		if coversAll(info.Domains, names) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

// refreshStats recomputes the dashboard counters.
func (a *ACME) refreshStats(cfg *model.Config) {
	if cfg == nil {
		cfg = a.deps.Cfg.Snapshot()
	}
	stats := map[string]any{
		"jobs":        len(cfg.ACME.Jobs),
		"enabledJobs": 0,
		"ca":          cfg.ACME.CA,
		"challenge":   defaultChallenge(),
	}
	for _, j := range cfg.ACME.Jobs {
		if j.Enable {
			stats["enabledJobs"] = stats["enabledJobs"].(int) + 1
		}
	}

	managed := a.managedCertificates()
	stats["certificates"] = len(managed)
	stats["domains"] = countDomains(managed)

	now := time.Now()
	valid := 0
	var next *certs.Info
	for i := range managed {
		if now.After(managed[i].NotAfter) {
			continue
		}
		valid++
		if next == nil || managed[i].NotAfter.Before(next.NotAfter) {
			next = &managed[i]
		}
	}
	stats["validCertificates"] = valid
	if next != nil {
		stats["nextExpiry"] = next.NotAfter
		stats["nextExpiryId"] = next.ID
		stats["nextExpiryDays"] = int(time.Until(next.NotAfter).Hours() / 24)
	}

	a.statMu.Lock()
	lastErr := a.lastErr
	a.statMu.Unlock()
	if lastErr == "" {
		stats["lastError"] = nil
	} else {
		stats["lastError"] = lastErr
	}
	a.SetStats(stats)
}

// managedCertificates returns the certificates issued by this module.
func (a *ACME) managedCertificates() []certs.Info {
	if a.deps.Certs == nil {
		return nil
	}
	var out []certs.Info
	for _, info := range a.deps.Certs.List() {
		if info.Source == source && info.JobID != "" {
			out = append(out, info)
		}
	}
	return out
}

func countDomains(items []certs.Info) int {
	seen := map[string]struct{}{}
	for _, info := range items {
		for _, d := range info.Domains {
			seen[strings.ToLower(d)] = struct{}{}
		}
	}
	return len(seen)
}

// waitTimeout waits for wg but never longer than d.
func waitTimeout(wg *sync.WaitGroup, d time.Duration) {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(d):
	}
}

// RegisterAPI mounts the REST endpoints under /api/v1/acme.
func (a *ACME) RegisterAPI(mux *rest.Mux) {
	a.registerAPI(mux)
}
