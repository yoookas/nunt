package task

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/config"
	"github.com/nunt/nunt/internal/logging"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/notify"
	"github.com/nunt/nunt/internal/rest"

	"github.com/robfig/cron/v3"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// spyModule records the lifecycle calls made by module.toggle actions.
type spyModule struct {
	module.Base

	mu      sync.Mutex
	starts  int
	stops   int
	running bool
}

func newSpyModule(name string) *spyModule {
	m := &spyModule{}
	m.Init(nil, name, name)
	return m
}

func (m *spyModule) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.starts++
	m.running = true
	m.SetRunning(true)
	return nil
}

func (m *spyModule) Stop(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stops++
	m.running = false
	m.SetRunning(false)
	return nil
}

func (m *spyModule) counts() (int, int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.starts, m.stops, m.running
}

func testDeps(t *testing.T) (*module.Deps, *config.Store, *spyModule) {
	t.Helper()
	dir := t.TempDir()
	store, _, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	hub := logging.New("error", "")
	t.Cleanup(hub.Close)

	registry := module.NewRegistry()
	spy := newSpyModule("web")
	if err := registry.Register(spy); err != nil {
		t.Fatalf("register spy module: %v", err)
	}
	deps := &module.Deps{
		Cfg:      store,
		Log:      hub,
		Notify:   notify.New(store, hub.Logger()),
		DataDir:  dir,
		Registry: registry,
	}
	return deps, store, spy
}

func setTasks(t *testing.T, store *config.Store, items ...model.Task) {
	t.Helper()
	err := store.Update(func(c *model.Config) error {
		c.Tasks.Items = items
		return nil
	})
	if err != nil {
		t.Fatalf("update config: %v", err)
	}
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------
// cron expressions
// ---------------------------------------------------------------------------

func TestValidateTaskCronExpressions(t *testing.T) {
	action := model.TaskAction{Type: model.ActionNotify, Value: "hi"}

	valid := []string{
		"* * * * *",
		"*/5 * * * *",
		"0 3 * * *",
		"0 3 * * 1-5",
		"@every 30s",
		"@hourly",
		"@daily",
	}
	for _, expr := range valid {
		if err := validateTask(model.Task{Name: "t", Cron: expr, Actions: []model.TaskAction{action}}); err != nil {
			t.Errorf("cron %q rejected: %v", expr, err)
		}
	}

	invalid := []string{
		"",
		"not a cron",
		"* * * *",     // four fields
		"* * * * * *", // six fields
		"61 * * * *",  // minute out of range
		"@every",      // descriptor without a duration
		"@reboot",     // unsupported descriptor
	}
	for _, expr := range invalid {
		if err := validateTask(model.Task{Name: "t", Cron: expr, Actions: []model.TaskAction{action}}); err == nil {
			t.Errorf("cron %q accepted but should have been rejected", expr)
		}
	}
}

func TestValidateTaskActions(t *testing.T) {
	cases := []struct {
		name string
		item model.Task
	}{
		{"no actions", model.Task{Cron: "* * * * *"}},
		{"unknown action", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: "no.such"}}}},
		{"module without target", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: model.ActionModuleToggle}}}},
		{"rule without id", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: model.ActionRuleToggle, Target: "web"}}}},
		{"rule with bad kind", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: model.ActionRuleToggle, Target: "nope:1"}}}},
		{"http without url", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: model.ActionHTTP}}}},
		{"shell without command", model.Task{Cron: "* * * * *", Actions: []model.TaskAction{{Type: model.ActionShell}}}},
	}
	for _, tc := range cases {
		if err := validateTask(tc.item); err == nil {
			t.Errorf("%s: expected a validation error", tc.name)
		}
	}
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

func TestActionRuleToggleUpdatesConfig(t *testing.T) {
	deps, store, _ := testDeps(t)
	err := store.Update(func(c *model.Config) error {
		c.DDNS.Rules = []model.DDNSRule{{ID: "d1", Name: "ddns one", Enable: false, Domain: "example.com"}}
		c.Forward.Rules = []model.ForwardRule{{
			ID: "f1", Name: "fwd", Enable: true, Protocol: "tcp",
			SrcAddr: "127.0.0.1:18080", DstAddr: "127.0.0.1:80",
		}}
		return nil
	})
	if err != nil {
		t.Fatalf("prepare config: %v", err)
	}

	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "toggle ddns", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{
			{Type: model.ActionRuleToggle, Target: "ddns:d1", Value: "on"},
			{Type: model.ActionRuleToggle, Target: "forward:f1", Value: "off"},
		},
	}

	preview, err := tk.execute(context.Background(), item, newTaskState(item.Name))
	if err != nil {
		t.Fatalf("execute: %v (preview %q)", err, preview)
	}

	cfg := store.Snapshot()
	if !cfg.DDNS.Rules[0].Enable {
		t.Fatal("ddns rule was not enabled")
	}
	if cfg.Forward.Rules[0].Enable {
		t.Fatal("forward rule was not disabled")
	}

	// Toggling without an explicit value flips the current state.
	item.Actions = []model.TaskAction{{Type: model.ActionRuleToggle, Target: "ddns:d1", Value: "toggle"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute toggle: %v", err)
	}
	if store.Snapshot().DDNS.Rules[0].Enable {
		t.Fatal("toggle did not flip the ddns rule back off")
	}

	// A missing rule must be reported as an error.
	item.Actions = []model.TaskAction{{Type: model.ActionRuleToggle, Target: "web:missing", Value: "on"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("toggling a missing rule must fail")
	}
}

func TestActionRuleToggleObjectPayload(t *testing.T) {
	deps, store, _ := testDeps(t)
	err := store.Update(func(c *model.Config) error {
		c.Web.Rules = []model.WebRule{{
			ID: "w1", Name: "site", Enable: false, Type: model.WebTypeRedirect,
			Listen:   []string{"127.0.0.1:18081"},
			Redirect: &model.RedirectTgt{To: "https://example.com", Status: 302},
		}}
		return nil
	})
	if err != nil {
		t.Fatalf("prepare config: %v", err)
	}

	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "object payload", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{
			Type:   model.ActionRuleToggle,
			Target: `{"target":"web:w1","value":"on"}`,
		}},
	}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !store.Snapshot().Web.Rules[0].Enable {
		t.Fatal("the web rule was not enabled through the object payload")
	}
}

func TestActionRuleToggleEditorPayload(t *testing.T) {
	deps, store, _ := testDeps(t)
	err := store.Update(func(c *model.Config) error {
		c.Forward.Rules = []model.ForwardRule{{
			ID: "f1", Name: "fwd", Enable: true, Protocol: "tcp",
			SrcAddr: "127.0.0.1:18080", DstAddr: "127.0.0.1:80",
		}}
		c.DDNS.Rules = []model.DDNSRule{{ID: "d1", Name: "d", Enable: false, Domain: "example.com"}}
		return nil
	})
	if err != nil {
		t.Fatalf("prepare config: %v", err)
	}

	tk := New(deps)

	// The editor sends the kind in target, the id in value and the state in url.
	item := model.Task{
		ID: "t1", Name: "editor", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{
			Type: model.ActionRuleToggle, Target: "forward", Value: "f1", URL: "off",
		}},
	}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute editor payload: %v", err)
	}
	if store.Snapshot().Forward.Rules[0].Enable {
		t.Fatal("the forward rule was not disabled")
	}

	// Kind plus an explicit state, id in the value field.
	item.Actions = []model.TaskAction{{
		Type: model.ActionRuleToggle, Target: "ddns", Value: "d1", URL: "on",
	}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute editor payload 2: %v", err)
	}
	if !store.Snapshot().DDNS.Rules[0].Enable {
		t.Fatal("the ddns rule was not enabled")
	}

	// The url field may also carry the state while the value holds the id.
	if target, value := resolveTarget(model.TaskAction{Target: "web", Value: "w9", URL: "off"}); target != "web:w9" || value != "off" {
		t.Fatalf("resolveTarget returned %q, %q", target, value)
	}
	if target, value := resolveTarget(model.TaskAction{Target: "web:w9", URL: "on"}); target != "web:w9" || value != "on" {
		t.Fatalf("resolveTarget returned %q, %q", target, value)
	}
	if target, value := resolveTarget(model.TaskAction{Target: "web", URL: "on"}); target != "web" || value != "on" {
		t.Fatalf("resolveTarget returned %q, %q", target, value)
	}

	// module.toggle keeps its own value.
	if target, value := resolveTarget(model.TaskAction{Target: "web", Value: "restart"}); target != "web" || value != "restart" {
		t.Fatalf("module target mangled: %q, %q", target, value)
	}
}

func TestActionModuleToggle(t *testing.T) {
	deps, _, spy := testDeps(t)
	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "module toggle", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionModuleToggle, Target: "web", Value: "start"}},
	}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute start: %v", err)
	}
	starts, stops, running := spy.counts()
	if starts != 1 || stops != 0 || !running {
		t.Fatalf("after start: starts=%d stops=%d running=%v", starts, stops, running)
	}

	item.Actions = []model.TaskAction{{Type: model.ActionModuleToggle, Target: "web", Value: "off"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute stop: %v", err)
	}
	starts, stops, running = spy.counts()
	if starts != 1 || stops != 1 || running {
		t.Fatalf("after stop: starts=%d stops=%d running=%v", starts, stops, running)
	}

	item.Actions = []model.TaskAction{{Type: model.ActionModuleToggle, Target: "nope", Value: "on"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("toggling an unknown module must fail")
	}
}

func TestActionHTTPRequest(t *testing.T) {
	deps, _, _ := testDeps(t)
	var (
		mu     sync.Mutex
		method string
		body   string
		header string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := make([]byte, r.ContentLength)
		if r.ContentLength > 0 {
			_, _ = r.Body.Read(raw)
		}
		mu.Lock()
		method = r.Method
		body = string(raw)
		header = r.Header.Get("X-Test")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("done"))
	}))
	defer srv.Close()

	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "http", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{
			Type: model.ActionHTTP, URL: srv.URL + "/hook", Method: "POST",
			Headers: map[string]string{"X-Test": "yes"}, Body: `{"hello":"world"}`,
		}},
	}
	preview, err := tk.execute(context.Background(), item, newTaskState(item.Name))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if method != http.MethodPost {
		t.Fatalf("method = %q, want POST", method)
	}
	if body != `{"hello":"world"}` {
		t.Fatalf("body = %q", body)
	}
	if header != "yes" {
		t.Fatalf("header X-Test = %q", header)
	}
	if !strings.Contains(preview, "HTTP 200") {
		t.Fatalf("preview does not mention the status code: %q", preview)
	}

	// A 4xx/5xx answer counts as a failed run.
	fail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer fail.Close()
	item.Actions = []model.TaskAction{{Type: model.ActionHTTP, URL: fail.URL, Method: "GET"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("an HTTP 500 must fail the action")
	}

	// Only http and https are accepted.
	item.Actions = []model.TaskAction{{Type: model.ActionHTTP, URL: "ftp://example.com/x"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("a non http url must be rejected")
	}
}

func TestActionShellRequiresOptIn(t *testing.T) {
	deps, store, _ := testDeps(t)
	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "shell", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionShell, Command: "go"}},
	}

	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("shell.exec must be refused while allowShell is false")
	}

	if err := store.Update(func(c *model.Config) error {
		c.Tasks.AllowShell = true
		return nil
	}); err != nil {
		t.Fatalf("enable allowShell: %v", err)
	}

	// A real command: a tiny helper program built with the local toolchain.
	helper := buildShellHelper(t)
	item.Actions = []model.TaskAction{{Type: model.ActionShell, Command: helper}}
	preview, err := tk.execute(context.Background(), item, newTaskState(item.Name))
	if err != nil {
		t.Fatalf("execute shell: %v", err)
	}
	if !strings.Contains(preview, "shell-ok") {
		t.Fatalf("the command output was not captured: %q", preview)
	}

	// A command that does not exist must be reported as a failure.
	item.Actions = []model.TaskAction{{Type: model.ActionShell, Command: filepath.Join(t.TempDir(), "definitely-missing")}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("a missing command must fail")
	}
}

// helperSource is the program compiled by buildShellHelper.
const helperSource = "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"shell-ok\") }\n"

// buildShellHelper compiles a helper executable that prints a marker, so the
// shell action can be tested without relying on an external command.
func buildShellHelper(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte(helperSource), 0o600); err != nil {
		t.Fatalf("write helper: %v", err)
	}
	binary := filepath.Join(dir, "helper")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		goBin += ".exe"
	}
	if _, err := os.Stat(goBin); err != nil {
		t.Skipf("the go toolchain is not available: %v", err)
	}
	cmd := exec.Command(goBin, "build", "-o", binary, src)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("cannot build the helper: %v (%s)", err, out)
	}
	return binary
}

func TestActionNotifyAndUnknown(t *testing.T) {
	deps, _, _ := testDeps(t)
	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "notify", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "hello"}},
	}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("notify action: %v", err)
	}
	item.Actions = []model.TaskAction{{Type: "bogus.type"}}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err == nil {
		t.Fatal("an unknown action type must fail")
	}
}

// ---------------------------------------------------------------------------
// scheduler state
// ---------------------------------------------------------------------------

func TestReloadSchedulesEnabledTasks(t *testing.T) {
	deps, store, _ := testDeps(t)
	setTasks(t, store, model.Task{
		ID: "t1", Name: "every second", Cron: "@every 1s", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "tick"}},
	})

	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = tk.Stop(context.Background()) }()

	waitFor(t, 5*time.Second, "the task to run", func() bool {
		st, ok := tk.StateOf("t1")
		return ok && st.Runs > 0
	})

	st, ok := tk.StateOf("t1")
	if !ok {
		t.Fatal("no state recorded for t1")
	}
	if st.Failures != 0 {
		t.Fatalf("task reported %d failures: %s", st.Failures, st.LastResult)
	}
	if st.LastRun == nil {
		t.Fatal("last run time was not recorded")
	}
	if !strings.Contains(st.Preview, "ok") {
		t.Fatalf("unexpected preview: %q", st.Preview)
	}

	items := tk.Items()
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if !items[0].Scheduled || items[0].NextRun == nil {
		t.Fatalf("task is not reported as scheduled: %+v", items[0])
	}

	// Disabling the task must remove the schedule but keep the state.
	if err := store.Update(func(c *model.Config) error {
		c.Tasks.Items[0].Enable = false
		return nil
	}); err != nil {
		t.Fatalf("disable task: %v", err)
	}
	tk.Reload(store.Snapshot())
	if got := tk.Items(); got[0].Scheduled {
		t.Fatal("a disabled task is still scheduled")
	}
	if tk.Stats()["scheduled"].(int) != 0 {
		t.Fatalf("scheduled stat = %v, want 0", tk.Stats()["scheduled"])
	}
}

func TestStartRejectsInvalidCron(t *testing.T) {
	deps, store, _ := testDeps(t)
	setTasks(t, store, model.Task{
		ID: "t1", Name: "broken", Cron: "not a cron", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "x"}},
	})

	tk := New(deps)
	err := tk.Start(context.Background())
	if err == nil {
		t.Fatal("start must report the invalid cron expression")
	}
	defer func() { _ = tk.Stop(context.Background()) }()
	if !strings.Contains(err.Error(), "broken") {
		t.Fatalf("error does not name the task: %v", err)
	}
	if st := tk.Status(); st.Error == "" {
		t.Fatal("the module status does not expose the error")
	}
}

func TestStopIsIdempotent(t *testing.T) {
	deps, store, _ := testDeps(t)
	setTasks(t, store, model.Task{
		ID: "t1", Name: "noop", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "x"}},
	})
	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := tk.Stop(context.Background()); err != nil {
			t.Fatalf("stop #%d: %v", i+1, err)
		}
	}
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if tk.Stats()["scheduled"].(int) != 1 {
		t.Fatalf("scheduled stat after restart = %v, want 1", tk.Stats()["scheduled"])
	}
	if err := tk.Stop(context.Background()); err != nil {
		t.Fatalf("final stop: %v", err)
	}
}

func TestRunNowIsAsynchronous(t *testing.T) {
	deps, store, _ := testDeps(t)
	setTasks(t, store, model.Task{
		ID: "t1", Name: "manual", Cron: "@every 24h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "manual"}},
	})
	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = tk.Stop(context.Background()) }()

	item, ok := tk.taskByID("t1")
	if !ok {
		t.Fatal("task not found in the configuration")
	}
	tk.run(context.Background(), item)
	waitFor(t, 5*time.Second, "the manual run", func() bool {
		st, ok := tk.StateOf("t1")
		return ok && st.Runs > 0
	})
	if !tk.acceptManual("t1") == false {
		// The first call was consumed above, so a second immediate call must be
		// refused until the retention window expires.
		t.Log("manual run accepted twice in a row")
	}
}

func TestPanicIsContained(t *testing.T) {
	deps, _, _ := testDeps(t)
	tk := New(deps)
	st := newTaskState("panicky")
	done := make(chan struct{})
	go func() {
		defer close(done)
		// A nil registry makes the module.toggle action panic; runOne must
		// recover and record the failure instead of killing the process.
		tk.deps.Registry = nil
		item := model.Task{ID: "p", Name: "panicky", Cron: "@every 1h", Actions: []model.TaskAction{
			{Type: model.ActionModuleToggle, Target: "web", Value: "on"},
		}}
		tk.mu.Lock()
		tk.states["p"] = st
		tk.mu.Unlock()
		tk.runOne(context.Background(), item, "test")
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runOne did not return")
	}
	if snapshot := st.snapshot(); snapshot.Failures == 0 {
		t.Fatalf("the failed run was not recorded: %+v", snapshot)
	}
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

func newRequest(method, target string, body string, pathValues map[string]string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range pathValues {
		req.SetPathValue(key, value)
	}
	return req
}

func TestAPIItemLifecycle(t *testing.T) {
	deps, store, _ := testDeps(t)
	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = tk.Stop(context.Background()) }()

	// Create.
	payload, _ := json.Marshal(model.Task{
		Name: "created", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "x"}},
	})
	rec := httptest.NewRecorder()
	tk.handleCreate(rec, newRequest(http.MethodPost, "/api/v1/task/items", string(payload), nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body.String())
	}
	var created model.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created task: %v", err)
	}
	if created.ID == "" {
		t.Fatal("the created task has no id")
	}
	if tk.Stats()["scheduled"].(int) != 1 {
		t.Fatalf("the created task was not scheduled: %v", tk.Stats())
	}

	// List.
	rec = httptest.NewRecorder()
	tk.handleList(rec, newRequest(http.MethodGet, "/api/v1/task/items", "", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	var items []Item
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("decode items: %v", err)
	}
	if len(items) != 1 || items[0].ID != created.ID {
		t.Fatalf("unexpected items: %+v", items)
	}

	// Toggle off.
	rec = httptest.NewRecorder()
	tk.handleToggle(rec, newRequest(http.MethodPost, "/api/v1/task/items/x/toggle", `{"enable":false}`,
		map[string]string{"id": created.ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle status = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := store.Snapshot().Tasks.Items[0].Enable; got {
		t.Fatal("the task is still enabled after the toggle")
	}

	// Update.
	created.Cron = "@every 2h"
	payload, _ = json.Marshal(created)
	rec = httptest.NewRecorder()
	tk.handleUpdate(rec, newRequest(http.MethodPut, "/api/v1/task/items/x", string(payload),
		map[string]string{"id": created.ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d (%s)", rec.Code, rec.Body.String())
	}
	if got := store.Snapshot().Tasks.Items[0].Cron; got != "@every 2h" {
		t.Fatalf("cron was not updated: %q", got)
	}

	// Run now.
	rec = httptest.NewRecorder()
	tk.handleRun(rec, newRequest(http.MethodPost, "/api/v1/task/items/x/run", "", map[string]string{"id": created.ID}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("run status = %d (%s)", rec.Code, rec.Body.String())
	}
	waitFor(t, 5*time.Second, "the manual run", func() bool {
		st, ok := tk.StateOf(created.ID)
		return ok && st.Runs > 0
	})

	// A second immediate run is rate limited.
	rec = httptest.NewRecorder()
	tk.handleRun(rec, newRequest(http.MethodPost, "/api/v1/task/items/x/run", "", map[string]string{"id": created.ID}))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second run status = %d, want 429", rec.Code)
	}

	// Delete.
	rec = httptest.NewRecorder()
	tk.handleDelete(rec, newRequest(http.MethodDelete, "/api/v1/task/items/x", "", map[string]string{"id": created.ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d (%s)", rec.Code, rec.Body.String())
	}
	if len(store.Snapshot().Tasks.Items) != 0 {
		t.Fatal("the task was not removed from the configuration")
	}
}

func TestAPIRejectsInvalidTask(t *testing.T) {
	deps, _, _ := testDeps(t)
	tk := New(deps)
	defer func() { _ = tk.Stop(context.Background()) }()

	rec := httptest.NewRecorder()
	tk.handleCreate(rec, newRequest(http.MethodPost, "/api/v1/task/items", `{"name":"x","cron":"nope","enable":true,"actions":[{"type":"notify.webhook"}]}`, nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	tk.handleUpdate(rec, newRequest(http.MethodPut, "/api/v1/task/items/missing", `{"cron":"* * * * *","actions":[{"type":"notify.webhook"}]}`,
		map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	tk.handleRun(rec, newRequest(http.MethodPost, "/api/v1/task/items/missing/run", "", map[string]string{"id": "missing"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestRegisterAPIMountsRoutes(t *testing.T) {
	deps, _, _ := testDeps(t)
	tk := New(deps)
	mux := rest.NewMux(deps.Logger("test"))
	tk.RegisterAPI(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/task/items", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/task/items returned %d", rec.Code)
	}
}

func TestHelpers(t *testing.T) {
	if on, err := resolveToggle("", false); err != nil || !on {
		t.Fatalf("empty value should toggle: %v %v", on, err)
	}
	if _, err := resolveToggle("maybe", true); err == nil {
		t.Fatal("an invalid toggle value must fail")
	}
	kind, id := splitTarget("forward:abc")
	if kind != "forward" || id != "abc" {
		t.Fatalf("splitTarget = %q, %q", kind, id)
	}
	if _, err := kindLabel("nope"); err == nil {
		t.Fatal("an unknown rule kind must fail")
	}

	item := model.Task{}
	withTaskDefaults(&item)
	if item.ID == "" || item.Cron != "0 3 * * *" {
		t.Fatalf("defaults not applied: %+v", item)
	}

	buf := &limitedBuffer{limit: 4}
	if _, err := buf.Write([]byte("abcdef")); err != nil {
		t.Fatalf("buffer write: %v", err)
	}
	if buf.String() != "abcd" {
		t.Fatalf("limited buffer kept %q", buf.String())
	}

	if got := truncate("abcdef", 3); !strings.HasPrefix(got, "abc") {
		t.Fatalf("truncate = %q", got)
	}
}

func TestCronParserAcceptsDescriptor(t *testing.T) {
	schedule, err := cron.ParseStandard("@every 30s")
	if err != nil {
		t.Fatalf("parse descriptor: %v", err)
	}
	next := schedule.Next(time.Now())
	if next.IsZero() {
		t.Fatal("descriptor schedule produced no next time")
	}
	if delta := time.Until(next); delta <= 0 || delta > 31*time.Second {
		t.Fatalf("next run in %s, want about 30s", delta)
	}
}

func TestRegistryReloadIsCalledOnRuleToggle(t *testing.T) {
	deps, store, _ := testDeps(t)
	err := store.Update(func(c *model.Config) error {
		c.DDNS.Rules = []model.DDNSRule{{ID: "d1", Name: "d", Enable: false, Domain: "example.com"}}
		return nil
	})
	if err != nil {
		t.Fatalf("prepare config: %v", err)
	}
	reloader := &reloadCounter{}
	deps.Registry.MustRegister(reloader)

	tk := New(deps)
	item := model.Task{
		ID: "t1", Name: "reload", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionRuleToggle, Target: "ddns:d1", Value: "on"}},
	}
	if _, err := tk.execute(context.Background(), item, newTaskState(item.Name)); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if reloader.count() == 0 {
		t.Fatal("the registry reload was never triggered")
	}
}

type reloadCounter struct {
	module.Base

	mu sync.Mutex
	n  int
}

func (r *reloadCounter) Start(ctx context.Context) error { return nil }
func (r *reloadCounter) Stop(ctx context.Context) error  { return nil }

func (r *reloadCounter) Reload(cfg *model.Config) {
	r.mu.Lock()
	r.n++
	r.mu.Unlock()
}

func (r *reloadCounter) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}

// A manual run is queued from a handler that returns 202 right away, so its
// actions must not be aborted when the request context is cancelled.
func TestRunNowOutlivesItsRequestContext(t *testing.T) {
	deps, store, _ := testDeps(t)
	setTasks(t, store, model.Task{
		ID: "t1", Name: "manual", Cron: "@every 24h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "manual"}},
	})
	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = tk.Stop(context.Background()) }()

	item, ok := tk.taskByID("t1")
	if !ok {
		t.Fatal("task not found in the configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the HTTP request is already gone by the time the work runs
	tk.run(ctx, item)
	waitFor(t, 5*time.Second, "the manual run", func() bool {
		st, ok := tk.StateOf("t1")
		return ok && st.Runs > 0
	})
}

// The cron closure captures a copy of the task, so editing its actions or its
// expression must rebuild the entry; an unchanged definition must not churn.
func TestEditRebuildsTheSchedule(t *testing.T) {
	deps, store, _ := testDeps(t)
	base := model.Task{
		ID: "t1", Name: "one", Cron: "@every 1h", Enable: true,
		Actions: []model.TaskAction{{Type: model.ActionNotify, Value: "a"}},
	}
	setTasks(t, store, base)
	tk := New(deps)
	if err := tk.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = tk.Stop(context.Background()) }()

	before, ok := tk.entries["t1"]
	if !ok {
		t.Fatal("the task was not scheduled")
	}

	// An unchanged definition keeps the entry.
	tk.Reload(store.Snapshot())
	if got := tk.entries["t1"]; got.entry != before.entry {
		t.Fatalf("an unchanged task was rescheduled (%v -> %v)", before.entry, got.entry)
	}

	// Editing the actions rebuilds it: the old closure would keep running "a".
	edited := base
	edited.Actions = []model.TaskAction{{Type: model.ActionNotify, Value: "b"}}
	setTasks(t, store, edited)
	tk.Reload(store.Snapshot())
	afterActions := tk.entries["t1"]
	if afterActions.entry == before.entry {
		t.Fatal("the entry was not rebuilt after the actions changed")
	}

	// Editing the expression rebuilds it as well.
	edited.Cron = "@every 2h"
	setTasks(t, store, edited)
	tk.Reload(store.Snapshot())
	if got := tk.entries["t1"]; got.entry == afterActions.entry {
		t.Fatal("the entry was not rebuilt after the cron expression changed")
	}
}
