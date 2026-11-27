package waf

import (
	"context"
	"encoding/json"
	"github.com/nunt/nunt/internal/model"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidDisabledRule(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{name: "plain id", in: "942100", want: true},
		{name: "id range", in: "930000-939999", want: true},
		{name: "padded id", in: "0", want: true},
		{name: "empty", in: "", want: false},
		{name: "directive injection", in: "1; SecRuleEngine Off", want: false},
		{name: "newline injection", in: "1\x0aSecRuleEngine Off", want: false},
		{name: "quoted include", in: "900000, phase:1", want: false},
		{name: "letters", in: "abc", want: false},
		{name: "negative", in: "-1", want: false},
		{name: "open range", in: "1-", want: false},
		{name: "double range", in: "1-2-3", want: false},
		{name: "too long", in: strings.Repeat("9", 25), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validDisabledRule(tc.in); got != tc.want {
				t.Fatalf("validDisabledRule(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestBuildEngineRejectsDirectiveInjection(t *testing.T) {
	cfg := baseConfig()
	cfg.DisabledRules = []string{"1; SecRuleEngine Off"}
	if _, err := buildEngine(cfg, nil); err == nil {
		t.Fatal("expected the engine build to reject the injected directive")
	}
}

func TestBuildEngineRejectsBadRuleFile(t *testing.T) {
	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.RuleFiles = []string{"rules.txt"}
	if _, err := buildEngine(cfg, nil); err == nil {
		t.Fatal("expected a non .conf rule file to be rejected")
	}
}

func TestBuildEngineCustomRulesOnly(t *testing.T) {
	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.ExtraRules = `SecRule REQUEST_URI "@rx ^/blocked" "id:9001001,phase:1,deny,status:403,log,msg:'custom block'"`
	eng, err := buildEngine(cfg, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	defer func() { _ = eng.close() }()
	if eng.rules < 1 {
		t.Fatalf("expected at least one rule, got %d", eng.rules)
	}

	hits, err := eng.process(context.Background(), &requestMeta{
		ClientIP: "10.0.0.1", Method: "GET", URI: "/blocked", Proto: "HTTP/1.1", Host: "example.test",
		Headers: http.Header{},
	})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if !hits.Blocked || hits.RuleID != 9001001 {
		t.Fatalf("expected rule 9001001 to block, got %+v", hits)
	}

	pass, err := eng.process(context.Background(), &requestMeta{
		ClientIP: "10.0.0.1", Method: "GET", URI: "/open", Proto: "HTTP/1.1", Host: "example.test",
		Headers: http.Header{},
	})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if pass.Blocked {
		t.Fatalf("a clean request must not be blocked, got %+v", pass)
	}
}

func TestDisabledRuleRangeIsHonoured(t *testing.T) {
	catalog, _, err := builtinRuleFiles()
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	var xss ruleFile
	for _, f := range catalog {
		if strings.Contains(f.Name, "941") {
			xss = f
		}
	}
	if xss.File == "" {
		t.Fatal("the XSS rule file is missing from the catalog")
	}
	cfg := baseConfig()
	cfg.DisabledRules = []string{"941000-941999"}
	if !disabledByRange(cfg.DisabledRules, xss) {
		t.Fatalf("expected %s to be disabled by the range", xss.File)
	}
	eng, err := buildEngine(cfg, nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	defer func() { _ = eng.close() }()
	if eng.files == 0 {
		t.Fatal("expected the bundled rule files to be counted")
	}
}

func TestRulesFSNormalisesPaths(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "windows separator", in: "@owasp_crs\\REQUEST-901-INITIALIZATION.conf", want: "@owasp_crs/REQUEST-901-INITIALIZATION.conf"},
		{name: "leading dot", in: "./@owasp_crs/x.conf", want: "@owasp_crs/x.conf"},
		{name: "plain", in: "@owasp_crs/x.conf", want: "@owasp_crs/x.conf"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := crsPath(tc.in); got != tc.want {
				t.Fatalf("crsPath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
	if _, err := (rulesFS{}).ReadFile("@owasp_crs\\REQUEST-901-INITIALIZATION.conf"); err != nil {
		t.Fatalf("reading a CRS file through a windows path failed: %v", err)
	}
}

func TestBrokenRuleSetDoesNotTakeTheServiceDown(t *testing.T) {
	cfg := baseConfig()
	cfg.ExtraRules = "SecRule THIS IS NOT SECLANG"
	deps := testDeps(t, cfg)
	m := New(deps)
	ctx := context.Background()
	if err := m.Start(ctx); err != nil {
		t.Fatalf("start must not fail on a broken rule set: %v", err)
	}
	defer func() { _ = m.Stop(ctx) }()

	if m.Enabled() {
		t.Fatal("a broken rule set must leave the engine disabled")
	}
	if m.Status().Error == "" {
		t.Fatal("the build error must be reported in the status")
	}
	rec := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/?test=../../../../etc/passwd", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("traffic must pass while the engine is disabled, got %d", rec.Code)
	}
}

func TestNormalizePathSlash(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		changed bool
	}{
		{name: "posix path untouched", in: "/etc/passwd", want: "/etc/passwd"},
		{name: "argument untouched", in: ";cat /etc/passwd", want: ";cat /etc/passwd"},
		{name: "dot segment", in: "/a/./b", want: "/a/b", changed: true},
		{name: "dot dot segment", in: "/a/../b", want: "/b", changed: true},
		{name: "double slash", in: "/a//b", want: "/a/b", changed: true},
		{name: "trailing slash kept", in: "/a/b/", want: "/a/b/"},
		{name: "empty", in: "", want: ""},
		{name: "dot only", in: ".", want: "", changed: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed, err := normalizePathSlash(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizePathSlash(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if changed != tc.changed {
				t.Fatalf("normalizePathSlash(%q) changed = %v, want %v", tc.in, changed, tc.changed)
			}
		})
	}
}

func TestStripWindowsSuffixes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "plain", in: "/etc/passwd", want: "/etc/passwd"},
		{name: "alternate data stream", in: "/uploads/shell.php::$DATA", want: "/uploads/shell.php"},
		{name: "trailing dot", in: "/uploads/shell.php.", want: "/uploads/shell.php"},
		{name: "trailing space", in: "/uploads/shell.php ", want: "/uploads/shell.php"},
		{name: "drive letter kept", in: "C:/windows", want: "C:/windows"},
		{name: "empty", in: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripWindowsSuffixes(tc.in); got != tc.want {
				t.Fatalf("stripWindowsSuffixes(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRuleFilesOnDiskAreLoaded(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "custom.conf")
	content := "# \u81EA\u5B9A\u4E49\u62E6\u622A\u89C4\u5219\n" +
		"SecRule REQUEST_URI \"@rx ^/blocked\" \"id:9100001,phase:1,deny,status:403,log,msg:'custom file rule'\"\n"
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatalf("write rule file: %v", err)
	}

	cfg := baseConfig()
	cfg.UseCRS = false
	cfg.RuleFiles = []string{file}
	m := newTestModule(t, cfg)

	blocked := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/blocked", ""))
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("the disk rule must block, got %d (%s)", blocked.Code, blocked.Body.String())
	}
	if blocked.Body.String() == "" || strings.Contains(blocked.Body.String(), "/blocked") {
		t.Fatalf("unexpected block page: %q", blocked.Body.String())
	}
	passed := do(m, "site-a", okHandler("upstream"), newRequest(t, http.MethodGet, "/open", ""))
	if passed.Code != http.StatusOK {
		t.Fatalf("the disk rule must not block unrelated paths, got %d", passed.Code)
	}

	mux := newMux(t, m)
	rec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/rules", nil)
	var payload struct {
		Items []struct {
			File    string `json:"file"`
			Title   string `json:"title"`
			Builtin bool   `json:"builtin"`
			Enabled bool   `json:"enabled"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var item struct {
		File    string `json:"file"`
		Title   string `json:"title"`
		Builtin bool   `json:"builtin"`
		Enabled bool   `json:"enabled"`
	}
	found := false
	for _, entry := range payload.Items {
		if entry.File == file {
			item, found = entry, true
		}
	}
	if !found {
		t.Fatalf("the configured rule file is missing from the list")
	}
	if item.Builtin || !item.Enabled {
		t.Fatalf("unexpected entry: %+v", item)
	}
	if item.Title != "自定义拦截规则" {
		t.Fatalf("the title must come from the first comment, got %q", item.Title)
	}
}

func TestDirectiveStreamOrdering(t *testing.T) {
	cfg := baseConfig()
	cfg.DisabledRules = []string{"942100"}
	catalog, _, err := builtinRuleFiles()
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	b := renderDirectives(cfg, catalog)
	stream := b.String()

	prelude := strings.Index(stream, "SecAction \"id:1000001")
	include := strings.Index(stream, "Include "+crsRecommendedCfg)
	crsRules := strings.Index(stream, "Include "+crsRootDir+"/REQUEST-901")
	engine := strings.Index(stream, "SecRuleEngine On")
	limit := strings.Index(stream, "SecRequestBodyLimit 131072")
	if prelude < 0 || include < 0 || crsRules < 0 || engine < 0 || limit < 0 {
		t.Fatalf("the directive stream is incomplete: \n%s", stream)
	}
	if !(prelude < include && include < crsRules && crsRules < engine && engine < limit) {
		t.Fatalf("unexpected directive order: \n%s", stream)
	}
	if len(b.remove) != 1 || b.remove[0] != "SecRuleRemoveById 942100" {
		t.Fatalf("unexpected remove list: %v", b.remove)
	}
	if strings.Contains(stream, "SecRuleEngine DetectionOnly") {
		t.Fatalf("block mode must not emit DetectionOnly: \n%s", stream)
	}

	cfg.Mode = model.WAFModeDetect
	if b := renderDirectives(cfg, nil); !strings.Contains(b.String(), "SecRuleEngine DetectionOnly") {
		t.Fatalf("detect mode must emit DetectionOnly: \n%s", b.String())
	}
}

// A large inspection limit must not turn into an equally large per-request
// memory buffer: Coraza spills the excess to a temporary file.
func TestLargeBodyLimitUsesDiskSpool(t *testing.T) {
	cfg := baseConfig()
	cfg.BodyLimitKB = 20 * 1024 // 20 MiB
	stream := renderDirectives(cfg, nil).String()
	if !strings.Contains(stream, "SecRequestBodyLimit 20971520") {
		t.Fatalf("the inspection limit was not raised:\n%s", stream)
	}
	if !strings.Contains(stream, "SecRequestBodyInMemoryLimit 1048576") {
		t.Fatalf("the in-memory cap was not applied:\n%s", stream)
	}

	cfg.BodyLimitKB = 1024 * 1024 // 1 GiB, above the cap
	if got := normalizeWAFConfig(cfg).BodyLimitKB; got != 256*1024 {
		t.Fatalf("the limit was clamped to %d KB, want %d", got, 256*1024)
	}
}
