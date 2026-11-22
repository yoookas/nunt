// Package task runs scheduled jobs that control the other modules.
//
// Tasks are plain cron expressions (or @descriptors such as "@every 30s") with
// a list of actions. The scheduler is driven by the configuration store: every
// task keeps a stable runtime state (last run, counters, recent output) that is
// exposed through the REST API for the UI.
package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/httpc"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/notify"
	"github.com/nunt/nunt/internal/rest"

	"github.com/robfig/cron/v3"
)

// Limits and timeouts of the scheduler.
const (
	defaultRunTimeout  = 30 * time.Second
	shellTimeout       = 60 * time.Second
	shellOutputLimit   = 64 << 10
	outputPreviewLimit = 2000
	httpPreviewLimit   = 600
	maxConcurrentRuns  = 4
	maxLogEntries      = 100
	manualRetention    = 5 * time.Minute
	shutdownGrace      = 5 * time.Second
)

// httpClient is shared by every http.request action so connections are reused.
var httpClient = httpc.New(defaultRunTimeout, false)

// Task is the scheduler module.
type Task struct {
	module.Base

	deps *module.Deps
	log  *slog.Logger

	mu      sync.Mutex
	cron    *cron.Cron
	entries map[string]cron.EntryID
	states  map[string]*taskState
	manual  map[string]time.Time
	cfg     *model.Config
	stopped bool
	running int
	sem     chan struct{}
	wg      sync.WaitGroup
}

// New creates the module.
func New(deps *module.Deps) *Task {
	t := &Task{
		deps:    deps,
		entries: map[string]cron.EntryID{},
		states:  map[string]*taskState{},
		manual:  map[string]time.Time{},
		sem:     make(chan struct{}, maxConcurrentRuns),
	}
	t.Init(deps, "task", "Scheduled tasks")
	t.log = deps.Logger("task")
	return t
}

// Start loads the cron entries of every enabled task.
func (t *Task) Start(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cfg := t.snapshot()
	if cfg == nil {
		return errors.New("no configuration available")
	}
	var bad []string
	for _, item := range cfg.Tasks.Items {
		if !item.Enable {
			continue
		}
		if _, err := cron.ParseStandard(item.Cron); err != nil {
			bad = append(bad, fmt.Sprintf("%s: %v", taskLabel(item), err))
		}
	}

	t.mu.Lock()
	t.stopped = false
	if t.cron == nil {
		t.cron = cron.New()
	}
	t.cron.Start()
	t.mu.Unlock()

	t.SetRunning(true)
	t.Reload(cfg)
	if len(bad) > 0 {
		err := fmt.Errorf("invalid cron expression: %s", strings.Join(bad, "; "))
		t.SetError(err)
		return err
	}
	t.SetError(nil)
	return nil
}

// Stop cancels every scheduled job and waits briefly for the running ones.
func (t *Task) Stop(ctx context.Context) error {
	t.mu.Lock()
	t.stopped = true
	c := t.cron
	t.cron = nil
	t.entries = map[string]cron.EntryID{}
	t.manual = map[string]time.Time{}
	states := make([]*taskState, 0, len(t.states))
	for _, st := range t.states {
		states = append(states, st)
	}
	t.mu.Unlock()

	if c != nil {
		c.Stop()
	}
	for _, st := range states {
		st.close()
	}

	done := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(done)
	}()
	timer := time.NewTimer(shutdownGrace)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		t.log.Warn("task: some runs are still active after the shutdown grace period")
	}

	t.SetRunning(false)
	t.SetDetail("stopped")
	return nil
}

// Reload applies a new configuration: entries are added, removed or replaced
// by task id, and unchanged tasks keep their schedule.
func (t *Task) Reload(cfg *model.Config) {
	if cfg == nil {
		cfg = t.snapshot()
	}
	if cfg == nil {
		return
	}

	t.mu.Lock()
	t.cfg = cfg
	if t.cron == nil {
		t.mu.Unlock()
		return
	}
	t.apply(cfg)
	detail := t.detailLocked()
	t.mu.Unlock()
	t.SetDetail(detail)
}

// RegisterAPI mounts the REST endpoints.
func (t *Task) RegisterAPI(mux *rest.Mux) {
	t.registerAPI(mux)
}

// Status extends the module status with the scheduler statistics.
func (t *Task) Status() module.Status {
	st := t.Base.Status()
	st.Stats = t.Stats()
	return st
}

// Stats summarises the scheduler.
func (t *Task) Stats() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()

	total, enabled := 0, 0
	if t.cfg != nil {
		for _, item := range t.cfg.Tasks.Items {
			total++
			if item.Enable {
				enabled++
			}
		}
	}
	runs, failures := uint64(0), uint64(0)
	for _, st := range t.states {
		runs += st.snapshot().Runs
		failures += st.snapshot().Failures
	}
	return map[string]any{
		"tasks":         total,
		"enabled":       enabled,
		"scheduled":     len(t.entries),
		"running":       t.running,
		"totalRuns":     runs,
		"totalFailures": failures,
		"allowShell":    t.cfg != nil && t.cfg.Tasks.AllowShell,
	}
}

// Items returns the configured tasks together with their runtime state.
func (t *Task) Items() []Item {
	t.mu.Lock()
	var tasks []model.Task
	var allowShell bool
	if t.cfg != nil {
		tasks = append(tasks, t.cfg.Tasks.Items...)
		allowShell = t.cfg.Tasks.AllowShell
	}
	scheduled := map[string]bool{}
	for id := range t.entries {
		scheduled[id] = true
	}
	states := make(map[string]*taskState, len(t.states))
	for id, st := range t.states {
		states[id] = st
	}
	t.mu.Unlock()

	out := make([]Item, 0, len(tasks))
	for _, item := range tasks {
		it := Item{Task: item, Scheduled: scheduled[item.ID], AllowShell: allowShell}
		if st := states[item.ID]; st != nil {
			it.State = st.snapshot()
		} else {
			it.State = State{LastResult: "never run"}
		}
		if item.Enable {
			if sched, err := cron.ParseStandard(item.Cron); err == nil {
				next := sched.Next(time.Now())
				it.NextRun = &next
			}
		}
		out = append(out, it)
	}
	return out
}

// StateOf returns the runtime state of one task.
func (t *Task) StateOf(id string) (State, bool) {
	t.mu.Lock()
	st := t.states[id]
	t.mu.Unlock()
	if st == nil {
		return State{}, false
	}
	return st.snapshot(), true
}

// Item is a task as returned by the API.
type Item struct {
	model.Task
	State      State      `json:"state"`
	NextRun    *time.Time `json:"nextRun,omitempty"`
	Scheduled  bool       `json:"scheduled"`
	AllowShell bool       `json:"allowShell"`
}

// ---------------------------------------------------------------------------
// scheduling
// ---------------------------------------------------------------------------

// apply rebuilds the cron entries. It must be called with t.mu held.
func (t *Task) apply(cfg *model.Config) {
	if t.cron == nil {
		return
	}
	desired := map[string]model.Task{}
	for _, item := range cfg.Tasks.Items {
		if !item.Enable {
			continue
		}
		if _, err := cron.ParseStandard(item.Cron); err != nil {
			t.log.Error("task: invalid cron expression, task skipped",
				"task", taskLabel(item), "cron", item.Cron, "error", err)
			continue
		}
		desired[item.ID] = item
	}

	for id, entry := range t.entries {
		if _, keep := desired[id]; keep {
			continue
		}
		t.cron.Remove(entry)
		delete(t.entries, id)
	}
	for id, item := range desired {
		if _, ok := t.entries[id]; ok {
			continue
		}
		task := item
		entry, err := t.cron.AddFunc(item.Cron, func() { t.trigger(task) })
		if err != nil {
			t.log.Error("task: cannot schedule task", "task", taskLabel(task), "cron", task.Cron, "error", err)
			continue
		}
		t.entries[id] = entry
	}
}

// queueWait bounds how long a run waits for a free concurrency slot before it
// is skipped.
const queueWait = 2 * time.Second

// trigger spawns one asynchronous run of a task, bounded by a semaphore.
func (t *Task) trigger(task model.Task) {
	t.mu.Lock()
	stopped := t.stopped
	t.mu.Unlock()
	if stopped {
		return
	}

	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		select {
		case t.sem <- struct{}{}:
		case <-time.After(queueWait):
			t.log.Warn("task: too many concurrent runs, skipped", "task", taskLabel(task))
			return
		}
		defer func() { <-t.sem }()
		t.runOne(context.Background(), task, "schedule")
	}()
}

// run runs a task once, out of band ("run now").
func (t *Task) run(ctx context.Context, task model.Task) {
	t.mu.Lock()
	stopped := t.stopped
	t.mu.Unlock()
	if stopped {
		return
	}

	// "Run now" is queued from an HTTP handler that answers 202 immediately, so
	// the work has to outlive the request. context.WithoutCancel keeps the
	// request values while dropping its cancellation and deadline; every action
	// applies its own timeout anyway.
	ctx = context.WithoutCancel(ctx)

	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		select {
		case t.sem <- struct{}{}:
		case <-time.After(queueWait):
			t.log.Warn("task: too many concurrent runs, skipped", "task", taskLabel(task))
			return
		}
		defer func() { <-t.sem }()
		t.runOne(ctx, task, "manual")
	}()
}

func (t *Task) runOne(ctx context.Context, task model.Task, trigger string) {
	start := time.Now()
	t.mu.Lock()
	st := t.states[task.ID]
	if st == nil {
		st = newTaskState(task.Name)
		t.states[task.ID] = st
	}
	t.running++
	t.mu.Unlock()
	st.start()

	defer func() {
		t.mu.Lock()
		t.running--
		t.mu.Unlock()
	}()

	defer func() {
		if rec := recover(); rec != nil {
			st.complete(start, fmt.Errorf("panic: %v", rec), "")
			t.mu.Lock()
			t.running--
			t.mu.Unlock()
			t.log.Error("task: action panicked", "task", taskLabel(task), "panic", rec)
		}
	}()

	preview, err := t.execute(ctx, task, st)
	st.complete(start, err, preview)
	if err != nil {
		t.log.Error("task: run failed", "task", taskLabel(task), "trigger", trigger, "error", err)
		t.notifyFailure(task, err)
		return
	}
	t.log.Info("task: run finished", "task", taskLabel(task), "trigger", trigger,
		"duration", time.Since(start).Round(time.Millisecond).String())
}

// execute runs every action in order and stores a per-action log.
func (t *Task) execute(ctx context.Context, task model.Task, st *taskState) (string, error) {
	var b strings.Builder
	var firstErr error
	for i, action := range task.Actions {
		actionStart := time.Now()
		out, err := t.runAction(ctx, task, action)
		entry := ActionLog{
			Index:    i,
			Type:     action.Type,
			Target:   action.Target,
			OK:       err == nil,
			Output:   out,
			Duration: time.Since(actionStart),
			Time:     actionStart,
		}
		fmt.Fprintf(&b, "[%d] %s: ", i+1, action.Type)
		if err != nil {
			entry.Error = err.Error()
			fmt.Fprintf(&b, "failed: %v\n", err)
			if out != "" {
				fmt.Fprintf(&b, "    %s\n", out)
			}
			st.addAction(entry)
			if firstErr == nil {
				firstErr = fmt.Errorf("action %d (%s): %w", i+1, action.Type, err)
			}
			break
		}
		if out != "" {
			fmt.Fprintf(&b, "ok: %s\n", out)
		} else {
			b.WriteString("ok\n")
		}
		st.addAction(entry)
	}
	return truncate(b.String(), outputPreviewLimit), firstErr
}

// runAction dispatches one action. It never calls os.Exit and contains no
// shell interpolation: shell.exec runs the configured command directly.
func (t *Task) runAction(ctx context.Context, task model.Task, action model.TaskAction) (string, error) {
	switch action.Type {
	case model.ActionModuleToggle:
		return t.actionModuleToggle(ctx, action)
	case model.ActionRuleToggle:
		return t.actionRuleToggle(ctx, action)
	case model.ActionHTTP:
		return t.actionHTTP(ctx, action)
	case model.ActionNotify:
		return t.actionNotify(task, action)
	case model.ActionShell:
		return t.actionShell(ctx, task, action)
	case "":
		return "", errors.New("action type is required")
	default:
		return "", fmt.Errorf("unsupported action type %q", action.Type)
	}
}

func (t *Task) actionModuleToggle(ctx context.Context, action model.TaskAction) (string, error) {
	target, value := resolveTarget(action)
	if target == "" {
		return "", errors.New("module.toggle requires a target module name")
	}
	if t.deps.Registry == nil {
		return "", errors.New("the module registry is unavailable")
	}
	mod, ok := t.deps.Registry.Get(target)
	if !ok {
		return "", fmt.Errorf("module %q does not exist", target)
	}
	on, err := resolveToggle(value, mod.Status().Running)
	if err != nil {
		return "", err
	}

	runCtx, cancel := context.WithTimeout(ctx, defaultRunTimeout)
	defer cancel()
	if on {
		if err := mod.Start(runCtx); err != nil {
			return "", fmt.Errorf("start module %s: %w", target, err)
		}
		return "module " + target + " started", nil
	}
	if err := mod.Stop(runCtx); err != nil {
		return "", fmt.Errorf("stop module %s: %w", target, err)
	}
	return "module " + target + " stopped", nil
}

func (t *Task) actionRuleToggle(ctx context.Context, action model.TaskAction) (string, error) {
	target, value := resolveTarget(action)
	if target == "" {
		return "", errors.New("rule.toggle requires a target such as web:<id>")
	}
	kind, id := splitTarget(target)
	if id == "" {
		return "", fmt.Errorf("rule.toggle target %q must be <kind>:<id>", target)
	}

	on, err := t.currentRuleEnabled(kind, id)
	if err != nil {
		return "", err
	}
	on, err = resolveToggle(value, on)
	if err != nil {
		return "", err
	}
	if err := t.setRuleEnabled(kind, id, on); err != nil {
		return "", err
	}
	if t.deps.Registry != nil && t.deps.Cfg != nil {
		t.deps.Registry.Reload(t.deps.Cfg.Snapshot())
	}
	state := "disabled"
	if on {
		state = "enabled"
	}
	return fmt.Sprintf("%s rule %s %s", kind, id, state), nil
}

func (t *Task) actionHTTP(ctx context.Context, action model.TaskAction) (string, error) {
	url := strings.TrimSpace(action.URL)
	if url == "" {
		return "", errors.New("http.request requires a url")
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "", fmt.Errorf("unsupported url %q: only http and https are allowed", url)
	}
	method := strings.ToUpper(strings.TrimSpace(action.Method))
	if method == "" {
		method = "GET"
	}
	reqCtx, cancel := context.WithTimeout(ctx, defaultRunTimeout)
	defer cancel()

	req := httpc.Request{Method: method, URL: url, Headers: action.Headers, Body: action.Body, Client: httpClient}
	if action.Body != "" {
		req.ContentType = "application/json"
	}
	code, body, err := httpc.Do(reqCtx, req)
	if err != nil {
		return "", fmt.Errorf("request %s %s: %w", method, url, err)
	}
	text := truncate(strings.TrimSpace(string(body)), httpPreviewLimit)
	if code >= 400 {
		return text, fmt.Errorf("%s %s returned HTTP %d", method, url, code)
	}
	return fmt.Sprintf("HTTP %d %s", code, text), nil
}

func (t *Task) actionNotify(task model.Task, action model.TaskAction) (string, error) {
	if t.deps.Notify == nil {
		return "", errors.New("the notification service is unavailable")
	}
	message := strings.TrimSpace(action.Value)
	if message == "" {
		message = strings.TrimSpace(action.Body)
	}
	if message == "" {
		message = "task " + taskLabel(task) + " notification"
	}
	t.deps.Notify.Emit(notify.EventAlert, "task "+taskLabel(task), message, map[string]any{
		"taskId": task.ID,
		"source": "task",
	})
	return "notification queued", nil
}

// actionShell executes a command directly, without a shell, and only when the
// operator enabled shell execution explicitly in the configuration.
func (t *Task) actionShell(ctx context.Context, task model.Task, action model.TaskAction) (string, error) {
	if t.deps.Cfg == nil || !t.deps.Cfg.Snapshot().Tasks.AllowShell {
		return "", errors.New("shell execution is disabled; enable allowShell in the task settings first")
	}
	command := strings.TrimSpace(action.Command)
	if command == "" {
		return "", errors.New("shell.exec requires a command")
	}

	runCtx, cancel := context.WithTimeout(ctx, shellTimeout)
	defer cancel()
	// The command is passed to the operating system directly: no shell is
	// involved, so the value can never be interpreted by cmd.exe or /bin/sh.
	cmd := exec.CommandContext(runCtx, command)
	out := &limitedBuffer{limit: shellOutputLimit}
	cmd.Stdout = out
	cmd.Stderr = out

	runErr := cmd.Run()
	text := truncate(strings.TrimSpace(out.String()), outputPreviewLimit)
	if runCtx.Err() == context.DeadlineExceeded {
		return text, fmt.Errorf("command %q exceeded %s", command, shellTimeout)
	}
	if runErr != nil {
		return text, fmt.Errorf("command %q failed: %w", command, runErr)
	}
	if text == "" {
		text = "command finished without output"
	}
	return text, nil
}

// notifyFailure reports a failed run through the configured webhooks.
func (t *Task) notifyFailure(task model.Task, err error) {
	if t.deps.Notify == nil {
		return
	}
	t.deps.Notify.Emit(notify.EventAlert, "task failed: "+taskLabel(task), err.Error(), map[string]any{
		"taskId": task.ID,
		"cron":   task.Cron,
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func (t *Task) snapshot() *model.Config {
	if t.deps == nil || t.deps.Cfg == nil {
		return nil
	}
	return t.deps.Cfg.Snapshot()
}

// detailLocked builds the status detail text; t.mu must be held.
func (t *Task) detailLocked() string {
	if t.cron == nil {
		return "stopped"
	}
	total := 0
	if t.cfg != nil {
		total = len(t.cfg.Tasks.Items)
	}
	if len(t.entries) == 0 {
		return fmt.Sprintf("no scheduled task (%d configured)", total)
	}
	return fmt.Sprintf("%d scheduled of %d configured tasks", len(t.entries), total)
}

func (t *Task) taskByID(id string) (model.Task, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cfg == nil {
		return model.Task{}, false
	}
	for _, item := range t.cfg.Tasks.Items {
		if item.ID == id {
			return item, true
		}
	}
	return model.Task{}, false
}

// resolveTarget understands both the {"target":...,"value":...} object form and
// the plain string form of an action payload.
func resolveTarget(action model.TaskAction) (string, string) {
	target := strings.TrimSpace(action.Target)
	value := strings.TrimSpace(action.Value)

	if strings.HasPrefix(target, "{") {
		var payload struct {
			Target any `json:"target"`
			Value  any `json:"value"`
		}
		if err := json.Unmarshal([]byte(target), &payload); err == nil {
			if payload.Target != nil {
				target = stringify(payload.Target)
			}
			if payload.Value != nil {
				value = stringify(payload.Value)
			}
		}
	}

	kind, _ := splitTarget(target)
	if !isRuleKind(kind) {
		return target, value
	}
	state := strings.TrimSpace(action.URL)
	if isToggleWord(value) {
		// "web:f1" with the state in the url field.
		if state != "" {
			value = state
		}
		return target, value
	}
	if !strings.Contains(target, ":") && value != "" {
		// The editor sends the kind in target and the id in value.
		target += ":" + value
	}
	value = state
	return target, value
}

// isRuleKind reports whether a toggle target names a rule kind.
func isRuleKind(kind string) bool {
	switch kind {
	case "web", "forward", "ddns":
		return true
	default:
		return false
	}
}

// isToggleWord reports whether a value looks like an on/off state rather than a
// rule id.
func isToggleWord(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on", "off", "true", "false", "1", "0", "yes", "no", "toggle", "enable", "disable",
		"enabled", "disabled", "start", "stop", "restart":
		return true
	default:
		return false
	}
}

func stringify(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	if v == nil {
		return ""
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return strings.TrimSpace(string(raw))
}

// splitTarget splits "web:1a2b" into its kind and id.
func splitTarget(target string) (string, string) {
	target = strings.TrimSpace(target)
	idx := strings.Index(target, ":")
	if idx < 0 {
		return strings.ToLower(target), ""
	}
	return strings.ToLower(strings.TrimSpace(target[:idx])), strings.TrimSpace(target[idx+1:])
}

// resolveToggle converts the action value into an explicit state. An empty or
// "toggle" value flips the current state.
func resolveToggle(value string, current bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "toggle", "switch", "flip", "restart":
		return !current, nil
	case "on", "true", "1", "yes", "enable", "enabled", "start", "started":
		return true, nil
	case "off", "false", "0", "no", "disable", "disabled", "stop", "stopped":
		return false, nil
	default:
		return false, fmt.Errorf("invalid value %q: expected on/off or toggle", value)
	}
}

func taskLabel(task model.Task) string {
	if strings.TrimSpace(task.Name) != "" {
		return task.Name
	}
	return task.ID
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "...(truncated)"
}

// limitedBuffer collects command output up to a fixed size so a chatty command
// cannot exhaust memory.
type limitedBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - len(b.buf); room > 0 {
		if len(p) <= room {
			b.buf = append(b.buf, p...)
		} else {
			b.buf = append(b.buf, p[:room]...)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
