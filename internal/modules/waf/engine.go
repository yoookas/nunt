package waf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/corazawaf/coraza/v3"
	"github.com/corazawaf/coraza/v3/experimental"
	"github.com/corazawaf/coraza/v3/types"

	"github.com/nunt/nunt/internal/model"
)

// engine is one compiled Coraza instance together with the metadata shown in
// the UI. Engines are immutable: a configuration change builds a new one and
// the module swaps the pointer.
type engine struct {
	waf    coraza.WAF
	cfg    model.WAFConfig
	detail string
	rules  int
	files  int
	// crsFallback is true when the built-in rule set failed to load and the
	// engine fell back to the custom rules only.
	crsFallback bool
	builtAt     time.Time
}

// close releases the memoized patterns owned by the engine. Transactions that
// are already running keep their own references and are not affected.
func (e *engine) close() error {
	if e == nil || e.waf == nil {
		return nil
	}
	if c, ok := e.waf.(experimental.WAFCloser); ok {
		return c.Close()
	}
	return nil
}

// directiveBuilder renders the SecLang stream handed to Coraza.
type directiveBuilder struct {
	prelude   []string
	include   []string
	remove    []string
	overrides []string
}

func (b *directiveBuilder) String() string {
	var sb strings.Builder
	write := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		sb.WriteString("# ")
		sb.WriteString(title)
		sb.WriteString("\n")
		for _, l := range lines {
			sb.WriteString(l)
			sb.WriteString("\n")
		}
	}
	// Order matters: the prelude must be parsed first so its variables are set
	// before the rule set guards run, and the scalar settings must be parsed
	// last so they win over the values shipped inside the bundled
	// coraza.conf-recommended file.
	write("nunt: rule engine prelude", b.prelude)
	write("nunt: bundled rule set", b.include)
	write("nunt: engine settings", b.overrides)
	return sb.String()
}

// maxBodyLimitKB caps the inspected request body. Coraza itself allows up to
// 1 GiB; buffering that much per request would be a memory hazard.
const maxBodyLimitKB = 10 * 1024

// normalizeWAFConfig repairs the configuration values the engine relies on.
func normalizeWAFConfig(cfg model.WAFConfig) model.WAFConfig {
	if cfg.Mode != model.WAFModeDetect {
		cfg.Mode = model.WAFModeBlock
	}
	if cfg.ParanoiaLevel < 1 || cfg.ParanoiaLevel > 4 {
		cfg.ParanoiaLevel = 1
	}
	if cfg.ExecutingLevel < cfg.ParanoiaLevel || cfg.ExecutingLevel > 4 {
		cfg.ExecutingLevel = cfg.ParanoiaLevel
	}
	if cfg.InboundThreshold <= 0 {
		cfg.InboundThreshold = 5
	}
	if cfg.OutboundThreshold <= 0 {
		cfg.OutboundThreshold = 4
	}
	if cfg.BodyLimitKB <= 0 {
		cfg.BodyLimitKB = 128
	}
	if cfg.BodyLimitKB > maxBodyLimitKB {
		cfg.BodyLimitKB = maxBodyLimitKB
	}
	return cfg
}

// validDisabledRule accepts a rule id or an inclusive id range. Anything else
// is rejected so user input can never become a SecLang directive.
func validDisabledRule(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 24 {
		return false
	}
	parts := strings.Split(v, "-")
	if len(parts) > 2 {
		return false
	}
	for _, p := range parts {
		if p == "" || len(p) > 9 {
			return false
		}
		for i := 0; i < len(p); i++ {
			if p[i] < '0' || p[i] > '9' {
				return false
			}
		}
	}
	return true
}

// validateEngineConfig rejects configurations that would produce an unsafe
// directive stream. It is called both by the API and by the builder.
func validateEngineConfig(cfg model.WAFConfig) error {
	for _, id := range cfg.DisabledRules {
		if !validDisabledRule(id) {
			return fmt.Errorf("disabled rule %q is not a rule id or an id range", id)
		}
	}
	for _, f := range cfg.RuleFiles {
		if strings.TrimSpace(f) == "" {
			return errors.New("rule file path must not be empty")
		}
		if strings.ContainsRune(f, 0) {
			return errors.New("rule file path must not contain a NUL byte")
		}
		if !strings.EqualFold(fileExt(f), ".conf") {
			return fmt.Errorf("rule file %q must use the .conf extension", f)
		}
	}
	return nil
}

func fileExt(p string) string {
	i := strings.LastIndexByte(p, '.')
	if i < 0 {
		return ""
	}
	return p[i:]
}

// buildEngine compiles the rule set described by cfg. When the bundled rule set
// cannot be used the engine falls back to the custom rules and the second
// result stays nil only for real errors.
func buildEngine(cfg model.WAFConfig, log *slog.Logger) (*engine, error) {
	cfg = normalizeWAFConfig(cfg)
	if err := validateEngineConfig(cfg); err != nil {
		return nil, err
	}

	var (
		catalog []ruleFile
		version string
	)
	if cfg.UseCRS {
		files, v, err := builtinRuleFiles()
		if err != nil {
			// A broken embedded rule set must not take the service down: the
			// engine keeps running with the custom rules only.
			if log != nil {
				log.Warn("waf: cannot load the bundled rule set, falling back to custom rules", "error", err)
			}
			catalog, version = nil, ""
		} else {
			catalog, version = files, v
		}
	}

	diskFiles := make([]string, 0, len(cfg.RuleFiles))
	for _, f := range cfg.RuleFiles {
		if err := ruleFileExists(f); err != nil {
			if log != nil {
				log.Warn("waf: skipping rule file", "file", f, "error", err)
			}
			continue
		}
		diskFiles = append(diskFiles, f)
	}

	e, err := compile(cfg, catalog, diskFiles, log)
	if err != nil && len(catalog) > 0 {
		// A rule that fails to parse must not disable the whole engine: retry
		// with the custom rules only and report the bundled failure.
		if log != nil {
			log.Warn("waf: bundled rule set failed to compile, retrying with custom rules only", "error", err)
		}
		fallback, ferr := compile(cfg, nil, diskFiles, log)
		if ferr != nil {
			return nil, fmt.Errorf("compiling the rule set: %w (and without the bundled set: %v)", err, ferr)
		}
		fallback.crsFallback = true
		fallback.detail = engineDetail(cfg, fallback, nil, "", len(diskFiles))
		fallback.files = len(diskFiles)
		fallback.builtAt = time.Now()
		return fallback, nil
	}
	if err != nil {
		return nil, err
	}
	e.builtAt = time.Now()
	e.detail = engineDetail(cfg, e, catalog, version, len(diskFiles))
	e.files = len(catalog) + len(diskFiles)
	return e, nil
}

func engineDetail(cfg model.WAFConfig, e *engine, catalog []ruleFile, version string, disk int) string {
	parts := make([]string, 0, 6)
	switch {
	case e.crsFallback:
		parts = append(parts, "custom rules only (bundled set failed)")
	case len(catalog) > 0:
		if version == "" {
			version = "4.x"
		}
		parts = append(parts, fmt.Sprintf("CRS %s", version))
	}
	parts = append(parts, fmt.Sprintf("PL%d", cfg.ParanoiaLevel))
	if cfg.ExecutingLevel != cfg.ParanoiaLevel {
		parts = append(parts, fmt.Sprintf("exec PL%d", cfg.ExecutingLevel))
	}
	if cfg.Mode == model.WAFModeDetect {
		parts = append(parts, "detection only")
	}
	if cfg.LogOnly {
		parts = append(parts, "log only")
	}
	if total := len(catalog) + disk; total > 0 {
		parts = append(parts, fmt.Sprintf("%d rule files", total))
	}
	parts = append(parts, fmt.Sprintf("%d rules", e.rules))
	return strings.Join(parts, ", ")
}

// renderDirectives builds the SecLang stream for cfg and the given rule files.
//
// Order matters: the prelude must be parsed first so its variables are set
// before the rule set guards run, and the scalar settings must be parsed after
// the includes so they win over the values shipped inside the bundled
// coraza.conf-recommended file (which selects DetectionOnly).
func renderDirectives(cfg model.WAFConfig, catalog []ruleFile) *directiveBuilder {
	b := &directiveBuilder{}
	engineMode := "On"
	if cfg.Mode == model.WAFModeDetect {
		engineMode = "DetectionOnly"
	}

	// The prelude sets the CRS tuning variables before the bundled rules are
	// parsed: the CRS defaults only apply to unset variables and the paranoia
	// level guards are evaluated while the rules run.
	b.prelude = []string{
		fmt.Sprintf("SecAction \"id:1000001,phase:1,pass,nolog,t:none,setvar:'tx.blocking_paranoia_level=%d'\"", cfg.ParanoiaLevel),
		fmt.Sprintf("SecAction \"id:1000002,phase:1,pass,nolog,t:none,setvar:'tx.detection_paranoia_level=%d'\"", cfg.ExecutingLevel),
		fmt.Sprintf("SecAction \"id:1000003,phase:1,pass,nolog,t:none,setvar:'tx.paranoia_level=%d'\"", cfg.ParanoiaLevel),
		fmt.Sprintf("SecAction \"id:1000004,phase:1,pass,nolog,t:none,setvar:'tx.executing_paranoia_level=%d'\"", cfg.ExecutingLevel),
		fmt.Sprintf("SecAction \"id:1000005,phase:1,pass,nolog,t:none,setvar:'tx.inbound_anomaly_score_threshold=%d'\"", cfg.InboundThreshold),
		fmt.Sprintf("SecAction \"id:1000006,phase:1,pass,nolog,t:none,setvar:'tx.outbound_anomaly_score_threshold=%d'\"", cfg.OutboundThreshold),
	}

	// Scalar settings are applied after the includes: coraza.conf-recommended
	// ships SecRuleEngine DetectionOnly and a 12 MiB body limit that must not
	// override the administrator configuration.
	bodyLimit := cfg.BodyLimitKB * 1024
	b.overrides = []string{
		fmt.Sprintf("SecRuleEngine %s", engineMode),
		"SecRequestBodyAccess On",
		fmt.Sprintf("SecRequestBodyLimit %d", bodyLimit),
		fmt.Sprintf("SecRequestBodyInMemoryLimit %d", bodyLimit),
		// ProcessPartial inspects the first BodyLimitKB bytes of a large upload
		// instead of rejecting it, which keeps file transfers working.
		"SecRequestBodyLimitAction ProcessPartial",
		// Response bodies are streamed through the proxy untouched.
		"SecResponseBodyAccess Off",
		// Events live in the module ring buffer, not in a Coraza audit file.
		"SecAuditEngine Off",
	}

	// Every bundled file is always included: CRS files cross reference each
	// other by rule id (SecRuleUpdateTargetById), so a missing file breaks the
	// whole set. Disabling a file removes its rule id range afterwards.
	for _, f := range catalog {
		b.include = append(b.include, "Include "+f.File)
	}
	for _, id := range cfg.DisabledRules {
		b.remove = append(b.remove, "SecRuleRemoveById "+strings.TrimSpace(id))
	}
	return b
}

// compile renders the directives and builds one Coraza instance.
func compile(cfg model.WAFConfig, catalog []ruleFile, diskFiles []string, log *slog.Logger) (*engine, error) {
	// Installed before the first engine so every rule uses the fixed path
	// transformations. It is a no-op outside Windows.
	installPathTransforms()

	bodyLimit := cfg.BodyLimitKB * 1024
	b := renderDirectives(cfg, catalog)

	wafCfg := coraza.NewWAFConfig().
		WithRootFS(rulesFS{}).
		WithRequestBodyAccess().
		WithRequestBodyLimit(bodyLimit).
		WithRequestBodyInMemoryLimit(bodyLimit).
		WithDirectives(b.String())
	for _, f := range diskFiles {
		wafCfg = wafCfg.WithDirectivesFromFile(f)
	}
	if strings.TrimSpace(cfg.ExtraRules) != "" {
		wafCfg = wafCfg.WithDirectives(cfg.ExtraRules)
	}
	if len(b.remove) > 0 {
		wafCfg = wafCfg.WithDirectives(strings.Join(b.remove, "\n"))
	}

	inst, err := coraza.NewWAF(wafCfg)
	if err != nil {
		return nil, fmt.Errorf("building the coraza engine: %w", err)
	}
	e := &engine{waf: inst, cfg: cfg}
	if r, ok := inst.(experimental.WAFWithRules); ok {
		e.rules = r.RulesCount()
	}
	if log != nil {
		log.Debug("waf: engine compiled", "rules", e.rules, "files", len(catalog)+len(diskFiles), "mode", cfg.Mode)
	}
	return e, nil
}

// disabledByRange reports whether a whole rule file is switched off through a
// rule id range in DisabledRules.
func disabledByRange(disabled []string, f ruleFile) bool {
	lo, hi := f.idRange()
	if lo == 0 || hi == 0 {
		return false
	}
	for _, d := range disabled {
		parts := strings.Split(strings.TrimSpace(d), "-")
		if len(parts) != 2 {
			continue
		}
		start, err1 := atoi(parts[0])
		end, err2 := atoi(parts[1])
		if err1 != nil || err2 != nil {
			continue
		}
		if start <= lo && end >= hi {
			return true
		}
	}
	return false
}

func atoi(s string) (int, error) {
	if s == "" {
		return 0, errors.New("empty number")
	}
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("invalid number %q", s)
		}
		// Guard against overflow on every platform (int is 32 bit on
		// armv7 and 386).
		if n > (math.MaxInt32-9)/10 {
			return 0, fmt.Errorf("number %q is too large", s)
		}
		n = n*10 + int(s[i]-'0')
	}
	return n, nil
}

// requestMeta describes one HTTP request handed to the engine.
type requestMeta struct {
	ClientIP         string
	ClientPort       int
	Method           string
	URI              string
	Proto            string
	Host             string
	Headers          http.Header
	TransferEncoding []string
	Body             io.Reader
	// Restore receives the body that has to be given back to the downstream
	// handler after Coraza buffered it.
	Restore func(io.Reader)
	// Serve runs the downstream handler. It is called between the request
	// phases and the transaction cleanup, so the buffered body handed back
	// through Restore is still readable while the handler runs.
	Serve func()
	// Block answers a blocked request. When it is nil the request continues.
	Block func(outcome)
}

// ruleHit is one rule that matched a transaction.
type ruleHit struct {
	ID       int      `json:"id"`
	Message  string   `json:"message,omitempty"`
	Data     string   `json:"data,omitempty"`
	Severity string   `json:"severity,omitempty"`
	Phase    int      `json:"phase,omitempty"`
	File     string   `json:"file,omitempty"`
	Line     int      `json:"line,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Log      bool     `json:"log"`
}

// outcome summarises what the engine decided for one request.
type outcome struct {
	Interrupted bool
	// Blocked is true when the rule set asked for the request to be denied,
	// regardless of the engine mode.
	Blocked bool
	Status  int
	Action  string
	// Data carries the redirect target of a "redirect" rule action.
	Data    string
	RuleID  int
	Message string
	TxID    string
	Matched []ruleHit
}

// maxMatched caps the number of rule hits carried around per transaction.
const maxMatched = 50

// loggable reports whether Coraza considers a matched rule worth logging. Rules
// marked with "nolog" (most CRS bookkeeping rules) are filtered out.
func loggable(mr types.MatchedRule) bool {
	if l, ok := mr.(interface{ Log() bool }); ok {
		return l.Log()
	}
	return true
}

// detectionOnlyTx exposes the interruption a detection only transaction would
// have produced. The methods belong to the concrete Coraza transaction; they
// are reached through a local interface so losing them only degrades the
// detection reporting.
type detectionOnlyTx interface {
	IsDetectionOnlyInterrupted() bool
	DetectionOnlyInterruption() *types.Interruption
}

// newTransaction creates a transaction bound to the request context.
func (e *engine) newTransaction(ctx context.Context) types.Transaction {
	if ctx == nil {
		ctx = context.Background()
	}
	if w, ok := e.waf.(experimental.WAFWithOptions); ok {
		return w.NewTransactionWithOptions(experimental.Options{Context: ctx})
	}
	return e.waf.NewTransaction()
}

// process runs one request through the engine and reports what happened. The
// error return is informational: the caller keeps serving the request unless
// the outcome says otherwise.
func (e *engine) process(ctx context.Context, meta *requestMeta) (out outcome, err error) {
	if e == nil || e.waf == nil {
		return out, errors.New("the waf engine is not available")
	}
	tx := e.newTransaction(ctx)
	if tx == nil {
		return out, errors.New("cannot create a waf transaction")
	}
	defer func() {
		tx.ProcessLogging()
		if cerr := tx.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("closing the waf transaction: %w", cerr)
		}
	}()
	out.TxID = tx.ID()

	tx.ProcessConnection(meta.ClientIP, meta.ClientPort, "", 0)
	tx.ProcessURI(meta.URI, meta.Method, meta.Proto)
	if host := hostOnly(meta.Host); host != "" {
		tx.SetServerName(host)
	}
	for k, values := range meta.Headers {
		for _, v := range values {
			tx.AddRequestHeader(k, v)
		}
	}
	if meta.Host != "" {
		tx.AddRequestHeader("Host", meta.Host)
	}
	// Go removes Transfer-Encoding from the header map; without it the request
	// smuggling rules cannot see it.
	for _, te := range meta.TransferEncoding {
		tx.AddRequestHeader("Transfer-Encoding", te)
	}

	it := tx.ProcessRequestHeaders()
	if tx.IsRequestBodyAccessible() && meta.Body != nil {
		bodyIt, _, rerr := tx.ReadRequestBodyFrom(meta.Body)
		if rerr != nil {
			return out, fmt.Errorf("reading the request body: %w", rerr)
		}
		if it == nil {
			it = bodyIt
		}
		if meta.Restore != nil {
			// Hand the buffered bytes back to the downstream handler. When the
			// body was truncated at the limit the reader keeps the remainder.
			if rbr, berr := tx.RequestBodyReader(); berr == nil {
				meta.Restore(io.MultiReader(rbr, meta.Body))
			} else {
				meta.Restore(meta.Body)
			}
		}
	}
	if it == nil {
		bodyIt, perr := tx.ProcessRequestBody()
		if perr != nil {
			return out, fmt.Errorf("processing the request body: %w", perr)
		}
		it = bodyIt
	}

	if it != nil {
		out.Interrupted = true
		out.Blocked = true
		out.Action = it.Action
		out.Status = it.Status
		out.Data = it.Data
		out.RuleID = it.RuleID
	} else if d, ok := tx.(detectionOnlyTx); ok && d.IsDetectionOnlyInterrupted() {
		if dit := d.DetectionOnlyInterruption(); dit != nil {
			out.Blocked = true
			out.Action = dit.Action
			out.Status = dit.Status
			out.Data = dit.Data
			out.RuleID = dit.RuleID
		}
	}
	if out.Blocked && out.Status == 0 {
		out.Status = http.StatusForbidden
	}
	out.Matched = collectMatched(tx, out.RuleID)
	for _, hit := range out.Matched {
		if hit.ID == out.RuleID && out.Message == "" {
			out.Message = hit.Message
		}
	}

	// The downstream handler runs before the deferred cleanup, exactly like the
	// generic coraza/v3/http wrapper does, so the request body stays readable.
	if out.Blocked && e.enforces() {
		if meta.Block != nil {
			meta.Block(out)
		}
	} else if meta.Serve != nil {
		meta.Serve()
	}
	return out, nil
}

// enforces reports whether an interruption may reach the client. In detect mode
// Coraza never interrupts, and in log only mode the interruption is recorded
// but not applied.
func (e *engine) enforces() bool {
	return e.cfg.Mode == model.WAFModeBlock && !e.cfg.LogOnly
}

// collectMatched converts the log relevant matches of a transaction, with the
// interrupting rule always included.
func collectMatched(tx types.Transaction, interruptID int) []ruleHit {
	matched := tx.MatchedRules()
	out := make([]ruleHit, 0, len(matched))
	seen := make(map[int]bool, len(matched))
	for _, mr := range matched {
		meta := mr.Rule()
		if meta == nil {
			continue
		}
		id := meta.ID()
		lg := loggable(mr)
		if !lg && id != interruptID {
			continue
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, ruleHit{
			ID:       id,
			Message:  mr.Message(),
			Data:     mr.Data(),
			Severity: meta.Severity().String(),
			Phase:    int(meta.Phase()),
			File:     meta.File(),
			Line:     meta.Line(),
			Tags:     meta.Tags(),
			Log:      lg,
		})
		if len(out) >= maxMatched {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
