package waf

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/notify"
)

// This file implements the "non full share" alert of the request body policy.
//
// The share of requests that were not inspected completely (peek, skip, the
// gRPC shapes, malformed frames) is the number an operator reads to decide
// whether the declared body policies still describe the traffic. The WAF page
// shows it as a card; this alert pushes it out of the process, so a rollout
// where a route has to declare its policy is noticed without somebody staring
// at the UI.
//
// Contract: the alert is raised only when the share is *above* the configured
// threshold and at least defaultBodyAlertMinSamples requests were sampled, and
// at most once per bodyAlertInterval in one process. A configuration that
// leaves notifyBodyRatio at zero never alerts.

const (
	// bodyAlertInterval is the shortest gap between two alerts of one process.
	bodyAlertInterval = time.Hour
	// defaultBodyAlertMinSamples is the number of sampled requests below which
	// the alert stays quiet: a share computed from a handful of requests is
	// noise, not a rollout signal.
	defaultBodyAlertMinSamples = 50
	// bodyAlertHint is part of the alert text: it tells the operator what to do
	// about the number instead of only reporting it.
	bodyAlertHint = "请到 WAF 页查看未声明策略的路由并逐条声明 bodyPolicy"
)

// bodyAlertNotify delivers one alert. It is a package variable so a test can
// capture the alert without a webhook endpoint; production assigns the notify
// service of the module dependencies through newBodyAlert.
var bodyAlertNotify = func(deps *module.Deps, title, message string, fields map[string]any) {
	if deps == nil || deps.Notify == nil {
		return
	}
	deps.Notify.Emit(notify.EventAlert, title, message, fields)
}

// nowFunc is the clock of the alert throttle. It is a variable so the one hour
// suppression window can be tested without sleeping for an hour.
var nowFunc = time.Now

// bodyAlert raises the "non full share above the threshold" notification at
// most once per bodyAlertInterval.
type bodyAlert struct {
	// mu guards last: requests are inspected concurrently.
	mu   sync.Mutex
	last time.Time
	// minCount is the sample size below which the alert stays quiet.
	minCount int64
}

func newBodyAlert() *bodyAlert {
	return &bodyAlert{minCount: defaultBodyAlertMinSamples}
}

// evaluate decides whether the current counters are worth an alert and records
// the delivery. threshold is the configured notifyBodyRatio: zero (or less)
// disables the alert. It reports whether an alert was raised, which is what the
// tests assert on.
func (a *bodyAlert) evaluate(entry bodyRequestCounts, threshold float64, now time.Time, emit func(entry bodyRequestCounts, threshold float64)) bool {
	// Zero (or less) is the off switch, and one can never be exceeded by a
	// share. Both are rejected here rather than by the caller, so the policy
	// holds for every call site.
	if threshold <= 0 || threshold >= 1 {
		return false
	}
	if entry.total < a.minCount || entry.ratio() <= threshold {
		return false
	}
	a.mu.Lock()
	if !a.last.IsZero() && now.Sub(a.last) < bodyAlertInterval {
		a.mu.Unlock()
		return false
	}
	a.last = now
	a.mu.Unlock()
	if emit != nil {
		emit(entry, threshold)
	}
	return true
}

// bodyRequestCounts is the snapshot the alert is computed from: how many
// requests were sampled and how many of them were not inspected completely.
type bodyRequestCounts struct {
	total int64
	other int64
}

// ratio is the share of the sampled requests that were not inspected fully.
func (c bodyRequestCounts) ratio() float64 {
	if c.total == 0 {
		return 0
	}
	return float64(c.other) / float64(c.total)
}

// bodyCounts folds the bodyState distribution into the two numbers the alert
// needs. Every state other than full counts as a hole in the coverage.
func bodyCounts(states map[string]int64) bodyRequestCounts {
	var c bodyRequestCounts
	for state, n := range states {
		c.total += n
		if state != string(stateFull) {
			c.other += n
		}
	}
	return c
}

// notifyBodyRatio returns the configured alert threshold. It is read from the
// live configuration snapshot rather than from the cached module state because
// the field is not part of the rule engine: changing it alone does not require
// a rebuild, so it must never lag behind a save.
func (w *WAF) notifyBodyRatio() float64 {
	if w == nil || w.deps == nil || w.deps.Cfg == nil {
		return 0
	}
	return w.deps.Cfg.Snapshot().WAF.NotifyBodyRatio
}

// bodyAlertCheck evaluates the alert once per inspected request. It is called
// after the request recorded its bodyState, so the counters already include it;
// the alert itself is throttled, so the per request call is cheap.
func (w *WAF) bodyAlertCheck() {
	threshold := w.notifyBodyRatio()
	if threshold <= 0 || w.alert == nil || w.body == nil {
		return
	}
	entry := bodyCounts(w.body.counts())
	w.alert.evaluate(entry, threshold, nowFunc(), func(entry bodyRequestCounts, threshold float64) {
		bodyAlertNotify(w.deps, bodyAlertTitle, formatBodyAlert(entry, threshold), map[string]any{
			"bodyRequests":      entry.total,
			"bodyNonFull":       entry.other,
			"bodyNonFullRatio":  entry.ratio(),
			"notifyBodyRatio":   threshold,
			"minSamples":        w.alert.minCount,
			"alertIntervalSecs": int(bodyAlertInterval / time.Second),
		})
	})
}

// bodyAlertTitle is the notification title of the alert.
const bodyAlertTitle = "WAF 非 full 请求体检查占比超阈值"

// formatBodyAlert renders the alert text: the measured share, the configured
// threshold, the sample size it was computed from, and what to do about it.
func formatBodyAlert(entry bodyRequestCounts, threshold float64) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "非 full 请求体检查占比 %.1f%%（阈值 %.1f%%），样本 %d 条：其中 %d 条只做了部分检查（peek / skip / gRPC 首消息 / 帧校验的请求体策略），%d 条为全量检查。",
		entry.ratio()*100, threshold*100, entry.total, entry.other, entry.total-entry.other)
	sb.WriteString(bodyAlertHint)
	sb.WriteString(fmt.Sprintf("；同一告警每小时最多发送一次，样本少于 %d 条时不发送。", defaultBodyAlertMinSamples))
	return sb.String()
}
