// Package waf wraps the Coraza engine used to protect the web service.
//
// The module compiles the OWASP Core Rule Set (embedded in the binary) together
// with the administrator rules, exposes a http middleware for the web service
// and keeps a rolling buffer of the interceptions shown in the admin UI.
package waf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
	"github.com/nunt/nunt/internal/netutil"
)

// WAF is the web application firewall module.
type WAF struct {
	module.Base
	deps *module.Deps
	log  *slog.Logger

	rec *recorder
	// body keeps the request body policy counters and the "would reject"
	// ring buffer.
	body *bodyRecorder

	mu     sync.RWMutex
	cfg    model.WAFConfig
	engine *engine
	// policies maps a web rule name to the body policy it declared. It is
	// rebuilt by Reload, never mutated in place.
	policies map[string]string
	// inspector judges one request body message. It stays nil until a per
	// message inspector (D) is installed, in which case the engine is used.
	inspector  BodyInspector
	buildErr   error
	trustProxy bool
	started    bool
	wake       chan struct{}
	done       chan struct{}
	wg         sync.WaitGroup

	catalogOnce sync.Once
	catalog     []ruleFile
	crsVersion  string
	catalogErr  error
}

// New creates the module.
func New(deps *module.Deps) *WAF {
	w := &WAF{
		deps: deps,
		log:  deps.Logger("waf"),
		rec:  newRecorder(defaultEventKeep),
		body: newBodyRecorder(),
	}
	w.Init(deps, "waf", "Web 应用防火墙")
	if deps != nil && deps.Cfg != nil {
		snap := deps.Cfg.Snapshot()
		w.cfg = normalizeWAFConfig(snap.WAF)
		w.policies = rulePolicies(snap)
		w.trustProxy = snap.System.TrustProxy
	}
	return w
}

// Start compiles the rule set and launches the background rebuilder. A rule set
// that cannot be compiled leaves the module running in pass-through mode, so a
// broken configuration never takes the service down.
func (w *WAF) Start(ctx context.Context) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		return nil
	}
	w.started = true
	w.wake = make(chan struct{}, 1)
	w.done = make(chan struct{})
	cfg := w.cfg
	w.mu.Unlock()

	if err := w.rebuild(cfg, true); err != nil && w.log != nil {
		w.log.Error("waf: the rule set cannot be compiled, traffic is not inspected", "error", err)
	}
	w.wg.Add(1)
	go w.worker()
	w.SetRunning(true)
	return nil
}

// Stop releases the engine and waits for the background rebuilder.
func (w *WAF) Stop(context.Context) error {
	w.mu.Lock()
	if !w.started {
		w.mu.Unlock()
		w.SetRunning(false)
		return nil
	}
	w.started = false
	done := w.done
	eng := w.engine
	w.engine = nil
	w.buildErr = nil
	w.done, w.wake = nil, nil
	w.mu.Unlock()

	if done != nil {
		close(done)
	}
	w.wg.Wait()
	if eng != nil {
		if err := eng.close(); err != nil && w.log != nil {
			w.log.Warn("waf: closing the engine", "error", err)
		}
	}
	w.SetRunning(false)
	w.SetDetail("stopped")
	return nil
}

// Reload schedules a rebuild when the firewall configuration changed. It never
// blocks the caller: the engine is replaced by the background worker.
func (w *WAF) Reload(cfg *model.Config) {
	if w == nil || cfg == nil {
		return
	}
	next := normalizeWAFConfig(cfg.WAF)
	policies := rulePolicies(cfg)
	w.mu.Lock()
	same := sameWAFConfig(w.cfg, next)
	w.cfg = next
	w.policies = policies
	w.trustProxy = cfg.System.TrustProxy
	started, wake := w.started, w.wake
	w.mu.Unlock()
	if same || !started || wake == nil {
		return
	}
	select {
	case wake <- struct{}{}:
	default: // a rebuild is already queued
	}
}

// worker rebuilds the engine whenever Reload asks for it.
func (w *WAF) worker() {
	defer w.wg.Done()
	for {
		w.mu.RLock()
		wake, done := w.wake, w.done
		w.mu.RUnlock()
		if wake == nil || done == nil {
			return
		}
		select {
		case <-done:
			return
		case <-wake:
			w.mu.RLock()
			cfg := w.cfg
			w.mu.RUnlock()
			if err := w.rebuild(cfg, false); err != nil && w.log != nil {
				w.log.Error("waf: the rule set cannot be compiled, keeping the previous engine", "error", err)
			}
		}
	}
}

// rebuild compiles cfg and swaps the engine. The previous engine is kept when
// the new configuration cannot be compiled, so a bad reload cannot disable the
// protection that is already in place.
func (w *WAF) rebuild(cfg model.WAFConfig, force bool) error {
	cfg = normalizeWAFConfig(cfg)

	w.mu.RLock()
	current := w.engine
	w.mu.RUnlock()
	if current != nil && !force && cfg.Enable && sameWAFConfig(current.cfg, cfg) {
		return nil
	}

	if !cfg.Enable {
		w.mu.Lock()
		old := w.engine
		w.engine = nil
		w.cfg = cfg
		w.buildErr = nil
		w.mu.Unlock()
		if old != nil {
			_ = old.close()
		}
		w.SetError(nil)
		w.SetDetail("disabled")
		return nil
	}

	eng, err := buildEngine(cfg, w.log)
	if err != nil {
		w.mu.Lock()
		w.cfg = cfg
		w.buildErr = err
		w.mu.Unlock()
		w.SetError(err)
		w.SetDetail("engine disabled: " + err.Error())
		return err
	}

	w.mu.Lock()
	old := w.engine
	w.engine = eng
	w.cfg = eng.cfg
	w.buildErr = nil
	w.mu.Unlock()
	if old != nil {
		_ = old.close()
	}
	w.SetError(nil)
	w.SetDetail(eng.detail)
	if w.log != nil {
		w.log.Info("waf: engine ready", "detail", eng.detail, "mode", eng.cfg.Mode, "logOnly", eng.cfg.LogOnly)
	}
	return nil
}

// sameWAFConfig compares two normalized configurations.
func sameWAFConfig(a, b model.WAFConfig) bool {
	a = normalizeWAFConfig(a)
	b = normalizeWAFConfig(b)
	return reflect.DeepEqual(a, b)
}

// requestState is the immutable snapshot the request path needs.
type requestState struct {
	engine     *engine
	cfg        model.WAFConfig
	trustProxy bool
	policies   map[string]string
}

func (w *WAF) state() requestState {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return requestState{engine: w.engine, cfg: w.cfg, trustProxy: w.trustProxy, policies: w.policies}
}

// policy returns the body policy the web rule declared; an unknown rule
// inherits the global default.
func (st requestState) policy(rule string) string {
	if st.policies == nil {
		return ""
	}
	return st.policies[rule]
}

// peekTimeout is the budget a peek or a first message read may take.
func (st requestState) peekTimeout() time.Duration {
	ms := st.cfg.PeekTimeoutMS
	if ms <= 0 {
		ms = defaultPeekTimeoutMS
	}
	return time.Duration(ms) * time.Millisecond
}

// peekLimit is the number of bytes a peek policy reads.
func (st requestState) peekLimit() int {
	if st.cfg.PeekBytes <= 0 {
		return defaultPeekBytes
	}
	return st.cfg.PeekBytes
}

// enforcesBody reports whether the body policy refusals reach the client.
func (st requestState) enforcesBody() bool {
	return st.cfg.EnforcementMode == model.WAFEnforceEnforce
}

// Enabled reports whether the engine inspects traffic.
func (w *WAF) Enabled() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.engine != nil && w.cfg.Enable
}

// AdminProtect reports whether the admin interface should be filtered as well.
func (w *WAF) AdminProtect() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.cfg.Enable && w.cfg.AdminProtect && w.engine != nil
}

// Middleware wraps a handler; when the WAF is disabled it returns next.
//
// The request phases (connection, URI, headers, body) are driven by hand
// instead of using the generic coraza/v3/http wrapper because the module needs
// its own block page, its own event log and a log-only mode in which the
// interruption is reported but not enforced.
func (w *WAF) Middleware(ruleName string, next http.Handler) http.Handler {
	if next == nil {
		next = http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			http.NotFound(rw, r)
		})
	}
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		st := w.state()
		if st.engine == nil {
			next.ServeHTTP(rw, r)
			return
		}
		w.rec.requests.Add(1)
		handled, err := w.inspect(st, ruleName, rw, r, next)
		if err != nil {
			w.rec.errors.Add(1)
			if w.log != nil {
				w.log.Warn("waf: the request could not be inspected", "rule", ruleName, "error", err)
			}
		}
		if handled {
			return
		}
		next.ServeHTTP(rw, r)
	})
}

// flow tracks whether the response of a request was already produced while the
// request is still being inspected. The panic guard needs it to tell an engine
// panic (reported as an error, the request is served anyway) from a downstream
// panic (passed on untouched).
type flow struct {
	served     bool
	inspection bool
}

// inspect runs one request through the engine. It reports whether the response
// has already been produced, either because the request was blocked or because
// the downstream handler ran inside the transaction lifetime. A panic raised
// while inspecting is converted into an error so the request is served anyway;
// a panic raised by the downstream handler is passed on untouched.
func (w *WAF) inspect(st requestState, ruleName string, rw http.ResponseWriter, r *http.Request, next http.Handler) (handled bool, err error) {
	f := &flow{inspection: true}
	defer func() {
		if rec := recover(); rec != nil {
			if !f.inspection {
				panic(rec)
			}
			handled = f.served
			err = fmt.Errorf("panic while inspecting the request: %v", rec)
		}
	}()

	clientIP := netutil.ClientIP(r, st.trustProxy)
	remoteHost, port := splitHostPort(r.RemoteAddr)
	if clientIP == nil {
		clientIP = net.ParseIP(remoteHost)
	}
	ip := remoteHost
	if clientIP != nil {
		ip = clientIP.String()
	}
	meta := &requestMeta{
		ClientIP:         ip,
		ClientPort:       port,
		Method:           r.Method,
		URI:              requestURI(r),
		Proto:            r.Proto,
		Host:             r.Host,
		Headers:          r.Header,
		TransferEncoding: r.TransferEncoding,
		Body:             r.Body,
		Restore: func(body io.Reader) {
			r.Body = io.NopCloser(body)
		},
		Serve: func() {
			f.served = true
			f.inspection = false
			next.ServeHTTP(rw, r)
		},
		Block: func(blocked outcome) {
			f.served = true
			f.inspection = false
			w.writeBlocked(rw, blocked)
		},
	}
	if r.Body == nil || r.Body == http.NoBody {
		meta.Body = nil
	}

	// The request body decision is taken once, before anything is read.
	policy := resolveBodyPolicy(st.policy(ruleName), st.cfg.DefaultBodyPolicy, grpcContentType(r))
	switch policy {
	case policyGRPCUnary, policyGRPCStream:
		if meta.Body != nil {
			return w.inspectGRPC(st, ruleName, rw, r, next, meta, ip, policy, f)
		}
		// A gRPC request without a body carries no message: the request is
		// complete, and only the request line and the headers are inspected.
		w.body.grpcRequests.Add(1)
		w.body.grpcUnary.Add(1)
		w.body.note(stateGRPCUnary)
	case policySkip:
		// Row 1: only the request line and the headers are inspected, the body
		// is forwarded untouched.
		meta.Body = nil
		w.body.note(stateSkipped)
	case policyPeek:
		// Row 2: the first PeekBytes are inspected, the rest is streamed.
		w.applyPeek(st, r, meta)
	default:
		// Rows 4 and 5.
		if !w.applyFull(st, ruleName, rw, r, meta, ip, f) {
			return f.served, nil
		}
	}

	out, perr := st.engine.process(r.Context(), meta)
	f.inspection = false

	// The enforcement decision mirrors the one taken inside the engine so the
	// counters always describe what actually happened.
	enforce := st.engine.enforces()
	action := "detect"
	switch {
	case out.Blocked && enforce:
		action = "deny"
		w.rec.blocked.Add(1)
	case out.Blocked:
		w.rec.detected.Add(1)
	default:
		w.rec.passed.Add(1)
	}
	if out.Blocked {
		w.record(out, ruleName, r, ip, action)
	}
	return f.served, perr
}

// Fallbacks used when a configuration reaches the request path without having
// been normalised first.
const (
	defaultPeekBytes     = 65536
	defaultPeekTimeoutMS = 250
)

// messageBlocked is the gRPC status message of a refused message.
const messageBlocked = "该请求被 Web 应用防火墙拦截"

// applyPeek implements the peek policy: the first PeekBytes of the body are
// inspected, everything after them is streamed to the downstream untouched.
// The peek stops when the limit is reached or when the client went idle for
// the configured timeout, so the request is never held open by a body that
// keeps trickling in.
func (w *WAF) applyPeek(st requestState, r *http.Request, meta *requestMeta) {
	prefix, rest, _ := peekBody(r.Body, st.peekLimit(), time.Now().Add(st.peekTimeout()))
	meta.Body = bytes.NewReader(prefix)
	// The engine only gets the peeked prefix; the downstream must see the whole
	// body, so the restore ignores the reader the engine hands back.
	meta.Restore = func(io.Reader) {
		r.Body = bodyReader(prefix, rest)
	}
	w.body.note(statePeeked)
}

// applyFull implements the full policy. The number of bytes still to read is
// known when the body declares its length, so the inspection cannot be
// extended by the client. A body without a declared length is the only shape
// an attacker can choose, and it is refused: the request is answered with 411
// in enforce mode and recorded in observe mode, where it is inspected as far
// as it can be. It reports whether the request may continue.
func (w *WAF) applyFull(st requestState, ruleName string, rw http.ResponseWriter, r *http.Request, meta *requestMeta, ip string, f *flow) bool {
	if r.ContentLength >= 0 || meta.Body == nil {
		w.body.note(stateFull)
		return true
	}
	rej := rejection{
		Status:   http.StatusLengthRequired,
		GRPCCode: grpcStatusResourceExhausted,
		Message:  messageLengthRequired,
		Reason:   reasonLengthUnknown,
		Rule:     ruleName,
	}
	enforced := st.enforcesBody()
	w.noteViolation(ruleName, r, ip, rej, policyFull, statePeeked, enforced)
	if enforced {
		f.served = true
		f.inspection = false
		w.writeRejection(rw, r, rej)
		return false
	}
	w.applyPeek(st, r, meta)
	return true
}

// inspectGRPC applies the gRPC rows of the decision table. The first message is
// read, and judged, before the upstream is contacted, so a violation is
// answered by the middleware itself and the upstream never sees the request.
// The message and a scanner that validates every following frame are then
// handed to the downstream, which only has to stream them.
func (w *WAF) inspectGRPC(st requestState, ruleName string, rw http.ResponseWriter, r *http.Request, next http.Handler, meta *requestMeta, ip string, policy bodyPolicy, f *flow) (bool, error) {
	w.body.grpcRequests.Add(1)
	stream := policy == policyGRPCStream
	enforce := st.enforcesBody()
	// A gRPC body is only ever read with a deadline, and the failure of a frame
	// travels to the proxy error handler through the request: a transport may
	// replace the sentinel error on its way back.
	r, slot := withFailureSlot(r)

	src := newTimedReader(r.Body, pullChunk)
	sc := newGRPCScanner(src, !stream)
	sc.fail = func(fail BodyFailure) {
		slot.set(fail)
		if errors.Is(fail.Kind, ErrUnexpectedMessage) {
			w.body.grpcSecondMsg.Add(1)
			return
		}
		w.body.grpcFrameErrors.Add(1)
	}
	if !enforce {
		// Observe mode: a route declared unary that turns out to be streaming is
		// reported instead of refused.
		sc.observe = func(fail BodyFailure) {
			w.body.grpcSecondMsg.Add(1)
			w.noteViolation(ruleName, r, ip, rejection{
				Status:   fail.Status,
				GRPCCode: fail.GRPCCode,
				Message:  fail.Message,
				Reason:   reasonSecondMessage,
				Rule:     ruleName,
			}, policy, stateGRPCStream, false)
		}
	}
	var verdict Verdict
	sc.sink = func(msg []byte, index int) error {
		w.body.grpcMessages.Add(1)
		v, err := w.inspectMessage(r.Context(), st, ruleName, meta, msg, index)
		if err != nil {
			// An inspector that fails must not break the request; the engine
			// failing is already reported by the module status.
			return nil
		}
		if index == 0 {
			verdict = v
		}
		return nil
	}

	deadline := time.Now().Add(st.peekTimeout())
	msg, err := sc.first(deadline, grpcEncoding(r))
	switch {
	case err == nil:
	case errors.Is(err, errPeekTimeout):
		// The client is waiting for the server to speak first. The request is
		// forwarded right away: nothing can be inspected yet, and everything
		// that was read stays in the scanner.
		w.body.grpcServerFirst.Add(1)
		w.body.note(stateGRPCServerFirst)
		return w.forwardBody(rw, r, next, sc, f), nil
	case errors.Is(err, io.EOF):
		// An empty body: the request is complete and carries no message.
		w.body.grpcUnary.Add(1)
		w.body.note(stateGRPCUnary)
		return w.forwardBody(rw, r, next, sc, f), nil
	default:
		// A frame the scanner refuses. The frame layer is always enforced: a
		// malformed or oversized frame is a protocol error, not a policy choice,
		// and forwarding it would only move the failure to the upstream.
		fail := failureFor(err)
		w.body.note(stateFrameError)
		w.noteViolation(ruleName, r, ip, rejection{
			Status:   fail.Status,
			GRPCCode: fail.GRPCCode,
			Message:  fail.Message,
			Reason:   reasonFrameError,
			Rule:     ruleName,
		}, policy, stateFrameError, true)
		f.served = true
		f.inspection = false
		w.writeRejection(rw, r, rejection{Status: fail.Status, GRPCCode: fail.GRPCCode, Message: fail.Message, Rule: ruleName})
		return true, nil
	}

	if msg != nil && msg.compressed {
		w.body.grpcCompressed.Add(1)
	}
	if msg != nil && !msg.decoded {
		// The first message cannot be decoded, so it cannot be inspected. That
		// is a gap the client chose, so it is refused (or recorded).
		rej := rejection{
			Status:   http.StatusForbidden,
			GRPCCode: grpcStatusPermissionDenied,
			Message:  messageUnsupportedEncoding,
			Reason:   reasonEncoding,
			Rule:     ruleName,
		}
		w.noteViolation(ruleName, r, ip, rej, policy, stateGRPCUnary, enforce)
		if enforce {
			f.served = true
			f.inspection = false
			w.writeRejection(rw, r, rej)
			return true, nil
		}
	}

	// EOF right after the first message means the whole request body was read:
	// the verdict below is a request level one. Otherwise the message is only
	// the beginning of a stream.
	complete := sc.complete(deadline)
	if complete {
		w.body.grpcUnary.Add(1)
		w.body.note(stateGRPCUnary)
	} else {
		w.body.grpcStream.Add(1)
		w.body.note(stateGRPCStream)
	}
	if verdict.Blocked {
		action := "detect"
		if st.engine.enforces() {
			action = "deny"
			w.rec.blocked.Add(1)
		} else {
			w.rec.detected.Add(1)
		}
		w.record(outcomeFromVerdict(verdict), ruleName, r, ip, action)
		if st.engine.enforces() {
			f.served = true
			f.inspection = false
			w.writeRejection(rw, r, rejection{
				Status:   verdict.Status,
				GRPCCode: grpcStatusPermissionDenied,
				Message:  blockedMessage(verdict),
				Reason:   reasonRuleMatch,
				Rule:     ruleName,
			})
			return true, nil
		}
	} else {
		w.rec.passed.Add(1)
	}
	return w.forwardBody(rw, r, next, sc, f), nil
}

// forwardBody hands the scanner to the downstream handler. Nothing else is
// read here: the downstream pulls the body, and every frame after the first
// message is validated while it is streamed.
func (w *WAF) forwardBody(rw http.ResponseWriter, r *http.Request, next http.Handler, sc *grpcScanner, f *flow) bool {
	r.Body = sc
	f.served = true
	f.inspection = false
	next.ServeHTTP(rw, r)
	return true
}

// blockedMessage describes a message refused by a rule.
func blockedMessage(v Verdict) string {
	if v.RuleID > 0 {
		return fmt.Sprintf("%s (规则 %d)", messageBlocked, v.RuleID)
	}
	return messageBlocked
}

// noteViolation records a refusal of the body policy. The record is what an
// administrator reads to fix the route declarations, so it is written in both
// modes; the counters keep the two cases apart.
func (w *WAF) noteViolation(ruleName string, r *http.Request, ip string, rej rejection, policy bodyPolicy, state bodyState, enforced bool) {
	v := Violation{
		Time:     time.Now(),
		Rule:     ruleName,
		ClientIP: ip,
		Method:   r.Method,
		Host:     truncate(r.Host, 255),
		URI:      truncate(requestURI(r), maxURILen),
		Reason:   rej.Reason,
		Status:   rej.Status,
		Policy:   string(policy),
		State:    string(state),
		Message:  rej.Message,
		Enforced: enforced,
	}
	if grpcContentType(r) {
		// A gRPC client never sees an HTTP error status: the refusal travels in
		// the gRPC status of an HTTP 200 answer.
		v.Status = http.StatusOK
		v.GRPCStatus = rej.GRPCCode
	}
	w.body.add(v)
}

// inspectMessage runs one message through the configured inspector. The
// default inspector is the Coraza engine, exactly like a plain request body;
// a per message inspector (D) only has to replace it.
func (w *WAF) inspectMessage(ctx context.Context, st requestState, ruleName string, meta *requestMeta, msg []byte, index int) (Verdict, error) {
	w.mu.RLock()
	inspector := w.inspector
	w.mu.RUnlock()
	if inspector == nil {
		inspector = &engineInspector{engine: st.engine}
	}
	return inspector.Inspect(ctx, RequestMeta{
		ClientIP:    meta.ClientIP,
		ClientPort:  meta.ClientPort,
		Method:      meta.Method,
		URI:         meta.URI,
		Proto:       meta.Proto,
		Host:        meta.Host,
		ContentType: meta.Headers.Get("Content-Type"),
		Headers:     meta.Headers,
		Rule:        ruleName,
	}, msg, index)
}

// engineInspector is the default BodyInspector: it feeds one gRPC message to
// the Coraza engine exactly like a request body.
type engineInspector struct {
	engine *engine
}

// Inspect judges one message.
func (e *engineInspector) Inspect(ctx context.Context, meta RequestMeta, msg []byte, index int) (Verdict, error) {
	if e.engine == nil {
		return Verdict{}, errors.New("the waf engine is not available")
	}
	headers := meta.Headers.Clone()
	if headers == nil {
		headers = http.Header{}
	}
	// The message is judged as a standalone body: its length is known, and the
	// stream framing (chunked encoding) describes the stream, not the message.
	// Declaring the length keeps the protocol rules from reporting a body they
	// cannot size, which a gRPC client never sends an HTTP length for.
	headers.Del("Transfer-Encoding")
	headers.Set("Content-Length", strconv.Itoa(len(msg)))
	out, err := e.engine.process(ctx, &requestMeta{
		ClientIP:   meta.ClientIP,
		ClientPort: meta.ClientPort,
		Method:     meta.Method,
		URI:        meta.URI,
		Proto:      meta.Proto,
		Host:       meta.Host,
		Headers:    headers,
		Body:       bytes.NewReader(msg),
	})
	return Verdict{
		Blocked: out.Blocked,
		Status:  out.Status,
		Action:  out.Action,
		RuleID:  out.RuleID,
		Message: out.Message,
		TxID:    out.TxID,
		Matched: out.Matched,
	}, err
}

// outcomeFromVerdict converts what an inspector decided into the event the
// module records.
func outcomeFromVerdict(v Verdict) outcome {
	return outcome{
		Interrupted: v.Blocked,
		Blocked:     v.Blocked,
		Status:      v.Status,
		Action:      v.Action,
		RuleID:      v.RuleID,
		Message:     v.Message,
		TxID:        v.TxID,
		Matched:     v.Matched,
	}
}

// requestURI returns the request target as seen on the wire.
func requestURI(r *http.Request) string {
	if r.URL == nil {
		return "/"
	}
	return r.URL.RequestURI()
}

// splitHostPort extracts the port of a RemoteAddr, returning 0 when unknown.
func splitHostPort(addr string) (string, int) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port := 0
	for i := 0; i < len(portStr); i++ {
		if portStr[i] < '0' || portStr[i] > '9' {
			return host, 0
		}
		port = port*10 + int(portStr[i]-'0')
	}
	return host, port
}

// record stores the events of one blocked (or detected) request.
func (w *WAF) record(out outcome, ruleName string, r *http.Request, clientIP, action string) {
	base := Event{
		Time:     time.Now(),
		ClientIP: clientIP,
		Method:   r.Method,
		Host:     truncate(r.Host, 255),
		URI:      truncate(requestURI(r), maxURILen),
		Rule:     ruleName,
		Action:   action,
		Status:   out.Status,
		TxID:     out.TxID,
	}
	ids := make([]int, 0, len(out.Matched))
	for _, hit := range out.Matched {
		ids = append(ids, hit.ID)
	}

	if len(out.Matched) == 0 {
		base.RuleID = out.RuleID
		base.Message = truncate(out.Message, maxURILen)
		base.RuleIDs = ids
		w.rec.add(base)
		return
	}
	for i, hit := range out.Matched {
		if i >= maxEventsPerRequest {
			break
		}
		ev := base
		ev.RuleID = hit.ID
		ev.Message = truncate(hit.Message, maxURILen)
		ev.Severity = hit.Severity
		ev.Tags = hit.Tags
		ev.RuleIDs = ids
		w.rec.add(ev)
	}
}

// blockPage is a static page: no part of the request is echoed back, so a
// blocked request can never inject markup.
const blockPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>请求被拦截</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#12141a;color:#e6e8ee;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:3rem;margin:0 0 .5rem;color:#ff6b6b}
p{margin:.35rem 0;color:#a8adbd;line-height:1.6}
code{background:#1d2029;border-radius:4px;padding:.15rem .4rem;color:#e6e8ee}
</style>
</head>
<body>
<main>
<h1>%d</h1>
<p>该请求被 Web 应用防火墙拦截。</p>
%s
</main>
</body>
</html>
`

// writeBlocked answers a blocked request. Only numeric rule ids and the Coraza
// transaction id are rendered.
func (w *WAF) writeBlocked(rw http.ResponseWriter, out outcome) {
	if out.Action == "redirect" {
		if target := safeRedirect(out.Data); target != "" {
			h := rw.Header()
			h.Set("Location", target)
			h.Set("Cache-Control", "no-store")
			rw.WriteHeader(redirectStatus(out.Status))
			return
		}
	}
	status := out.Status
	if status < 400 || status > 599 {
		status = http.StatusForbidden
	}
	extra := ""
	if out.RuleID > 0 {
		extra = fmt.Sprintf("<p>规则 ID <code>%d</code></p>", out.RuleID)
	}
	if ref := safeToken(out.TxID); ref != "" {
		extra += fmt.Sprintf("<p>请求编号 <code>%s</code></p>", ref)
	}
	h := rw.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	rw.WriteHeader(status)
	_, _ = io.WriteString(rw, fmt.Sprintf(blockPage, status, extra))
}

// safeRedirect validates the target of a "redirect" rule action.
func safeRedirect(target string) string {
	target = strings.TrimSpace(target)
	if target == "" || len(target) > 2048 {
		return ""
	}
	for _, r := range target {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	u, err := url.Parse(target)
	if err != nil {
		return ""
	}
	if u.Scheme != "" && u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	if u.Scheme == "" && !strings.HasPrefix(target, "/") {
		return ""
	}
	return target
}

func redirectStatus(status int) int {
	if status >= 300 && status <= 399 {
		return status
	}
	return http.StatusFound
}

// safeToken keeps only ASCII letters and digits, used for values rendered in
// the block page.
func safeToken(s string) string {
	if s == "" || len(s) > 64 {
		return ""
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '-':
		default:
			return ""
		}
	}
	return s
}

// Stats returns counters for the UI.
func (w *WAF) Stats() map[string]any {
	w.mu.RLock()
	eng := w.engine
	cfg := w.cfg
	buildErr := w.buildErr
	w.mu.RUnlock()

	// The counters describe the engine that is actually serving traffic.
	if eng != nil {
		cfg = eng.cfg
	}
	stats := map[string]any{
		"enabled":           eng != nil && cfg.Enable,
		"mode":              cfg.Mode,
		"logOnly":           cfg.LogOnly,
		"useCrs":            cfg.UseCRS,
		"paranoiaLevel":     cfg.ParanoiaLevel,
		"executingLevel":    cfg.ExecutingLevel,
		"inboundThreshold":  cfg.InboundThreshold,
		"outboundThreshold": cfg.OutboundThreshold,
		"bodyLimitKb":       cfg.BodyLimitKB,
		"adminProtect":      cfg.AdminProtect,
		"requests":          w.rec.requests.Load(),
		"blocked":           w.rec.blocked.Load(),
		"detected":          w.rec.detected.Load(),
		"passed":            w.rec.passed.Load(),
		"errors":            w.rec.errors.Load(),
		"tests":             w.rec.tests.Load(),
		"events":            w.rec.size(),
		"topRules":          w.rec.topRules(10),
		"topWebRules":       w.rec.topWebRules(10),
		"enforcementMode":   cfg.EnforcementMode,
		"defaultBodyPolicy": cfg.DefaultBodyPolicy,
		"peekBytes":         cfg.PeekBytes,
		"peekTimeoutMs":     cfg.PeekTimeoutMS,
	}
	for k, v := range w.body.stats() {
		stats[k] = v
	}
	if eng != nil {
		stats["rules"] = eng.rules
		stats["ruleFiles"] = eng.files
		stats["detail"] = eng.detail
		stats["crsFallback"] = eng.crsFallback
		stats["builtAt"] = eng.builtAt
	}
	if buildErr != nil {
		stats["buildError"] = buildErr.Error()
	}
	if _, version, err := w.ruleCatalog(); err == nil {
		stats["crsVersion"] = version
	}
	return stats
}

// Status extends the module status with the WAF counters.
func (w *WAF) Status() module.Status {
	st := w.Base.Status()
	st.Stats = w.Stats()
	if st.Error == "" {
		w.mu.RLock()
		err := w.buildErr
		w.mu.RUnlock()
		if err != nil {
			st.Error = err.Error()
		}
	}
	return st
}

// ruleCatalog returns the built-in rule file list. It is computed once.
func (w *WAF) ruleCatalog() ([]ruleFile, string, error) {
	w.catalogOnce.Do(func() {
		files, version, err := builtinRuleFiles()
		w.catalog, w.crsVersion, w.catalogErr = files, version, err
	})
	return w.catalog, w.crsVersion, w.catalogErr
}

// Errors used by the module.
var (
	errNoConfigStore = errors.New("the configuration store is not available")
)
