package ddns

import (
	"net/http"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/dnsprov"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/rest"
	"github.com/nunt/nunt/internal/secret"
)

const httpcTimeout = 15 * time.Second

func (d *DDNS) handleListRules(w http.ResponseWriter, r *http.Request) {
	rules := d.deps.Cfg.Snapshot().DDNS.Rules
	out := make([]model.DDNSRule, 0, len(rules))
	for _, rule := range rules {
		rule = maskRule(rule)
		out = append(out, rule)
	}
	rest.OK(w, out)
}

func (d *DDNS) handleCreateRule(w http.ResponseWriter, r *http.Request) {
	var req model.DDNSRule
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	req.ID = model.NewID()
	req.CreatedAt = time.Now()
	req.UpdatedAt = req.CreatedAt
	if err := d.sealRule(&req, nil); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "cannot protect the credentials: %s", err)
		return
	}
	if err := d.deps.Cfg.Update(func(c *model.Config) error {
		c.DDNS.Rules = append(c.DDNS.Rules, req)
		return nil
	}); err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot save the rule: %s", err)
		return
	}
	d.Reload(d.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"id": req.ID})
}

func (d *DDNS) handleUpdateRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req model.DDNSRule
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	var previous *model.DDNSRule
	for _, rule := range d.deps.Cfg.Snapshot().DDNS.Rules {
		if rule.ID == id {
			prev := rule
			previous = &prev
			break
		}
	}
	if previous == nil {
		rest.Fail(w, http.StatusNotFound, "rule not found")
		return
	}
	if err := d.sealRule(&req, previous); err != nil {
		rest.Fail(w, http.StatusInternalServerError, "cannot protect the credentials: %s", err)
		return
	}
	err := d.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.DDNS.Rules {
			if c.DDNS.Rules[i].ID != id {
				continue
			}
			req.ID = id
			req.CreatedAt = c.DDNS.Rules[i].CreatedAt
			req.UpdatedAt = time.Now()
			c.DDNS.Rules[i] = req
			return nil
		}
		return errNotFound
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "rule not found")
		return
	}
	d.Reload(d.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"id": id})
}

func (d *DDNS) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := d.deps.Cfg.Update(func(c *model.Config) error {
		out := c.DDNS.Rules[:0]
		removed := false
		for _, rule := range c.DDNS.Rules {
			if rule.ID == id {
				removed = true
				continue
			}
			out = append(out, rule)
		}
		c.DDNS.Rules = out
		if !removed {
			return errNotFound
		}
		return nil
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "rule not found")
		return
	}
	d.mu.Lock()
	delete(d.states, id)
	delete(d.locks, id)
	d.mu.Unlock()
	d.Reload(d.deps.Cfg.Snapshot())
	rest.NoContent(w)
}

type toggleRequest struct {
	Enable *bool `json:"enable"`
}

func (d *DDNS) handleToggleRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req toggleRequest
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	err := d.deps.Cfg.Update(func(c *model.Config) error {
		for i := range c.DDNS.Rules {
			if c.DDNS.Rules[i].ID != id {
				continue
			}
			if req.Enable != nil {
				c.DDNS.Rules[i].Enable = *req.Enable
			} else {
				c.DDNS.Rules[i].Enable = !c.DDNS.Rules[i].Enable
			}
			return nil
		}
		return errNotFound
	})
	if err != nil {
		rest.Fail(w, http.StatusNotFound, "rule not found")
		return
	}
	cfg := d.deps.Cfg.Snapshot()
	d.Reload(cfg)
	for _, rule := range cfg.DDNS.Rules {
		if rule.ID == id {
			rest.OK(w, map[string]any{"id": id, "enable": rule.Enable})
			return
		}
	}
	rest.OK(w, map[string]any{"id": id})
}

func (d *DDNS) handleRunRule(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	found := false
	for _, rule := range d.deps.Cfg.Snapshot().DDNS.Rules {
		if rule.ID == id {
			found = true
			break
		}
	}
	if !found {
		rest.Fail(w, http.StatusNotFound, "rule not found")
		return
	}
	d.runRule(r.Context(), id)
	var view *statusView
	for _, s := range d.statuses() {
		if s.ID == id {
			v := s
			view = &v
			break
		}
	}
	if view == nil {
		rest.OK(w, map[string]any{"id": id})
		return
	}
	message := "up to date"
	if view.LastError != "" {
		message = view.LastError
	} else if len(view.Records) > 0 {
		message = view.Records[len(view.Records)-1].Message
	}
	rest.OK(w, map[string]any{
		"id":      id,
		"ipv4":    view.IPv4,
		"ipv6":    view.IPv6,
		"ok":      view.LastError == "",
		"message": message,
	})
}

func (d *DDNS) handleProviders(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, dnsprov.Default().List())
}

type providerTestRequest struct {
	Provider string            `json:"provider"`
	Creds    map[string]string `json:"creds"`
	Domain   string            `json:"domain"`
	Sub      string            `json:"sub"`
	Type     string            `json:"type"`
}

func (d *DDNS) handleProviderTest(w http.ResponseWriter, r *http.Request) {
	var req providerTestRequest
	if err := rest.Decode(w, r, &req); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	if strings.TrimSpace(req.Domain) == "" {
		rest.Fail(w, http.StatusBadRequest, "a domain is required for the test")
		return
	}
	creds, err := d.deps.Box.OpenMap(req.Creds)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "cannot read the credentials: %s", err)
		return
	}
	if err := dnsprov.Default().Validate(req.Provider, creds); err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	provider, err := dnsprov.Default().New(req.Provider, creds)
	if err != nil {
		rest.Fail(w, http.StatusBadRequest, "%s", err.Error())
		return
	}
	// This endpoint must not touch the live zone: the previous implementation
	// wrote 192.0.2.1 over the existing record and deleted it afterwards, which
	// left the name without an address until the scheduler noticed (up to 24h).
	// Validating the credentials and constructing the provider is read-only.
	rest.OK(w, map[string]any{
		"status":   "ok",
		"provider": provider.Name(),
		"record":   "",
		"mode":     "validate-only",
	})
}

func (d *DDNS) handleStatus(w http.ResponseWriter, r *http.Request) {
	rest.OK(w, map[string]any{"rules": d.statuses()})
}

func (d *DDNS) handleReload(w http.ResponseWriter, r *http.Request) {
	d.Reload(d.deps.Cfg.Snapshot())
	rest.OK(w, map[string]any{"status": "reloaded"})
}

// maskRule hides credentials before they leave the process.
func maskRule(rule model.DDNSRule) model.DDNSRule {
	if len(rule.Creds) > 0 {
		masked := make(map[string]string, len(rule.Creds))
		for k, v := range rule.Creds {
			masked[k] = secret.Mask(v)
		}
		rule.Creds = masked
	}
	if rule.Callback != nil && rule.Callback.BasicPass != "" {
		cb := *rule.Callback
		cb.BasicPass = secret.Mask(cb.BasicPass)
		rule.Callback = &cb
	}
	return rule
}

// sealRule encrypts credentials, keeping the stored values for masked fields.
func (d *DDNS) sealRule(rule *model.DDNSRule, previous *model.DDNSRule) error {
	creds := map[string]string{}
	for k, v := range rule.Creds {
		if isMasked(v) {
			if previous != nil {
				if old, ok := previous.Creds[k]; ok {
					creds[k] = old
					continue
				}
			}
			continue
		}
		sealed, err := d.deps.Box.Seal(v)
		if err != nil {
			return err
		}
		creds[k] = sealed
	}
	rule.Creds = creds
	if rule.Callback != nil {
		cb := *rule.Callback
		if isMasked(cb.BasicPass) {
			cb.BasicPass = ""
			if previous != nil && previous.Callback != nil {
				cb.BasicPass = previous.Callback.BasicPass
			}
		} else if cb.BasicPass != "" {
			sealed, err := d.deps.Box.Seal(cb.BasicPass)
			if err != nil {
				return err
			}
			cb.BasicPass = sealed
		}
		rule.Callback = &cb
	}
	return nil
}

func isMasked(v string) bool {
	return v == "" || strings.Contains(v, "********")
}

var errNotFound = errNotFoundError{}

type errNotFoundError struct{}

func (errNotFoundError) Error() string { return "not found" }
