package web

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/security"
)

// ruleView is a rule as returned by the API.
type ruleView struct {
	model.WebRule
	// Runtime tells the user interface whether the rule is currently served.
	Active      bool     `json:"active"`
	Upstreams   []string `json:"upstreams,omitempty"`
	Requests    int64    `json:"requests"`
	ConfigError string   `json:"configError,omitempty"`
}

// registerAPI mounts the endpoints of the web service.
func (w *Web) registerAPI(mux *rest.Mux) {
	g := mux.Group("/api/v1/web")
	g.Get("/rules", w.handleListRules)
	g.Post("/rules", w.handleCreateRule)
	g.Put("/rules/{id}", w.handleUpdateRule)
	g.Delete("/rules/{id}", w.handleDeleteRule)
	g.Post("/rules/{id}/toggle", w.handleToggleRule)
	g.Get("/logs", w.handleLogs)
	g.Post("/reload", w.handleReload)
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

func (w *Web) handleListRules(rw http.ResponseWriter, req *http.Request) {
	cfg := w.snapshot()
	rules := []ruleView{}
	if cfg != nil {
		rules = make([]ruleView, 0, len(cfg.Web.Rules))
		for _, raw := range cfg.Web.Rules {
			rules = append(rules, w.view(raw))
		}
	}
	rest.OK(rw, map[string]any{"items": rules})
}

// view decorates a stored rule with its runtime state.
func (w *Web) view(raw model.WebRule) ruleView {
	out := ruleView{WebRule: raw}
	w.mu.Lock()
	upstreams := []string{}
	for _, r := range w.rules {
		if r.id != raw.ID {
			continue
		}
		out.Active = true
		if r.site != nil {
			upstreams = append(upstreams, r.site.upstreams...)
		}
	}
	w.mu.Unlock()
	out.Upstreams = upstreams
	w.countersMu.Lock()
	out.Requests = w.counters[raw.ID]
	w.countersMu.Unlock()
	return out
}

func (w *Web) handleCreateRule(rw http.ResponseWriter, req *http.Request) {
	if !requireAdmin(rw, req) {
		return
	}
	var body model.WebRule
	if err := rest.Decode(rw, req, &body); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	body.ID = ""
	if err := prepareRule(&body, nil); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	now := time.Now()
	body.CreatedAt = now
	body.UpdatedAt = now
	if err := w.saveRule(func(c *model.Config) error {
		c.Web.Rules = append(c.Web.Rules, body)
		return nil
	}); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "cannot save rule: %s", err)
		return
	}
	rest.OK(rw, map[string]any{"id": body.ID})
}

func (w *Web) handleUpdateRule(rw http.ResponseWriter, req *http.Request) {
	if !requireAdmin(rw, req) {
		return
	}
	id := strings.TrimSpace(req.PathValue("id"))
	if id == "" {
		rest.Fail(rw, http.StatusBadRequest, "a rule id is required")
		return
	}
	var body model.WebRule
	if err := rest.Decode(rw, req, &body); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	var existing *model.WebRule
	if cfg := w.snapshot(); cfg != nil {
		for i := range cfg.Web.Rules {
			if cfg.Web.Rules[i].ID == id {
				copyRule := cfg.Web.Rules[i]
				existing = &copyRule
				break
			}
		}
	}
	if existing == nil {
		rest.Fail(rw, http.StatusNotFound, "rule not found")
		return
	}
	if err := prepareRule(&body, existing); err != nil {
		rest.Fail(rw, http.StatusBadRequest, "%s", err.Error())
		return
	}
	body.ID = id
	if body.CreatedAt.IsZero() {
		body.CreatedAt = existing.CreatedAt
	}
	body.UpdatedAt = time.Now()
	err := w.saveRule(func(c *model.Config) error {
		for i := range c.Web.Rules {
			if c.Web.Rules[i].ID == id {
				c.Web.Rules[i] = body
				return nil
			}
		}
		return errNotFound
	})
	if err != nil {
		rest.Fail(rw, http.StatusNotFound, "rule not found")
		return
	}
	rest.NoContent(rw)
}

func (w *Web) handleDeleteRule(rw http.ResponseWriter, req *http.Request) {
	if !requireAdmin(rw, req) {
		return
	}
	id := strings.TrimSpace(req.PathValue("id"))
	err := w.saveRule(func(c *model.Config) error {
		out := c.Web.Rules[:0]
		removed := false
		for _, rule := range c.Web.Rules {
			if rule.ID == id {
				removed = true
				continue
			}
			out = append(out, rule)
		}
		c.Web.Rules = out
		if !removed {
			return errNotFound
		}
		return nil
	})
	if err != nil {
		rest.Fail(rw, http.StatusNotFound, "rule not found")
		return
	}
	rest.NoContent(rw)
}

func (w *Web) handleToggleRule(rw http.ResponseWriter, req *http.Request) {
	if !requireAdmin(rw, req) {
		return
	}
	id := strings.TrimSpace(req.PathValue("id"))
	var enabled, found bool
	err := w.saveRule(func(c *model.Config) error {
		for i := range c.Web.Rules {
			if c.Web.Rules[i].ID != id {
				continue
			}
			found = true
			c.Web.Rules[i].Enable = !c.Web.Rules[i].Enable
			c.Web.Rules[i].UpdatedAt = time.Now()
			enabled = c.Web.Rules[i].Enable
			return nil
		}
		return errNotFound
	})
	if err != nil {
		// A rule that exists but fails validation (an unguarded file service
		// being enabled, for example) is a refused change, not a missing rule.
		if found {
			rest.Fail(rw, http.StatusBadRequest, "无法应用该规则：%s", err)
			return
		}
		rest.Fail(rw, http.StatusNotFound, "rule not found")
		return
	}
	rest.OK(rw, map[string]any{"id": id, "enable": enabled})
}

// saveRule persists a change and applies it to the running listeners.
func (w *Web) saveRule(mutate func(*model.Config) error) error {
	if err := w.deps.Cfg.Update(mutate); err != nil {
		return err
	}
	w.Reload(w.deps.Cfg.Snapshot())
	return nil
}

// prepareRule normalises and validates a rule received from the API. The
// previous version, when present, keeps the stored basic auth hashes.
func prepareRule(r *model.WebRule, previous *model.WebRule) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Path = model.NormalizePath(r.Path)
	if r.ID == "" {
		r.ID = model.NewID()
	}
	if r.Type == "" {
		r.Type = model.WebTypeProxy
	}
	r.TLS.Mode = normalizeTLSMode(r.TLS.Mode)
	if r.Access.Mode == "" {
		r.Access.Mode = model.AccessOff
	}
	if r.Access.UAMode == "" {
		r.Access.UAMode = model.AccessOff
	}
	for i := range r.Listen {
		r.Listen[i] = strings.TrimSpace(r.Listen[i])
	}
	if r.Proxy != nil {
		for i := range r.Proxy.Targets {
			r.Proxy.Targets[i] = strings.TrimSpace(r.Proxy.Targets[i])
		}
	}
	if r.Redirect != nil {
		r.Redirect.To = strings.TrimSpace(r.Redirect.To)
		if r.Redirect.Status == 0 {
			r.Redirect.Status = http.StatusFound
		}
	}
	if r.BasicAuth != nil {
		if err := hashAuthUsers(r.BasicAuth, previous); err != nil {
			return err
		}
	}
	if _, err := compileRule(*r, 0); err != nil {
		return fmt.Errorf("rule %q: %w", displayRuleName(*r), err)
	}
	return nil
}

// hashAuthUsers stores argon2id hashes for the basic auth users of a rule.
// Values that already are hashes are kept as they are, which lets an
// administrator paste a hash generated elsewhere.
func hashAuthUsers(auth *model.BasicAuth, previous *model.WebRule) error {
	var old map[string]string
	if previous != nil && previous.BasicAuth != nil {
		old = map[string]string{}
		for _, u := range previous.BasicAuth.Users {
			old[u.Username] = u.Password
		}
	}
	for i := range auth.Users {
		user := &auth.Users[i]
		user.Username = strings.TrimSpace(user.Username)
		if user.Username == "" {
			return fmt.Errorf("basic auth user %d has no name", i+1)
		}
		switch {
		case strings.HasPrefix(user.Password, "$argon2id$"):
			// already a hash
		case user.Password == "" || isMaskedSecret(user.Password):
			hash, ok := old[user.Username]
			if !ok {
				return fmt.Errorf("basic auth user %q has no password", user.Username)
			}
			user.Password = hash
		default:
			hash, err := security.HashPassword(user.Password)
			if err != nil {
				return fmt.Errorf("hash the password of %q: %w", user.Username, err)
			}
			user.Password = hash
		}
	}
	return nil
}

func isMaskedSecret(s string) bool {
	return strings.Contains(s, "********")
}

// ---------------------------------------------------------------------------
// logs & reload
// ---------------------------------------------------------------------------

func (w *Web) handleLogs(rw http.ResponseWriter, req *http.Request) {
	ruleID := strings.TrimSpace(req.URL.Query().Get("rule"))
	limit := defaultLogKeep
	if raw := strings.TrimSpace(req.URL.Query().Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			rest.Fail(rw, http.StatusBadRequest, "limit must be a positive number")
			return
		}
		if n > maxLogLimit {
			n = maxLogLimit
		}
		limit = n
	}
	entries := w.Logs(ruleID, limit)
	if entries == nil {
		entries = []AccessEntry{}
	}
	rest.OK(rw, map[string]any{"items": entries})
}

func (w *Web) handleReload(rw http.ResponseWriter, req *http.Request) {
	if !requireAdmin(rw, req) {
		return
	}
	w.Reload(w.deps.Cfg.Snapshot())
	rest.OK(rw, map[string]any{"listeners": w.Listeners(), "rules": len(w.rulesSnapshot())})
}

func (w *Web) rulesSnapshot() []*rule {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]*rule{}, w.rules...)
}
