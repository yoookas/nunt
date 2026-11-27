package forward

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/ipfilter"
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
	g.Post("/rules/order", f.handleReorderRules)
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
	proxies := f.proxiesLocked()
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
	// A new rule is never created as auto-disabled.
	rule.Disabled = false
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
		c.Forward.Rules = append([]model.ForwardRule{rule}, c.Forward.Rules...)
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the rule: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	// Return the stored rule: Reload may have disabled it when the port is
	// already taken.
	for _, stored := range f.deps.Cfg.Snapshot().Forward.Rules {
		if stored.ID == rule.ID {
			rule = stored
			break
		}
	}
	rest.JSON(w, http.StatusCreated, rule)
}

// handleReorderRules stores the dragged order of the forward rules. Each rule
// owns its listen address, so the order is presentational.
func (f *Forward) handleReorderRules(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []string `json:"ids"`
	}
	if err := rest.Decode(w, r, &body); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	if err := f.deps.Cfg.Update(func(c *model.Config) error {
		have := make([]string, 0, len(c.Forward.Rules))
		byID := make(map[string]model.ForwardRule, len(c.Forward.Rules))
		for _, rule := range c.Forward.Rules {
			have = append(have, rule.ID)
			byID[rule.ID] = rule
		}
		if len(body.IDs) != len(have) {
			return fmt.Errorf("the order must name every rule: got %d ids for %d rules", len(body.IDs), len(have))
		}
		seen := make(map[string]bool, len(have))
		ordered := make([]model.ForwardRule, 0, len(body.IDs))
		for _, id := range body.IDs {
			rule, ok := byID[id]
			if !ok {
				return fmt.Errorf("unknown rule id %q", id)
			}
			if seen[id] {
				return fmt.Errorf("duplicate rule id %q", id)
			}
			seen[id] = true
			ordered = append(ordered, rule)
		}
		c.Forward.Rules = ordered
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot reorder the rules: %s", err)
		return
	}
	f.Reload(f.deps.Cfg.Snapshot())
	rest.NoContent(w)
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
			// Saving the form re-attempts the bind: the rule starts enabled
			// only if its port is free, otherwise Reload disables it again.
			rule.Disabled = false
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
	found := false
	enabling := false
	err = f.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.Forward.Rules {
			if c.Forward.Rules[i].ID != id {
				continue
			}
			found = true
			// A rule is on only when it is enabled and not auto-disabled.
			on := c.Forward.Rules[i].Enable && !c.Forward.Rules[i].Disabled
			next := !on
			if ok {
				next = requested
			}
			enabling = next
			if next {
				c.Forward.Rules[i].Enable = true
				c.Forward.Rules[i].Disabled = false
			} else {
				c.Forward.Rules[i].Enable = false
				c.Forward.Rules[i].Disabled = false
			}
			c.Forward.Rules[i].UpdatedAt = time.Now()
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

	var current model.ForwardRule
	for _, r := range f.deps.Cfg.Snapshot().Forward.Rules {
		if r.ID == id {
			current = r
			break
		}
	}
	// Enabling only succeeds when the bind worked; Reload disables the rule
	// again when the port is still taken.
	if enabling && current.Disabled {
		rest.Fail(w, http.StatusConflict, "端口仍被占用，规则保持停用；请释放端口后再试")
		return
	}
	rest.OK(w, current)
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
	switch rule.Access.Mode {
	case "", model.AccessOff:
		return nil
	case model.AccessRules:
		if _, err := ipfilter.Compile(rule.Access, nil); err != nil {
			return err
		}
		return nil
	default:
		return errors.New("access mode must be off or rules")
	}
}
