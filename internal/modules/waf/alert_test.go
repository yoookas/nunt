package waf

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/notify"
)

// The tests in this file cover the "non full share" alert: the threshold gate,
// the sample size gate, the one hour suppression window, the ratio=0 off
// switch, the configuration boundary and the wiring that turns recorded
// bodyStates into a notification. Time is injected through nowFunc and
// delivery through bodyAlertNotify, so no test sleeps for the throttle.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// alertHarness captures the alerts raised while a test is running and controls
// the clock the throttle reads.
type alertHarness struct {
	mu     sync.Mutex
	now    time.Time
	alerts []alertRecord
}

// alertRecord is one captured alert.
type alertRecord struct {
	event   string
	title   string
	message string
	fields  map[string]any
}

// install replaces the clock and the notifier of the alert for one test.
func (h *alertHarness) install(t *testing.T) {
	t.Helper()
	h.now = time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	prevNow, prevNotify := nowFunc, bodyAlertNotify
	nowFunc = func() time.Time {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.now
	}
	bodyAlertNotify = func(_ *module.Deps, title, message string, fields map[string]any) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.alerts = append(h.alerts, alertRecord{event: notify.EventAlert, title: title, message: message, fields: fields})
	}
	t.Cleanup(func() {
		nowFunc, bodyAlertNotify = prevNow, prevNotify
	})
}

// advance moves the injected clock forward.
func (h *alertHarness) advance(d time.Duration) {
	h.mu.Lock()
	h.now = h.now.Add(d)
	h.mu.Unlock()
}

// count reports how many alerts were raised.
func (h *alertHarness) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.alerts)
}

// last returns the most recent alert.
func (h *alertHarness) last(t *testing.T) alertRecord {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.alerts) == 0 {
		t.Fatal("no alert was raised")
	}
	return h.alerts[len(h.alerts)-1]
}

// alertDeps builds module dependencies with a working notification service, so
// the whole chain up to notify.Service.Emit is exercised by the tests.
func alertDeps(t *testing.T, cfg model.WAFConfig) *module.Deps {
	t.Helper()
	dir := t.TempDir()
	store, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("config load: %v", err)
	}
	if err := store.Update(func(c *model.Config) error {
		c.WAF = cfg
		return nil
	}); err != nil {
		t.Fatalf("config update: %v", err)
	}
	hub := logging.New("error", "")
	t.Cleanup(hub.Close)
	return &module.Deps{
		Cfg:     store,
		Log:     hub,
		Notify:  notify.New(store, hub.Logger()),
		DataDir: dir,
	}
}

// alertModule builds a started module for one rule with the given body policy.
func alertModule(t *testing.T, deps *module.Deps, policy string) (*WAF, string) {
	t.Helper()
	name := "alert-route"
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Web.Rules = []model.WebRule{{
			ID: "rule-1", Name: name, Enable: true, Type: model.WebTypeProxy,
			Listen: []string{":0"}, BodyPolicy: policy,
			Proxy: &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9"}},
		}}
		return nil
	}); err != nil {
		t.Fatalf("configure the web rule: %v", err)
	}
	m := New(deps)
	if err := m.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = m.Stop(context.Background()) })
	return m, name
}

// raise lowers the sample floor of the alert so a test can reach it with a
// handful of requests instead of defaultBodyAlertMinSamples engine runs, and
// wires delivery through the notify service of the module. It is the same code
// path production uses, only the floor differs.
func raise(t *testing.T, m *WAF, minSamples int64) {
	t.Helper()
	m.alert.minCount = minSamples
	prev := bodyAlertNotify
	bodyAlertNotify = func(deps *module.Deps, title, message string, fields map[string]any) {
		if deps == nil || deps.Notify == nil {
			return
		}
		deps.Notify.Emit(notify.EventAlert, title, message, fields)
	}
	t.Cleanup(func() { bodyAlertNotify = prev })
}

// drive sends n requests through the middleware of one rule.
func drive(t *testing.T, m *WAF, rule string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		rec := do(m, rule, okHandler("ok"), newRequest(t, http.MethodPost, "http://alert.example.com/", "a=1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d answered %d, want 200", i, rec.Code)
		}
	}
}

// webhookServer returns a test endpoint that reports every notification it
// receives, and installs the webhook in the configuration.
func webhookServer(t *testing.T, deps *module.Deps) <-chan map[string]any {
	t.Helper()
	delivered := make(chan map[string]any, 8)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		select {
		case delivered <- payload:
		default:
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(hook.Close)
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Notify.Webhooks = []model.Webhook{{
			ID: "hook-1", Name: "test", Enable: true, URL: hook.URL,
		}}
		return nil
	}); err != nil {
		t.Fatalf("configure the webhook: %v", err)
	}
	return delivered
}

// ---------------------------------------------------------------------------
// threshold and sample gates
// ---------------------------------------------------------------------------

// TestBodyAlertSkippedBelowSampleFloor proves the sample size gate: a share
// above the threshold stays silent while too few requests were sampled, and is
// reported as soon as the floor is reached.
func TestBodyAlertSkippedBelowSampleFloor(t *testing.T) {
	h := &alertHarness{}
	h.install(t)
	a := newBodyAlert()
	fired := false
	emit := func(bodyRequestCounts, float64) { fired = true }

	// One sample below the floor, with the worst possible share.
	if a.evaluate(bodyRequestCounts{total: defaultBodyAlertMinSamples - 1, other: defaultBodyAlertMinSamples - 1}, 0.2, h.now, emit) {
		t.Fatal("an alert was raised below the sample floor")
	}
	if fired {
		t.Fatal("the alert was delivered below the sample floor")
	}
	// Reaching the floor is enough; the gate is the sample count.
	if !a.evaluate(bodyRequestCounts{total: defaultBodyAlertMinSamples, other: defaultBodyAlertMinSamples}, 0.2, h.now, emit) {
		t.Fatal("no alert was raised at the sample floor")
	}
	if !fired {
		t.Fatal("the alert was not delivered at the sample floor")
	}
}

// TestBodyAlertSkippedBelowThreshold proves the share gate: a share at or
// below the threshold stays silent, one above it is reported.
func TestBodyAlertSkippedBelowThreshold(t *testing.T) {
	h := &alertHarness{}
	h.install(t)
	a := newBodyAlert()

	for _, ratio := range []float64{0, 0.099, 0.1} {
		entry := bodyRequestCounts{total: 200, other: int64(ratio * 200)}
		if a.evaluate(entry, 0.1, h.now, nil) {
			t.Fatalf("an alert was raised for share %.3f with threshold 0.1", ratio)
		}
	}
	if !a.evaluate(bodyRequestCounts{total: 200, other: 21}, 0.1, h.now, nil) {
		t.Fatal("no alert was raised for a share above the threshold")
	}
}

// ---------------------------------------------------------------------------
// delivery, suppression and off switch
// ---------------------------------------------------------------------------

// TestBodyAlertEmitsOncePerHour proves the happy path and the throttle: the
// first evaluation above both gates delivers one alert, calls inside the hour
// stay silent without pushing the window back, and the alert is delivered
// again once the hour after the delivery elapsed.
func TestBodyAlertEmitsOncePerHour(t *testing.T) {
	h := &alertHarness{}
	h.install(t)
	a := newBodyAlert()
	entry := bodyRequestCounts{total: 50, other: 20} // 40% non full
	fire := func() bool {
		return a.evaluate(entry, 0.2, h.now, func(entry bodyRequestCounts, threshold float64) {
			bodyAlertNotify(nil, bodyAlertTitle, formatBodyAlert(entry, threshold), nil)
		})
	}

	if !fire() {
		t.Fatal("no alert was raised for a share above the threshold")
	}
	if h.count() != 1 {
		t.Fatalf("delivered %d alerts, want 1", h.count())
	}
	got := h.last(t)
	if got.event != notify.EventAlert {
		t.Fatalf("alert event = %q, want %q", got.event, notify.EventAlert)
	}
	for _, want := range []string{"40.0%", "20.0%", "样本 50", "未声明策略的路由"} {
		if !strings.Contains(got.message, want) {
			t.Fatalf("alert message %q does not mention %q", got.message, want)
		}
	}

	// The calls below stay strictly inside the hour, so none of them may fire.
	for _, d := range []time.Duration{0, time.Minute, 58 * time.Minute} {
		h.advance(d)
		if fire() {
			t.Fatalf("a second alert was raised %v after the first one", d)
		}
	}
	if h.count() != 1 {
		t.Fatalf("delivered %d alerts during the suppressed hour, want 1", h.count())
	}

	h.advance(time.Minute) // exactly one hour after the delivery
	if !fire() {
		t.Fatal("no alert was raised after the suppression window elapsed")
	}
	if h.count() != 2 {
		t.Fatalf("delivered %d alerts, want 2", h.count())
	}
}

// TestBodyAlertDisabledByZeroRatio proves the off switch: a threshold of zero
// (or of one, the hardest legal value) never alerts, whatever the share is.
func TestBodyAlertDisabledByZeroRatio(t *testing.T) {
	h := &alertHarness{}
	h.install(t)
	a := newBodyAlert()
	entry := bodyRequestCounts{total: 1000, other: 1000}
	for _, threshold := range []float64{0, -0.5, 1} {
		for i := 0; i < 3; i++ {
			h.advance(time.Hour)
			if a.evaluate(entry, threshold, h.now, nil) {
				t.Fatalf("an alert was raised with threshold %v (0 means off, 1 can never be exceeded)", threshold)
			}
		}
	}
}

// TestNormalizeDoesNotEnableBodyAlert proves the alert stays off unless an
// administrator turns it on: Normalize fills the other body settings in and
// leaves this one at its zero value.
func TestNormalizeDoesNotEnableBodyAlert(t *testing.T) {
	cfg := model.Config{}
	config.Normalize(&cfg)
	if cfg.WAF.NotifyBodyRatio != 0 {
		t.Fatalf("Normalize set notifyBodyRatio to %v, want 0", cfg.WAF.NotifyBodyRatio)
	}
}

// TestValidateRejectsOutOfRangeBodyRatio proves the configuration boundary:
// only 0..1 is accepted, everything else fails to save instead of silently
// disabling or constantly firing the alert.
func TestValidateRejectsOutOfRangeBodyRatio(t *testing.T) {
	for _, tc := range []struct {
		ratio float64
		ok    bool
	}{
		{ratio: 0, ok: true},
		{ratio: 0.25, ok: true},
		{ratio: 1, ok: true},
		{ratio: -0.01, ok: false},
		{ratio: 1.01, ok: false},
		{ratio: 42, ok: false},
	} {
		dir := t.TempDir()
		store, _, err := config.Load(filepath.Join(dir, "config.json"))
		if err != nil {
			t.Fatalf("config load: %v", err)
		}
		err = store.Update(func(c *model.Config) error {
			c.WAF.NotifyBodyRatio = tc.ratio
			return nil
		})
		if tc.ok {
			if err != nil {
				t.Fatalf("notifyBodyRatio %v was rejected: %v", tc.ratio, err)
			}
			if got := store.Snapshot().WAF.NotifyBodyRatio; got != tc.ratio {
				t.Fatalf("stored notifyBodyRatio = %v, want %v", got, tc.ratio)
			}
			continue
		}
		if err == nil {
			t.Fatalf("notifyBodyRatio %v was accepted, want a validation error", tc.ratio)
		}
	}
}

// ---------------------------------------------------------------------------
// wiring: recorded bodyStates turn into a notification
// ---------------------------------------------------------------------------

// TestBodyAlertFiresOnRealRequests drives requests through the middleware of a
// route declared skip, so every one of them records a non full state, and
// proves the request path itself raises the alert through the notify service.
func TestBodyAlertFiresOnRealRequests(t *testing.T) {
	cfg := bodyConfig(model.WAFEnforceObserve)
	cfg.NotifyBodyRatio = 0.2
	deps := alertDeps(t, cfg)
	delivered := webhookServer(t, deps)
	m, rule := alertModule(t, deps, model.WAFBodySkip)
	const sampleFloor = 5
	raise(t, m, sampleFloor)

	// Below the floor: no alert, even though every sample is non full.
	drive(t, m, rule, sampleFloor-1)
	if entry := bodyCounts(m.body.counts()); entry.total != sampleFloor-1 {
		t.Fatalf("recorded %d samples, want %d", entry.total, sampleFloor-1)
	}
	select {
	case payload := <-delivered:
		t.Fatalf("an alert was delivered below the sample floor: %v", payload)
	case <-time.After(150 * time.Millisecond):
	}

	// Reaching the floor fires exactly one alert.
	drive(t, m, rule, 1)
	payload := receive(t, delivered)
	if payload["event"] != notify.EventAlert {
		t.Fatalf("webhook event = %v, want %s", payload["event"], notify.EventAlert)
	}
	if payload["title"] != bodyAlertTitle {
		t.Fatalf("webhook title = %v, want %s", payload["title"], bodyAlertTitle)
	}
	message, _ := payload["message"].(string)
	for _, want := range []string{"100.0%", "20.0%", "样本 5", "未声明策略的路由"} {
		if !strings.Contains(message, want) {
			t.Fatalf("webhook message %q does not mention %q", message, want)
		}
	}
	fields, ok := payload["fields"].(map[string]any)
	if !ok {
		t.Fatalf("webhook fields = %v, want an object", payload["fields"])
	}
	for key, want := range map[string]float64{
		"bodyRequests":     sampleFloor,
		"bodyNonFull":      sampleFloor,
		"bodyNonFullRatio": 1,
		"notifyBodyRatio":  0.2,
		"minSamples":       sampleFloor,
	} {
		if fields[key] != want {
			t.Fatalf("webhook field %s = %v, want %v", key, fields[key], want)
		}
	}

	// More traffic inside the same hour stays silent.
	drive(t, m, rule, 10)
	select {
	case payload := <-delivered:
		t.Fatalf("the alert was delivered twice inside the hour: %v", payload)
	case <-time.After(150 * time.Millisecond):
	}

	// The counters the UI reads are untouched by the alert.
	if stats := m.Stats(); stats["bodyNonFullRatio"] != float64(1) {
		t.Fatalf("bodyNonFullRatio = %v, want 1", stats["bodyNonFullRatio"])
	}
}

// TestBodyAlertStaysQuietWithoutThreshold proves the default configuration
// never alerts: the same traffic as the test above, with notifyBodyRatio left
// at zero, leaves the notification channel empty.
func TestBodyAlertStaysQuietWithoutThreshold(t *testing.T) {
	cfg := bodyConfig(model.WAFEnforceObserve) // NotifyBodyRatio keeps its default of 0
	deps := alertDeps(t, cfg)
	delivered := webhookServer(t, deps)
	m, rule := alertModule(t, deps, model.WAFBodySkip)
	raise(t, m, 1) // even a floor of one sample must not fire

	drive(t, m, rule, 10)
	if entry := bodyCounts(m.body.counts()); entry.other == 0 {
		t.Fatal("the route recorded no non full request, so the test proves nothing")
	}
	select {
	case payload := <-delivered:
		t.Fatalf("an alert was delivered with notifyBodyRatio=0: %v", payload)
	case <-time.After(200 * time.Millisecond):
	}
}

// receive waits for one notification.
func receive(t *testing.T, ch <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case payload := <-ch:
		return payload
	case <-time.After(5 * time.Second):
		t.Fatal("the webhook never received the alert")
		return nil
	}
}
