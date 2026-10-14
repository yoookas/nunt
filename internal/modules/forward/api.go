package forward

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
	"github.com/nunt/nunt/internal/rest"
)

// registerAPI mounts /api/v1/forward/. Authentication, CSRF and rate limiting
// are applied by the parent mux.
func (f *Forward) registerAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/forward")
	g.Get("/rules", f.handleListRules)
	g.Post("/rules", f.handleCreateRule)
	g.Put("/rules/{id}", f.handleUpdateRule)
	g.Delete("/rules/{id}", f.handleDeleteRule)
	g.Post("/rules/{id}/toggle", f.handleToggleRule)
	g.Post("/reload", f.handleReload)
	g.Get("/logs", f.handleLogs)
}

// ruleView is a rule plus its live counters, so the UI can show per rule
// connection numbers without a second request.
type ruleView struct {
	model.ForwardRule
	ActiveConns int    `json:"activeConns"`
	TotalConns  uint64 `json:"totalConns"`
	UpBytes     uint64 `json:"upBytes"`
	DownBytes   uint64 `json:"downBytes"`
	Listening   bool   `json:"listening"`
	// ConnLimit and ConnLimitPerIP repeat the configured caps with the value
	// actually enforced, so the user interface never has to know the fallback
	// rules. Zero means the rule is not capped.
	ConnLimit      int `json:"connLimit"`
	ConnLimitPerIP int `json:"connLimitPerIp"`
	// RejectedRuleLimit and RejectedIPLimit count the connections refused by
	// those caps.
	RejectedRuleLimit uint64 `json:"rejectedRuleLimit"`
	RejectedIPLimit   uint64 `json:"rejectedIpLimit"`
}

func (f *Forward) handleListRules(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, f.ruleViews())
}

// ruleViews merges the configured rules with the counters of the running
// proxies.
func (f *Forward) ruleViews() []ruleView {
	f.mu.RLock()
	var rules []model.ForwardRule
	if f.cfg != nil {
		rules = append(rules, f.cfg.Forward.Rules...)
	}
	proxies := make([]*proxy, 0, len(f.proxies))
	for _, p := range f.proxies {
		proxies = append(proxies, p)
	}
	f.mu.RUnlock()

	out := make([]ruleView, 0, len(rules))
	for _, rule := range rules {
		view := ruleView{
			ForwardRule:    rule,
			ConnLimit:      maxConns(rule),
			ConnLimitPerIP: maxConnsPerIP(rule),
		}
		for _, p := range proxies {
			if p.rule.ID != rule.ID {
				continue
			}
			view.ActiveConns += int(p.active.Load())
			view.TotalConns += p.total.Load()
			view.UpBytes += p.upBytes.Load()
			view.DownBytes += p.downBytes.Load()
			view.RejectedRuleLimit += p.rejectedRule.Load()
			view.RejectedIPLimit += p.rejectedIP.Load()
			if p.isRunning() {
				view.Listening = true
			}
		}
		out = append(out, view)
	}
	return out
}

func (f *Forward) handleCreateRule(w http.ResponseWriter, r *http.Request) {
	var rule model.ForwardRule
	if err := rest.Decode(w, r, &rule); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	withRuleIDs(&rule)
	if err := validateRule(rule); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}

	now := time.Now()
	rule.CreatedAt = now
	rule.UpdatedAt = now
	if err := f.deps.Cfg.Update(func(c *model.Config) error {
		for _, existing := range c.Forward.Rules {
			if existing.ID == rule.ID {
				return errors.New("a rule with this id already exists")
			}
		}
		c.Forward.Rules = append(c.Forward.Rules, rule)
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the rule: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	rest.JSON(w, http.StatusCreated, rule)
}

func (f *Forward) handleUpdateRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var rule model.ForwardRule
	if err := rest.Decode(w, r, &rule); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	rule.ID = id
	withRuleIDs(&rule)
	if err := validateRule(rule); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	rule.UpdatedAt = time.Now()
	var stored model.ForwardRule
	found := false
	if err := f.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.Forward.Rules {
			if c.Forward.Rules[i].ID != id {
				continue
			}
			rule.CreatedAt = c.Forward.Rules[i].CreatedAt
			c.Forward.Rules[i] = rule
			stored = rule
			found = true
			return nil
		}
		return errors.New("rule not found")
	}); err != nil {
		status := http.StatusBadRequest
		if !found {
			status = http.StatusNotFound
		}
		rest.Fail(w, status, "cannot update the rule: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	rest.OK(w, stored)
}

func (f *Forward) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := f.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.Forward.Rules {
			if c.Forward.Rules[i].ID == id {
				c.Forward.Rules = append(c.Forward.Rules[:i], c.Forward.Rules[i+1:]...)
				return nil
			}
		}
		return errors.New("rule not found")
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "cannot delete the rule: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"deleted": id})
}

// handleToggleRule flips a rule. The body is optional: {"enable":true} sets an
// explicit state, an empty body toggles the current one.
func (f *Forward) handleToggleRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	requested, ok, err := decodeEnable(w, r)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	var updated model.ForwardRule
	found := false
	err = f.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.Forward.Rules {
			if c.Forward.Rules[i].ID != id {
				continue
			}
			next := !c.Forward.Rules[i].Enable
			if ok {
				next = requested
			}
			c.Forward.Rules[i].Enable = next
			c.Forward.Rules[i].UpdatedAt = time.Now()
			updated = c.Forward.Rules[i]
			found = true
			return nil
		}
		return errors.New("rule not found")
	})
	if err != nil {
		status := http.StatusBadRequest
		if !found {
			status = http.StatusNotFound
		}
		rest.Fail(w, status, "cannot toggle the rule: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	rest.OK(w, updated)
}

func (f *Forward) handleReload(w http.ResponseWriter, r *http.Request) {
	f.Reload(f.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"reloaded": true, "stats": f.Stats()})
}

func (f *Forward) handleLogs(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	ruleID := strings.TrimSpace(r.URL.Query().Get("rule"))
	entries := f.access.list(ruleID, limit)
	rest.OK(w, map[string]any{"items": entries, "total": len(entries), "enabled": f.access.enabledNow()})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// decodeEnable reads an optional {"enable":bool} toggle body. ok is false when
// the body is absent or does not carry an explicit state.
func decodeEnable(w http.ResponseWriter, r *http.Request) (bool, bool, error) {
	if r.Body == nil || r.ContentLength == 0 {
		return false, false, nil
	}
	var body struct {
		Enable *bool `json:"enable"`
	}
	if err := rest.Decode(w, r, &body); err != nil {
		return false, false, err
	}
	if body.Enable == nil {
		return false, false, nil
	}
	return *body.Enable, true, nil
}

// withRuleIDs fills the identifier and the protocol default of a submitted
// rule so that it is complete before it reaches the configuration store.
func withRuleIDs(rule *model.ForwardRule) {
	if strings.TrimSpace(rule.ID) == "" {
		rule.ID = model.NewID()
	}
	rule.Name = strings.TrimSpace(rule.Name)
	rule.SrcAddr = strings.TrimSpace(rule.SrcAddr)
	rule.DstAddr = strings.TrimSpace(rule.DstAddr)
	rule.Protocol = strings.ToLower(strings.TrimSpace(rule.Protocol))
	if rule.Protocol == "" {
		rule.Protocol = protoTCP
	}
	if rule.Access.Mode == "" {
		rule.Access.Mode = model.AccessOff
	}
	for i := range rule.Access.IPs {
		rule.Access.IPs[i] = strings.TrimSpace(rule.Access.IPs[i])
	}
}

// validateRule rejects the rules the forwarder could never serve.
func validateRule(rule model.ForwardRule) error {
	switch rule.Protocol {
	case protoTCP, protoUDP, protoBoth:
	default:
		return errors.New("protocol must be tcp, udp or both")
	}
	if _, err := netutil.NormalizeListen(rule.SrcAddr); err != nil {
		return err
	}
	if _, err := netutil.NormalizeListen(rule.DstAddr); err != nil {
		return err
	}
	if rule.MaxConns < 0 {
		return errors.New("maxConns must not be negative")
	}
	if rule.MaxConnsPerIP < 0 {
		return errors.New("maxConnsPerIP must not be negative")
	}
	if rule.Access.Mode != "" && rule.Access.Mode != model.AccessOff {
		if rule.Access.Mode != model.AccessAllow && rule.Access.Mode != model.AccessDeny {
			return errors.New("access mode must be off, allow or deny")
		}
		if _, err := netutil.ParseIPList(rule.Access.IPs); err != nil {
			return err
		}
	}
	return nil
}
