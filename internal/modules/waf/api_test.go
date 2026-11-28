package waf

import (
	"context"
	"encoding/json"
	"github.com/nunt/nunt/internal/model"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestStartStopAreIdempotent(t *testing.T) {
	m := New(testDeps(t, baseConfig()))
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("first start: %v", err)
	}
	if err := m.Start(ctx); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if !m.Enabled() {
		t.Fatal("the engine must be enabled after start")
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("first stop: %v", err)
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("second stop: %v", err)
	}
	if m.Enabled() {
		t.Fatal("the engine must be disabled after stop")
	}
	if err := m.Start(ctx); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !m.Enabled() {
		t.Fatal("the engine must be enabled after a restart")
	}
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("final stop: %v", err)
	}
}

func TestReloadSwapsTheEngine(t *testing.T) {
	deps := testDeps(t, baseConfig())
	m := New(deps)
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = m.Stop(ctx) }()

	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.WAF.Mode = model.WAFModeDetect
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	m.Reload(deps.Cfg.Snapshot())

	deadline := time.Now().Add(15 * time.Second)
	for {
		mode, _ := m.Stats()["mode"].(string)
		if mode == model.WAFModeDetect {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the reload did not reach the engine")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !m.Enabled() {
		t.Fatal("the engine must stay enabled after a reload")
	}
	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("the reloaded detect mode must not block, got %d", rec.Code)
	}
}

func TestAPIGetAndPutConfig(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/config", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /config = %d (%s)", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["config"] == nil || got["engine"] == nil || got["stats"] == nil {
		t.Fatalf("unexpected payload: %v", got)
	}

	cfg := baseConfig()
	cfg.ParanoiaLevel = 2
	cfg.ExecutingLevel = 2
	rec = apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /config = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := m.Config().ParanoiaLevel; got != 2 {
		t.Fatalf("the configuration was not stored: PL=%d", got)
	}
	if !strings.Contains(m.Status().Detail, "PL2") {
		t.Fatalf("the engine was not rebuilt: %q", m.Status().Detail)
	}
}

func TestAPIPutConfigRejectsInjection(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	cfg := baseConfig()
	cfg.DisabledRules = []string{"1; SecRuleEngine Off"}
	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for the injected directive, got %d (%s)", rec.Code, rec.Body.String())
	}
	if m.Config().Mode != model.WAFModeBlock {
		t.Fatal("the stored configuration must not change")
	}
	// The engine must still protect traffic.
	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the engine must keep blocking, got %d", blocked.Code)
	}
}

func TestAPIRulesListsBundledFiles(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/rules", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /rules = %d (%s)", rec.Code, rec.Body.String())
	}
	var payload struct {
		Items []struct {
			File         string `json:"file"`
			Name         string `json:"name"`
			Title        string `json:"title"`
			Group        string `json:"group"`
			Enabled      bool   `json:"enabled"`
			Rules        int    `json:"rules"`
			DisableRange string `json:"disableRange"`
		} `json:"items"`
		CRSVersion string `json:"crsVersion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Items) < 20 {
		t.Fatalf("expected the bundled rule files, got %d entries", len(payload.Items))
	}
	if payload.CRSVersion == "" {
		t.Fatal("the CRS version must be reported")
	}
	var found bool
	for _, item := range payload.Items {
		if strings.Contains(item.File, "REQUEST-941") {
			found = true
			if item.Title == "" || item.Rules == 0 || item.DisableRange == "" {
				t.Fatalf("incomplete entry: %+v", item)
			}
			if !item.Enabled {
				t.Fatalf("the XSS file must be enabled: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("REQUEST-941 is missing from the rule list")
	}
}

func TestAPITestEndpoint(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET",
		"url":    "/?test=../../../../etc/passwd",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /test = %d (%s)", rec.Code, rec.Body.String())
	}
	var verdict struct {
		Blocked  bool `json:"blocked"`
		Enforced bool `json:"enforced"`
		Status   int  `json:"status"`
		RuleID   int  `json:"ruleId"`
		Matched  []struct {
			ID      int    `json:"id"`
			Message string `json:"message"`
		} `json:"matched"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &verdict); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if !verdict.Blocked || !verdict.Enforced {
		t.Fatalf("the attack must be reported as blocked: %s", rec.Body.String())
	}
	if verdict.Status != http.StatusForbidden || verdict.RuleID == 0 || len(verdict.Matched) == 0 {
		t.Fatalf("incomplete verdict: %s", rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET",
		"url":    "/index.html?page=2",
	})
	var clean map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &clean); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if clean["blocked"].(bool) {
		t.Fatalf("a clean request must not be blocked: %s", rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method": "GET\x0d\x0aX-Evil: 1",
		"url":    "/",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a malformed method, got %d (%s)", rec.Code, rec.Body.String())
	}

	rec = apiDo(t, mux, http.MethodPost, "/api/v1/waf/test", map[string]any{
		"method":   "POST",
		"url":      "/login",
		"headers":  map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
		"body":     "user=admin&pass=1%27%20OR%20%271%27%3D%271",
		"clientIp": "203.0.113.9",
	})
	if !strings.Contains(rec.Body.String(), `"blocked":true`) {
		t.Fatalf("the sql injection in the body must be blocked: %s", rec.Body.String())
	}
}

func TestAPILogs(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))

	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?limit=10", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /logs = %d (%s)", rec.Code, rec.Body.String())
	}
	var payload struct {
		Items   []Event `json:"items"`
		Count   int     `json:"count"`
		Total   int     `json:"total"`
		Matched int     `json:"matched"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Count == 0 || len(payload.Items) == 0 {
		t.Fatalf("expected an event: %s", rec.Body.String())
	}
	ev := payload.Items[0]
	if ev.Action != "deny" || ev.RuleID == 0 || ev.Rule != "site-a" || ev.Status != http.StatusForbidden {
		t.Fatalf("unexpected event: %+v", ev)
	}
	if ev.ClientIP == "" || ev.Method != http.MethodGet || ev.URI == "" {
		t.Fatalf("the event lacks request context: %+v", ev)
	}
	// One request can buffer several rule hits; without a filter everything is
	// matched. The page prints matched, not the unfiltered total.
	if payload.Matched != payload.Total || payload.Total == 0 {
		t.Fatalf("unfiltered counts = matched %d total %d", payload.Matched, payload.Total)
	}
	all := payload.Total
	var denied struct {
		Matched int `json:"matched"`
		Count   int `json:"count"`
	}
	rec = apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?action=deny", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &denied); err != nil {
		t.Fatalf("decode deny: %v", err)
	}
	if denied.Matched != all {
		t.Fatalf("deny filter matched %d, want all %d", denied.Matched, all)
	}
	rec = apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?action=detect", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &denied); err != nil {
		t.Fatalf("decode detect: %v", err)
	}
	if denied.Matched != 0 || denied.Count != 0 {
		t.Fatalf("detect filter = matched %d count %d, want an empty list", denied.Matched, denied.Count)
	}

	if rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/logs?limit=abc", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a bad limit, got %d", rec.Code)
	}
	if rec := apiDo(t, mux, http.MethodDelete, "/api/v1/waf/logs", nil); rec.Code != http.StatusOK {
		t.Fatalf("DELETE /logs = %d", rec.Code)
	}
	if got := m.rec.size(); got != 0 {
		t.Fatalf("the buffer was not cleared: %d", got)
	}
}

func TestAPIRequiresRulesPayloadShape(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", map[string]any{"unknownField": true})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unknown field, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := apiDo(t, mux, http.MethodPost, "/api/v1/waf/reload", nil); rec.Code != http.StatusOK {
		t.Fatalf("POST /reload = %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestAPIPutConfigRollsBackOnBrokenRules(t *testing.T) {
	m := newTestModule(t, baseConfig())
	mux := newMux(t, m)

	cfg := baseConfig()
	cfg.ExtraRules = "SecRule THIS IS NOT SECLANG"
	rec := apiDo(t, mux, http.MethodPut, "/api/v1/waf/config", cfg)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an uncompilable rule set, got %d (%s)", rec.Code, rec.Body.String())
	}
	if m.Config().ExtraRules != "" {
		t.Fatalf("the previous configuration must be restored, got %q", m.Config().ExtraRules)
	}
	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the previous engine must keep protecting traffic, got %d", blocked.Code)
	}
}
