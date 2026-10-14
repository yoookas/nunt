package task

import (
	"errors"
	"fmt"
	"strings"

	"github.com/nunt/nunt/internal/model"

	"github.com/robfig/cron/v3"
)

// kindLabel normalises a rule.toggle target kind.
func kindLabel(kind string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "web", "forward", "ddns":
		return strings.ToLower(strings.TrimSpace(kind)), nil
	default:
		return "", fmt.Errorf("unknown rule kind %q: expected web, forward or ddns", kind)
	}
}

// currentRuleEnabled reports the enabled flag of one rule.
func (t *Task) currentRuleEnabled(kind, id string) (bool, error) {
	kind, err := kindLabel(kind)
	if err != nil {
		return false, err
	}
	if t.deps.Cfg == nil {
		return false, errors.New("the configuration store is unavailable")
	}
	cfg := t.deps.Cfg.Snapshot()
	switch kind {
	case "web":
		for _, r := range cfg.Web.Rules {
			if r.ID == id {
				return r.Enable, nil
			}
		}
	case "forward":
		for _, r := range cfg.Forward.Rules {
			if r.ID == id {
				return r.Enable, nil
			}
		}
	case "ddns":
		for _, r := range cfg.DDNS.Rules {
			if r.ID == id {
				return r.Enable, nil
			}
		}
	}
	return false, fmt.Errorf("rule %s:%s does not exist", kind, id)
}

// setRuleEnabled flips the enabled flag of one rule through the configuration
// store, which persists the change and notifies every module.
func (t *Task) setRuleEnabled(kind, id string, on bool) error {
	kind, err := kindLabel(kind)
	if err != nil {
		return err
	}
	if t.deps.Cfg == nil {
		return errors.New("the configuration store is unavailable")
	}
	found := false
	err = t.deps.Cfg.Update(func(c *model.Config) error {
		switch kind {
		case "web":
			for i := range c.Web.Rules {
				if c.Web.Rules[i].ID == id {
					c.Web.Rules[i].Enable = on
					found = true
					return nil
				}
			}
		case "forward":
			for i := range c.Forward.Rules {
				if c.Forward.Rules[i].ID == id {
					c.Forward.Rules[i].Enable = on
					found = true
					return nil
				}
			}
		case "ddns":
			for i := range c.DDNS.Rules {
				if c.DDNS.Rules[i].ID == id {
					c.DDNS.Rules[i].Enable = on
					found = true
					return nil
				}
			}
		}
		return fmt.Errorf("rule %s:%s does not exist", kind, id)
	})
	if err != nil {
		return fmt.Errorf("update rule %s:%s: %w", kind, id, err)
	}
	if !found {
		return fmt.Errorf("rule %s:%s does not exist", kind, id)
	}
	return nil
}

// validateTask rejects tasks the scheduler could never run.
func validateTask(item model.Task) error {
	if strings.TrimSpace(item.Cron) == "" {
		return errors.New("cron expression is required")
	}
	if _, err := cron.ParseStandard(item.Cron); err != nil {
		return fmt.Errorf("invalid cron expression %q: %w", item.Cron, err)
	}
	if len(item.Actions) == 0 {
		return errors.New("at least one action is required")
	}
	for i, action := range item.Actions {
		switch action.Type {
		case model.ActionModuleToggle:
			if target, _ := resolveTarget(action); target == "" {
				return fmt.Errorf("action %d: module.toggle requires a target module", i+1)
			}
		case model.ActionRuleToggle:
			target, _ := resolveTarget(action)
			kind, id := splitTarget(target)
			if id == "" {
				return fmt.Errorf("action %d: rule.toggle target must look like web:<id>", i+1)
			}
			if _, err := kindLabel(kind); err != nil {
				return fmt.Errorf("action %d: %w", i+1, err)
			}
		case model.ActionHTTP:
			if strings.TrimSpace(action.URL) == "" {
				return fmt.Errorf("action %d: http.request requires a url", i+1)
			}
		case model.ActionShell:
			if strings.TrimSpace(action.Command) == "" {
				return fmt.Errorf("action %d: shell.exec requires a command", i+1)
			}
		case model.ActionNotify:
			// Nothing to validate: the message has a default.
		case "":
			return fmt.Errorf("action %d: action type is required", i+1)
		default:
			return fmt.Errorf("action %d: unsupported action type %q", i+1, action.Type)
		}
	}
	return nil
}

// withTaskDefaults normalises a submitted task.
func withTaskDefaults(item *model.Task) {
	if strings.TrimSpace(item.ID) == "" {
		item.ID = model.NewID()
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Cron = strings.TrimSpace(item.Cron)
	if item.Cron == "" {
		item.Cron = "0 3 * * *"
	}
	for i := range item.Actions {
		item.Actions[i].Type = strings.TrimSpace(item.Actions[i].Type)
	}
}
