// Package ddns keeps DNS records pointed at the current public address.
package ddns

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/nunt/nunt/internal/dnsprov"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/rest"
)

// logKeep is the number of execution records kept per rule.
const logKeep = 20

type execRecord struct {
	Time    time.Time `json:"time"`
	OK      bool      `json:"ok"`
	Message string    `json:"message"`
}

type ruleState struct {
	mu          sync.Mutex
	ipv4        string
	ipv6        string
	lastRun     time.Time
	lastSuccess time.Time
	lastError   string
	success     int
	failures    int
	records     []execRecord
	pushed      map[string]string
	fullSyncAt  time.Time
}

func newRuleState() *ruleState {
	return &ruleState{pushed: map[string]string{}}
}

func (s *ruleState) record(ok bool, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	s.lastRun = now
	if ok {
		s.lastSuccess = now
		s.success++
		s.lastError = ""
	} else {
		s.failures++
		s.lastError = message
	}
	s.records = append(s.records, execRecord{Time: now, OK: ok, Message: message})
	if len(s.records) > logKeep {
		s.records = s.records[len(s.records)-logKeep:]
	}
}

// statusView is the JSON shape returned by the status endpoint.
type statusView struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Enable      bool         `json:"enable"`
	IPv4        string       `json:"ipv4,omitempty"`
	IPv6        string       `json:"ipv6,omitempty"`
	LastRun     *time.Time   `json:"lastRun,omitempty"`
	LastSuccess *time.Time   `json:"lastSuccess,omitempty"`
	LastError   string       `json:"lastError,omitempty"`
	Success     int          `json:"success"`
	Failures    int          `json:"failures"`
	Records     []execRecord `json:"records"`
}

// DDNS is the dynamic DNS module.
type DDNS struct {
	module.Base
	deps *module.Deps

	mu      sync.Mutex
	cron    *cron.Cron
	entries map[string]cron.EntryID
	states  map[string]*ruleState
	locks   map[string]*sync.Mutex
}

// New creates the module.
func New(deps *module.Deps) *DDNS {
	d := &DDNS{
		deps:    deps,
		entries: map[string]cron.EntryID{},
		states:  map[string]*ruleState{},
		locks:   map[string]*sync.Mutex{},
	}
	d.Init(deps, "ddns", "动态域名")
	return d
}

// Start schedules every enabled rule and runs each of them once.
func (d *DDNS) Start(ctx context.Context) error {
	d.mu.Lock()
	if d.cron != nil {
		d.mu.Unlock()
		return nil
	}
	d.cron = cron.New()
	d.mu.Unlock()

	d.applySchedule(d.deps.Cfg.Snapshot())
	d.mu.Lock()
	d.cron.Start()
	d.mu.Unlock()

	cfg := d.deps.Cfg.Snapshot()
	enabled := 0
	for _, rule := range cfg.DDNS.Rules {
		if rule.Enable {
			enabled++
		}
	}
	d.deps.Logger("ddns").Info("DDNS：调度器已启动", "rules", len(cfg.DDNS.Rules), "enabled", enabled)
	d.SetRunning(true)
	d.SetDetail("调度器已启动")
	return nil
}

// Stop cancels the scheduler.
func (d *DDNS) Stop(context.Context) error {
	d.mu.Lock()
	c := d.cron
	d.cron = nil
	d.entries = map[string]cron.EntryID{}
	d.mu.Unlock()
	if c != nil {
		c.Stop()
	}
	d.deps.Logger("ddns").Info("DDNS：调度器已停止")
	d.SetRunning(false)
	return nil
}

// Reload rebuilds the schedule from the configuration.
func (d *DDNS) Reload(cfg *model.Config) {
	d.mu.Lock()
	c := d.cron
	d.mu.Unlock()
	if c == nil {
		return
	}
	d.applySchedule(cfg)
}

func (d *DDNS) applySchedule(cfg *model.Config) {
	d.mu.Lock()
	c := d.cron
	if c == nil {
		d.mu.Unlock()
		return
	}
	for _, id := range d.entries {
		c.Remove(id)
	}
	d.entries = map[string]cron.EntryID{}
	seen := map[string]bool{}
	d.mu.Unlock()

	for i := range cfg.DDNS.Rules {
		rule := cfg.DDNS.Rules[i]
		seen[rule.ID] = true
		if !rule.Enable {
			continue
		}
		r := rule
		spec := strings.TrimSpace(r.Cron)
		if spec == "" {
			interval := r.IntervalSec
			if interval <= 0 {
				interval = 300
			}
			spec = fmt.Sprintf("@every %ds", interval)
		}
		entryID, err := c.AddFunc(spec, func() { d.runRule(context.Background(), r.ID) })
		if err != nil {
			d.deps.Logger("ddns").Error("DDNS：规则的调度表达式无效",
				"rule", r.Name, "schedule", spec, "error", err)
			d.SetError(fmt.Errorf("rule %s: invalid schedule %q: %w", r.Name, spec, err))
			continue
		}
		d.deps.Logger("ddns").Debug("DDNS：规则已加入调度",
			"rule", r.Name, "domain", r.Domain, "schedule", spec, "provider", r.Provider)
		d.mu.Lock()
		d.entries[r.ID] = entryID
		d.stateLocked(r.ID)
		d.mu.Unlock()

		// Run once on startup so a rebooted device updates quickly, but only
		// for rules that have not run in the last minute.
		st := d.state(r.ID)
		if st == nil || time.Since(st.snapshot().lastRun) > time.Minute {
			go d.runRule(context.Background(), r.ID)
		}
	}

	d.mu.Lock()
	for id := range d.states {
		if !seen[id] {
			delete(d.states, id)
			delete(d.locks, id)
		}
	}
	d.mu.Unlock()
	d.SetError(nil)
}

func (d *DDNS) stateLocked(id string) *ruleState {
	st, ok := d.states[id]
	if !ok {
		st = newRuleState()
		d.states[id] = st
	}
	if _, ok := d.locks[id]; !ok {
		d.locks[id] = &sync.Mutex{}
	}
	return st
}

func (d *DDNS) state(id string) *ruleState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.stateLocked(id)
}

type stateSnapshot struct {
	lastRun time.Time
}

func (s *ruleState) snapshot() stateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return stateSnapshot{lastRun: s.lastRun}
}

// RegisterAPI mounts the REST endpoints.
func (d *DDNS) RegisterAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/ddns")
	g.Get("/rules", d.handleListRules)
	g.Post("/rules", d.handleCreateRule)
	g.Put("/rules/{id}", d.handleUpdateRule)
	g.Delete("/rules/{id}", d.handleDeleteRule)
	g.Post("/rules/{id}/toggle", d.handleToggleRule)
	g.Post("/rules/{id}/run", d.handleRunRule)
	g.Get("/providers", d.handleProviders)
	g.Post("/providers/test", d.handleProviderTest)
	g.Get("/status", d.handleStatus)
	g.Post("/reload", d.handleReload)
}

// Status adds the module counters to the base status.
func (d *DDNS) Status() module.Status {
	st := d.Base.Status()
	rules := d.deps.Cfg.Snapshot().DDNS.Rules
	enabled := 0
	for _, r := range rules {
		if r.Enable {
			enabled++
		}
	}
	var successes, failures int
	d.mu.Lock()
	states := make([]*ruleState, 0, len(d.states))
	for _, s := range d.states {
		states = append(states, s)
	}
	d.mu.Unlock()
	for _, s := range states {
		s.mu.Lock()
		successes += s.success
		failures += s.failures
		s.mu.Unlock()
	}
	st.Stats = map[string]any{
		"rules":    len(rules),
		"enabled":  enabled,
		"success":  successes,
		"failures": failures,
	}
	return st
}

// statuses returns a stable, sorted view of every known rule state.
func (d *DDNS) statuses() []statusView {
	cfg := d.deps.Cfg.Snapshot()
	out := make([]statusView, 0, len(cfg.DDNS.Rules))
	for _, rule := range cfg.DDNS.Rules {
		view := statusView{ID: rule.ID, Name: rule.Name, Enable: rule.Enable}
		if st := d.state(rule.ID); st != nil {
			st.mu.Lock()
			view.IPv4 = st.ipv4
			view.IPv6 = st.ipv6
			view.LastError = st.lastError
			view.Success = st.success
			view.Failures = st.failures
			view.Records = append([]execRecord{}, st.records...)
			if !st.lastRun.IsZero() {
				t := st.lastRun
				view.LastRun = &t
			}
			if !st.lastSuccess.IsZero() {
				t := st.lastSuccess
				view.LastSuccess = &t
			}
			st.mu.Unlock()
		}
		out = append(out, view)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// runRule executes one rule: discover the address, then update every record.
func (d *DDNS) runRule(ctx context.Context, ruleID string) {
	cfg := d.deps.Cfg.Snapshot()
	var rule *model.DDNSRule
	for i := range cfg.DDNS.Rules {
		if cfg.DDNS.Rules[i].ID == ruleID {
			r := cfg.DDNS.Rules[i]
			rule = &r
			break
		}
	}
	if rule == nil || !rule.Enable {
		return
	}

	lock := d.lockFor(ruleID)
	if !lock.TryLock() {
		return
	}
	defer lock.Unlock()

	st := d.state(ruleID)
	log := d.deps.Logger("ddns")
	started := time.Now()
	log.Debug("DDNS：开始执行规则", "rule", rule.Name, "domain", rule.Domain, "provider", rule.Provider)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	creds, err := d.credentials(rule)
	if err != nil {
		log.Error("DDNS：读取凭据失败", "rule", rule.Name, "error", err)
		st.record(false, "凭据："+err.Error())
		return
	}

	provider, err := dnsprov.Default().New(rule.Provider, creds)
	if err != nil {
		log.Error("DDNS：无法初始化 DNS 提供商", "rule", rule.Name, "provider", rule.Provider, "error", err)
		st.record(false, "提供商："+err.Error())
		return
	}

	var changed []string
	var messages []string
	failed := false

	for _, want := range []struct {
		family string
		ipType string
		get    model.GetIP
	}{{"4", "A", rule.IPv4}, {"6", "AAAA", rule.IPv6}} {
		if !want.get.Enable {
			continue
		}
		ip, err := detectIP(ctx, want.get, want.family)
		if err != nil || ip == "" {
			failed = true
			log.Warn("DDNS：无法获取公网地址", "rule", rule.Name, "family", want.family, "error", err)
			message := fmt.Sprintf("IPv%s：%v", want.family, err)
			messages = append(messages, message)
			st.record(false, message)
			continue
		}
		st.mu.Lock()
		if want.family == "4" {
			st.ipv4 = ip
		} else {
			st.ipv6 = ip
		}
		st.mu.Unlock()

		for _, sub := range subDomains(rule) {
			rec := dnsprov.Record{
				Domain:    rule.Domain,
				SubDomain: sub,
				Type:      want.ipType,
				Value:     ip,
				TTL:       rule.TTL,
			}
			key := want.ipType + "/" + sub
			st.mu.Lock()
			already := st.pushed[key] == ip
			forceSync := time.Since(st.fullSyncAt) > 24*time.Hour
			st.mu.Unlock()
			if already && !forceSync {
				continue
			}
			if err := provider.Set(ctx, rec); err != nil {
				failed = true
				log.Warn("DDNS：记录更新失败",
					"rule", rule.Name, "record", rec.FQDN(), "type", want.ipType, "error", err)
				message := fmt.Sprintf("%s %s: %v", rec.FQDN(), want.ipType, err)
				messages = append(messages, message)
				st.record(false, message)
				continue
			}
			st.mu.Lock()
			st.pushed[key] = ip
			st.fullSyncAt = time.Now()
			st.mu.Unlock()
			changed = append(changed, rec.FQDN())
		}
	}

	summary := "无变化"
	if failed {
		summary = strings.Join(messages, "; ")
		log.Warn("DDNS：规则执行失败",
			"rule", rule.Name, "domain", rule.Domain,
			"duration", time.Since(started).Round(time.Millisecond).String(),
			"error", summary)
		st.record(false, summary)
		return
	}
	if len(changed) > 0 {
		summary = "已更新 " + strings.Join(changed, "、")
		log.Info("DDNS：记录已更新",
			"rule", rule.Name, "domain", rule.Domain, "count", len(changed),
			"records", strings.Join(changed, "、"),
			"duration", time.Since(started).Round(time.Millisecond).String())
	} else {
		log.Debug("DDNS：公网地址未变化", "rule", rule.Name, "domain", rule.Domain)
	}
	st.record(true, summary)
}

func (d *DDNS) lockFor(id string) *sync.Mutex {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.locks[id]; !ok {
		d.locks[id] = &sync.Mutex{}
	}
	return d.locks[id]
}

// credentials decrypts the provider credentials of a rule.
func (d *DDNS) credentials(rule *model.DDNSRule) (dnsprov.Credentials, error) {
	plain, err := d.deps.Box.OpenMap(rule.Creds)
	if err != nil {
		return nil, err
	}
	creds := dnsprov.Credentials{}
	for k, v := range plain {
		creds[k] = v
	}
	return creds, nil
}

func subDomains(rule *model.DDNSRule) []string {
	out := make([]string, 0, len(rule.SubDomains))
	for _, s := range rule.SubDomains {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		out = append(out, "@")
	}
	return out
}
