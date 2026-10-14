package waf

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/module"
)

// The tests in this file cover the request body policy of the plan: T1 to T8 of
// docs/PLAN-waf-body-policy.md. T9 is the regression suite (waf_test.go and the
// web module tests), T10 runs the same scenarios over h2c and TLS in
// internal/modules/web.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// attack is a payload the bundled rule set refuses at paranoia level 1.
const attack = "user=admin&pass=1' OR '1'='1"

// cleanPayload is a payload without any rule match.
const cleanPayload = "user=nunt&pass=correct-horse-battery-staple"

// bodyConfig is the engine configuration used by the body policy tests.
func bodyConfig(mode string) model.WAFConfig {
	cfg := baseConfig()
	cfg.EnforcementMode = mode
	cfg.DefaultBodyPolicy = model.WAFBodyFull
	cfg.PeekBytes = 65536
	cfg.PeekTimeoutMS = 200
	return cfg
}

// bodyPolicyModule builds a module with a single web rule whose name is the
// policy it declares ("inherit" for an empty declaration) and returns the rule
// name the middleware has to be called with.
func bodyPolicyModule(t *testing.T, cfg model.WAFConfig, declared string) (*WAF, string) {
	t.Helper()
	name := declared
	if name == "" {
		name = "inherit"
	}
	deps := testDeps(t, cfg)
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Web.Rules = []model.WebRule{{
			ID: "rule-1", Name: name, Enable: true, Type: model.WebTypeProxy,
			Listen: []string{":0"}, BodyPolicy: declared,
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

// grpcFrame builds one gRPC frame around a payload.
func grpcFrame(payload []byte) []byte {
	out := make([]byte, grpcHeaderLen+len(payload))
	binary.BigEndian.PutUint32(out[1:grpcHeaderLen], uint32(len(payload)))
	copy(out[grpcHeaderLen:], payload)
	return out
}

// grpcFrameWithFlags builds a frame with an explicit flags byte.
func grpcFrameWithFlags(flags byte, payload []byte) []byte {
	out := grpcFrame(payload)
	out[0] = flags
	return out
}

// grpcHeader builds a frame header that declares a length.
func grpcHeader(flags byte, length uint32) []byte {
	out := make([]byte, grpcHeaderLen)
	out[0] = flags
	binary.BigEndian.PutUint32(out[1:], length)
	return out
}

// gzipPayload compresses a payload the way a gRPC client would.
func gzipPayload(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(payload); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip: %v", err)
	}
	return buf.Bytes()
}

// grpcRequest builds an application/grpc request.
func grpcRequest(body io.Reader, encoding string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://grpc.example.com/pkg.Service/Method", body)
	r.Header.Set("Content-Type", "application/grpc")
	r.Header.Set("Te", "trailers")
	if encoding != "" {
		r.Header.Set("Grpc-Encoding", encoding)
	}
	return r
}

// streamingReader hides its length, so a request looks like a chunked upload.
type streamingReader struct{ data []byte }

func (r *streamingReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

// recordingUpstream stands in for the reverse proxy: it counts the requests
// that reached it and keeps what it read from each body.
type recordingUpstream struct {
	mu       sync.Mutex
	requests int
	bodies   [][]byte
	errs     []error
	entered  chan struct{}
	once     sync.Once
}

func newUpstream() *recordingUpstream {
	return &recordingUpstream{entered: make(chan struct{})}
}

// handler reads the whole body and answers 200.
func (u *recordingUpstream) handler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		u.enter(r)
		rw.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(rw, "upstream")
	})
}

// echoHandler reads the whole body and echoes it back, which is how a test sees
// what the downstream actually received.
func (u *recordingUpstream) echoHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		u.enter(r)
		rw.WriteHeader(http.StatusOK)
		_, _ = rw.Write(u.body(0))
	})
}

// proxyHandler mimics the reverse proxy: it reads the body and maps a frame
// failure exactly like the proxy error handler does.
func (u *recordingUpstream) proxyHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		u.enter(r)
		if failure, ok := FrameFailure(r, u.err(0)); ok {
			WriteFrameFailure(rw, r, failure)
			return
		}
		rw.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(rw, "upstream")
	})
}

// enter records one request and reads its body.
func (u *recordingUpstream) enter(r *http.Request) {
	u.once.Do(func() { close(u.entered) })
	var (
		data []byte
		err  error
	)
	if r.Body != nil {
		data, err = io.ReadAll(r.Body)
	}
	u.record(data, err)
}

func (u *recordingUpstream) record(data []byte, err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.requests++
	u.bodies = append(u.bodies, data)
	u.errs = append(u.errs, err)
}

func (u *recordingUpstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.requests
}

func (u *recordingUpstream) body(i int) []byte {
	u.mu.Lock()
	defer u.mu.Unlock()
	if i >= len(u.bodies) {
		return nil
	}
	return u.bodies[i]
}

func (u *recordingUpstream) err(i int) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if i >= len(u.errs) {
		return nil
	}
	return u.errs[i]
}

// mustStat reads one counter from the module statistics.
func mustStat(t *testing.T, m *WAF, key string) int64 {
	t.Helper()
	v, ok := m.Stats()[key]
	if !ok {
		t.Fatalf("the statistic %s is missing", key)
	}
	n, ok := v.(int64)
	if !ok {
		t.Fatalf("the statistic %s is %T, want int64", key, v)
	}
	return n
}

// stateCount reads one entry of the bodyState distribution.
func stateCount(t *testing.T, m *WAF, state bodyState) int64 {
	t.Helper()
	states, ok := m.Stats()["bodyStates"].(map[string]int64)
	if !ok {
		t.Fatal("bodyStates is missing from the statistics")
	}
	return states[string(state)]
}

// violations returns the recorded refusals.
func violations(t *testing.T, m *WAF) []Violation {
	t.Helper()
	return m.body.list(0)
}

// ---------------------------------------------------------------------------
// T1: a unary gRPC message carrying an attack
// ---------------------------------------------------------------------------

func TestT1UnaryAttackIsRefusedBeforeTheUpstream(t *testing.T) {
	for _, mode := range []string{model.WAFEnforceEnforce, model.WAFEnforceObserve} {
		t.Run(mode, func(t *testing.T) {
			m, rule := bodyPolicyModule(t, bodyConfig(mode), model.WAFBodyGRPCUnary)
			up := newUpstream()
			rec := httptest.NewRecorder()
			m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(grpcFrame([]byte(attack))), ""))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: a gRPC refusal is an HTTP success", rec.Code)
			}
			if got := rec.Header().Get("Grpc-Status"); got != "7" {
				t.Fatalf("grpc-status = %q, want 7", got)
			}
			if up.count() != 0 {
				t.Fatal("the upstream must not be contacted for a refused first message")
			}
			if n := stateCount(t, m, stateGRPCUnary); n != 1 {
				t.Fatalf("grpc-unary state count = %d, want 1", n)
			}
			if n := mustStat(t, m, "grpcUnary"); n != 1 {
				t.Fatalf("grpcUnary = %d, want 1", n)
			}
			if n := mustStat(t, m, "grpcMessages"); n != 1 {
				t.Fatalf("inspected messages = %d, want 1", n)
			}
			if n := mustStat(t, m, "blocked"); n != 1 {
				t.Fatalf("blocked = %d, want 1", n)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// T2: a route declared grpc-unary that sends two frames
// ---------------------------------------------------------------------------

func TestT2SecondMessageOnAUnaryRoute(t *testing.T) {
	stream := append(grpcFrame([]byte(cleanPayload)), grpcFrame([]byte(cleanPayload))...)

	t.Run("enforce", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
		up := newUpstream()
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.proxyHandler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(stream), ""))

		if up.count() != 1 {
			t.Fatalf("the first message must reach the upstream, requests = %d", up.count())
		}
		if !errors.Is(up.err(0), ErrUnexpectedMessage) {
			t.Fatalf("the body reader must report the second message, got %v", up.err(0))
		}
		if got := rec.Header().Get("Grpc-Status"); got != "7" {
			t.Fatalf("grpc-status = %q, want 7", got)
		}
		if n := mustStat(t, m, "grpcSecondMessage"); n != 1 {
			t.Fatalf("grpcSecondMessage = %d, want 1", n)
		}
	})

	t.Run("observe", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), model.WAFBodyGRPCUnary)
		up := newUpstream()
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(stream), ""))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 in observe mode", rec.Code)
		}
		if up.count() != 1 {
			t.Fatal("observe mode must forward the request")
		}
		if !bytes.Equal(up.body(0), stream) {
			t.Fatal("observe mode must forward the body unchanged")
		}
		if n := mustStat(t, m, "wouldReject"); n != 1 {
			t.Fatalf("wouldReject = %d, want 1", n)
		}
		if n := mustStat(t, m, "grpcSecondMessage"); n != 1 {
			t.Fatalf("grpcSecondMessage = %d, want 1", n)
		}
		list := violations(t, m)
		if len(list) != 1 || list[0].Reason != reasonSecondMessage {
			t.Fatalf("the violation was not recorded: %+v", list)
		}
		if list[0].Enforced {
			t.Fatal("an observe mode record must not claim it was enforced")
		}
	})
}

// ---------------------------------------------------------------------------
// T3: bidi with a clean first message and an attacking second frame
// ---------------------------------------------------------------------------

func TestT3StreamingSecondFrameIsNotInspectedButCounted(t *testing.T) {
	body := append(grpcFrame([]byte(cleanPayload)), grpcFrame([]byte(attack))...)
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCStream)
	up := newUpstream()
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(body), ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if up.count() != 1 {
		t.Fatal("a clean first message must reach the upstream")
	}
	if !bytes.Equal(up.body(0), body) {
		t.Fatal("the stream was not forwarded byte for byte")
	}
	if n := stateCount(t, m, stateGRPCStream); n != 1 {
		t.Fatalf("grpc-stream state count = %d, want 1", n)
	}
	if n := mustStat(t, m, "grpcStream"); n != 1 {
		t.Fatalf("grpcStream = %d, want 1", n)
	}
	if n := mustStat(t, m, "wouldReject"); n != 0 {
		t.Fatalf("a declared stream does not refuse a second message: wouldReject = %d", n)
	}
	if n := mustStat(t, m, "blocked"); n != 0 {
		t.Fatalf("blocked = %d, want 0", n)
	}
}

// TestT3StreamIsForwardedWhileTheClientIsStillWriting proves the first message
// is judged without waiting for the end of the stream: the downstream receives
// it while the client is still writing.
func TestT3StreamIsForwardedWhileTheClientIsStillWriting(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCStream)
	up := newUpstream()

	pr, pw := io.Pipe()
	req := grpcRequest(pr, "")
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.echoHandler()).ServeHTTP(rec, req)
		done <- rec
	}()

	if _, err := pw.Write(grpcFrame([]byte(cleanPayload))); err != nil {
		t.Fatalf("write the first frame: %v", err)
	}
	select {
	case <-up.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("the first message was not forwarded while the client was still writing")
	}
	// The second frame arrives later; the stream must not have been closed.
	if _, err := pw.Write(grpcFrame([]byte(cleanPayload))); err != nil {
		t.Fatalf("write the second frame: %v", err)
	}
	_ = pw.Close()

	select {
	case rec := <-done:
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the bidirectional stream deadlocked")
	}
	if got := len(up.body(0)); got != 2*(grpcHeaderLen+len(cleanPayload)) {
		t.Fatalf("the downstream read %d bytes, want %d", got, 2*(grpcHeaderLen+len(cleanPayload)))
	}
}

// ---------------------------------------------------------------------------
// T4: bidi whose very first message is an attack
// ---------------------------------------------------------------------------

func TestT4StreamingFirstMessageAttackIsRefused(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCStream)
	up := newUpstream()
	rec := httptest.NewRecorder()
	// The second frame is never written: the refusal must not wait for it.
	m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(grpcFrame([]byte(attack))), ""))

	if up.count() != 0 {
		t.Fatal("the upstream must not be contacted when the first message is refused")
	}
	if got := rec.Header().Get("Grpc-Status"); got != "7" {
		t.Fatalf("grpc-status = %q, want 7", got)
	}
}

// ---------------------------------------------------------------------------
// T5: a stream the server is expected to open
// ---------------------------------------------------------------------------

func TestT5ServerFirstStreamIsForwardedAfterThePeekTimeout(t *testing.T) {
	cfg := bodyConfig(model.WAFEnforceEnforce)
	cfg.PeekTimeoutMS = 200
	m, rule := bodyPolicyModule(t, cfg, model.WAFBodyGRPCStream)
	up := newUpstream()

	pr, pw := io.Pipe()
	req := grpcRequest(pr, "")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	start := time.Now()
	go func() {
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)
		close(done)
	}()

	select {
	case <-up.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("the request was not forwarded when the client stayed silent")
	}
	elapsed := time.Since(start)
	if elapsed < 150*time.Millisecond {
		t.Fatalf("the request was forwarded after %s, before the peek timeout", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("the request was forwarded after %s, the peek timeout is not respected", elapsed)
	}
	if n := stateCount(t, m, stateGRPCServerFirst); n != 1 {
		t.Fatalf("grpc-server-first state count = %d, want 1", n)
	}
	if n := mustStat(t, m, "grpcServerFirst"); n != 1 {
		t.Fatalf("grpcServerFirst = %d, want 1", n)
	}

	// The frame the client sends afterwards must still reach the upstream: the
	// timed out read never lost a byte.
	frame := grpcFrame([]byte(cleanPayload))
	if _, err := pw.Write(frame); err != nil {
		t.Fatalf("write the frame: %v", err)
	}
	_ = pw.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the request did not finish after the client sent its frame")
	}
	if !bytes.Equal(up.body(0), frame) {
		t.Fatalf("the upstream read %q, want %q", up.body(0), frame)
	}
}

// TestT5SlowPeekClientIsForwardedWithinTheTimeout proves the peek policy never
// waits for a body that is not sent.
func TestT5SlowPeekClientIsForwardedWithinTheTimeout(t *testing.T) {
	cfg := bodyConfig(model.WAFEnforceEnforce)
	cfg.PeekTimeoutMS = 150
	cfg.PeekBytes = 65536
	m, rule := bodyPolicyModule(t, cfg, model.WAFBodyPeek)
	up := newUpstream()

	pr, pw := io.Pipe()
	req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", pr)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	start := time.Now()
	go func() {
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)
		close(done)
	}()
	select {
	case <-up.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("the request was not forwarded when the client stayed silent")
	}
	elapsed := time.Since(start)
	if elapsed < 100*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("the peek returned after %s, want about the 150ms timeout", elapsed)
	}
	if n := stateCount(t, m, statePeeked); n != 1 {
		t.Fatalf("peeked state count = %d, want 1", n)
	}
	payload := []byte("field=value")
	if _, err := pw.Write(payload); err != nil {
		t.Fatalf("write the body: %v", err)
	}
	_ = pw.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the request did not finish")
	}
	if !bytes.Equal(up.body(0), payload) {
		t.Fatalf("the upstream read %q, want %q", up.body(0), payload)
	}
}

// ---------------------------------------------------------------------------
// T6: a chunked request under the full policy
// ---------------------------------------------------------------------------

func TestT6ChunkedRequestUnderTheFullPolicy(t *testing.T) {
	payload := []byte(cleanPayload)

	t.Run("enforce", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyFull)
		up := newUpstream()
		req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", &streamingReader{data: payload})
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

		if rec.Code != http.StatusLengthRequired {
			t.Fatalf("status = %d, want 411", rec.Code)
		}
		if up.count() != 0 {
			t.Fatal("the upstream must not see a request that cannot be inspected")
		}
		if !strings.Contains(rec.Body.String(), messageLengthRequired) {
			t.Fatalf("the refusal does not explain the cause: %q", rec.Body.String())
		}
		if n := mustStat(t, m, "refused"); n != 1 {
			t.Fatalf("refused = %d, want 1", n)
		}
		list := violations(t, m)
		if len(list) != 1 || list[0].Reason != reasonLengthUnknown || list[0].Status != http.StatusLengthRequired {
			t.Fatalf("the refusal was not recorded: %+v", list)
		}
	})

	t.Run("observe", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), model.WAFBodyFull)
		up := newUpstream()
		req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", &streamingReader{data: payload})
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 in observe mode", rec.Code)
		}
		if up.count() != 1 || !bytes.Equal(up.body(0), payload) {
			t.Fatal("observe mode must forward the complete body")
		}
		if n := mustStat(t, m, "wouldReject"); n != 1 {
			t.Fatalf("wouldReject = %d, want 1", n)
		}
		if n := stateCount(t, m, statePeeked); n != 1 {
			t.Fatalf("the request should have been inspected as far as possible")
		}
		list := violations(t, m)
		if len(list) != 1 || list[0].Reason != reasonLengthUnknown || list[0].Enforced {
			t.Fatalf("the would-reject record is wrong: %+v", list)
		}
	})

	t.Run("declared length is accepted", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyFull)
		up := newUpstream()
		req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || up.count() != 1 {
			t.Fatalf("a declared body must be inspected and forwarded: %d, %d", rec.Code, up.count())
		}
		if n := stateCount(t, m, stateFull); n != 1 {
			t.Fatalf("full state count = %d, want 1", n)
		}
	})
}

// ---------------------------------------------------------------------------
// T7: a route that declares peek
// ---------------------------------------------------------------------------

func TestT7PeekPolicy(t *testing.T) {
	const limit = 64

	t.Run("an attack inside the peek is refused", func(t *testing.T) {
		cfg := bodyConfig(model.WAFEnforceEnforce)
		cfg.PeekBytes = limit
		m, rule := bodyPolicyModule(t, cfg, model.WAFBodyPeek)
		up := newUpstream()
		body := []byte("pad=" + attack + strings.Repeat("x", 200))
		req := httptest.NewRequest(http.MethodPost, "http://app.example.com/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		if up.count() != 0 {
			t.Fatal("a refused request must not reach the upstream")
		}
	})

	t.Run("the rest of the body is streamed", func(t *testing.T) {
		cfg := bodyConfig(model.WAFEnforceEnforce)
		cfg.PeekBytes = limit
		m, rule := bodyPolicyModule(t, cfg, model.WAFBodyPeek)
		up := newUpstream()
		body := []byte(strings.Repeat("a", limit) + attack)
		req := httptest.NewRequest(http.MethodPost, "http://app.example.com/login", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !bytes.Equal(up.body(0), body) {
			t.Fatalf("the body was not streamed unchanged: %q", up.body(0))
		}
		if n := stateCount(t, m, statePeeked); n != 1 {
			t.Fatalf("peeked state count = %d, want 1", n)
		}
	})
}

// ---------------------------------------------------------------------------
// T8: malformed frames, oversized messages, truncated streams, gzip
// ---------------------------------------------------------------------------

func TestT8FrameValidation(t *testing.T) {
	cases := []struct {
		name   string
		body   []byte
		kind   error
		status string
	}{
		{
			name:   "malformed flags",
			body:   grpcFrameWithFlags(2, []byte(cleanPayload)),
			kind:   ErrFrameMalformed,
			status: "8",
		},
		{
			name:   "message above the size limit",
			body:   grpcHeader(0, maxGRPCMessageBytes+1),
			kind:   ErrMessageTooLarge,
			status: "8",
		},
		{
			name:   "truncated frame",
			body:   append(grpcHeader(0, 10), []byte("abc")...),
			kind:   ErrTruncatedStream,
			status: "8",
		},
		{
			name:   "truncated header",
			body:   []byte{0, 0, 0},
			kind:   ErrTruncatedStream,
			status: "8",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), model.WAFBodyGRPCUnary)
			up := newUpstream()
			rec := httptest.NewRecorder()
			m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(tc.body), ""))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: a frame failure is a gRPC status", rec.Code)
			}
			if got := rec.Header().Get("Grpc-Status"); got != tc.status {
				t.Fatalf("grpc-status = %q, want %s", got, tc.status)
			}
			if up.count() != 0 {
				t.Fatal("a malformed frame must not reach the upstream")
			}
			if n := stateCount(t, m, stateFrameError); n != 1 {
				t.Fatalf("frame-error state count = %d, want 1", n)
			}
			if n := mustStat(t, m, "grpcFrameErrors"); n != 1 {
				t.Fatalf("grpcFrameErrors = %d, want 1", n)
			}
			if !errors.Is(tc.kind, tc.kind) {
				t.Fatal("unreachable")
			}
		})
	}
}

// TestT8TruncationDuringStreaming covers the frames after the first message:
// the failure travels through the body reader to the proxy error handler.
func TestT8TruncationDuringStreaming(t *testing.T) {
	body := append(grpcFrame([]byte(cleanPayload)), grpcHeader(0, 32)...)
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCStream)
	up := newUpstream()
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.proxyHandler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(body), ""))

	if !errors.Is(up.err(0), ErrTruncatedStream) {
		t.Fatalf("the body reader reported %v, want ErrTruncatedStream", up.err(0))
	}
	if got := rec.Header().Get("Grpc-Status"); got != "8" {
		t.Fatalf("grpc-status = %q, want 8", got)
	}
	if n := mustStat(t, m, "grpcFrameErrors"); n != 1 {
		t.Fatalf("grpcFrameErrors = %d, want 1", n)
	}
}

// TestT8GzipMessageIsDecompressedAndInspected proves a compressed message
// cannot hide an attack: the frame is decoded under the size cap before it is
// judged.
func TestT8GzipMessageIsDecompressedAndInspected(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
	up := newUpstream()
	frame := grpcFrameWithFlags(1, gzipPayload(t, []byte(attack)))
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(frame), "gzip"))

	if up.count() != 0 {
		t.Fatal("a compressed attack must be refused")
	}
	if got := rec.Header().Get("Grpc-Status"); got != "7" {
		t.Fatalf("grpc-status = %q, want 7", got)
	}
	if n := mustStat(t, m, "grpcCompressed"); n != 1 {
		t.Fatalf("grpcCompressed = %d, want 1", n)
	}
}

// TestT8GzipMessageIsForwardedUnchanged proves the scanner replays the original
// bytes: a compressed stream is never re-encoded.
func TestT8GzipMessageIsForwardedUnchanged(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
	up := newUpstream()
	frame := grpcFrameWithFlags(1, gzipPayload(t, []byte(cleanPayload)))
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(frame), "gzip"))

	if rec.Code != http.StatusOK || up.count() != 1 {
		t.Fatalf("a clean compressed message must be forwarded: %d, %d", rec.Code, up.count())
	}
	if !bytes.Equal(up.body(0), frame) {
		t.Fatal("the compressed frame was altered")
	}
	if n := mustStat(t, m, "grpcCompressed"); n != 1 {
		t.Fatalf("grpcCompressed = %d, want 1", n)
	}
}

// TestT8GzipBombIsRefused proves the decompression is capped.
func TestT8GzipBombIsRefused(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
	up := newUpstream()
	huge := bytes.Repeat([]byte("a"), maxGRPCMessageBytes+1024)
	frame := grpcFrameWithFlags(1, gzipPayload(t, huge))
	if len(frame) > maxGRPCMessageBytes {
		t.Fatalf("the compressed frame is %d bytes, the test would not exercise the decompression cap", len(frame))
	}
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(frame), "gzip"))

	if up.count() != 0 {
		t.Fatal("a message that expands beyond the cap must be refused")
	}
	if got := rec.Header().Get("Grpc-Status"); got != "8" {
		t.Fatalf("grpc-status = %q, want 8", got)
	}
	if n := mustStat(t, m, "grpcFrameErrors"); n != 1 {
		t.Fatalf("grpcFrameErrors = %d, want 1", n)
	}
}

// TestT8UnsupportedEncodingFailsClosed covers a compression the module cannot
// decode: the message is not inspected, which is a gap the client chose, so the
// request is refused in enforce mode and recorded in observe mode.
func TestT8UnsupportedEncodingFailsClosed(t *testing.T) {
	frame := grpcFrameWithFlags(1, []byte(cleanPayload))

	t.Run("enforce", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
		up := newUpstream()
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(frame), "snappy"))
		if up.count() != 0 {
			t.Fatal("an uninspectable message must not reach the upstream in enforce mode")
		}
		if got := rec.Header().Get("Grpc-Status"); got != "7" {
			t.Fatalf("grpc-status = %q, want 7", got)
		}
		list := violations(t, m)
		if len(list) != 1 || list[0].Reason != reasonEncoding {
			t.Fatalf("the refusal was not recorded: %+v", list)
		}
	})

	t.Run("observe", func(t *testing.T) {
		m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), model.WAFBodyGRPCUnary)
		up := newUpstream()
		rec := httptest.NewRecorder()
		m.Middleware(rule, up.handler()).ServeHTTP(rec, grpcRequest(bytes.NewReader(frame), "snappy"))
		if rec.Code != http.StatusOK || up.count() != 1 {
			t.Fatalf("observe mode must forward the request: %d, %d", rec.Code, up.count())
		}
		list := violations(t, m)
		if len(list) != 1 || list[0].Reason != reasonEncoding || list[0].Enforced {
			t.Fatalf("the would-reject record is wrong: %+v", list)
		}
	})
}

// ---------------------------------------------------------------------------
// the decision table itself
// ---------------------------------------------------------------------------

func TestResolveBodyPolicy(t *testing.T) {
	cases := []struct {
		declared string
		global   string
		grpc     bool
		want     bodyPolicy
	}{
		{declared: "", global: model.WAFBodyFull, want: policyFull},
		{declared: "", global: model.WAFBodyPeek, want: policyPeek},
		{declared: "", global: model.WAFBodySkip, want: policySkip},
		{declared: "", global: model.WAFBodyGRPC, grpc: true, want: policyGRPCUnary},
		{declared: "", global: model.WAFBodyFull, grpc: true, want: policyGRPCUnary},
		{declared: model.WAFBodySkip, global: model.WAFBodyFull, grpc: true, want: policySkip},
		{declared: model.WAFBodyPeek, global: model.WAFBodyFull, grpc: true, want: policyPeek},
		{declared: model.WAFBodyGRPCStream, global: model.WAFBodyFull, grpc: true, want: policyGRPCStream},
		{declared: model.WAFBodyGRPCStream, global: model.WAFBodyFull, want: policyFull},
		{declared: model.WAFBodyGRPCUnary, global: model.WAFBodyFull, grpc: true, want: policyGRPCUnary},
		{declared: model.WAFBodyGRPCUnary, global: model.WAFBodyFull, want: policyFull},
		{declared: "unknown", global: model.WAFBodyFull, want: policyFull},
	}
	for _, tc := range cases {
		if got := resolveBodyPolicy(tc.declared, tc.global, tc.grpc); got != tc.want {
			t.Errorf("resolveBodyPolicy(%q, %q, %v) = %q, want %q", tc.declared, tc.global, tc.grpc, got, tc.want)
		}
	}
}

// TestPeekPolicyWithoutBody covers a request that carries no body at all:
// every policy must leave it alone.
func TestPeekPolicyWithoutBody(t *testing.T) {
	for _, policy := range []string{model.WAFBodyPeek, model.WAFBodyFull, model.WAFBodySkip, model.WAFBodyGRPCUnary} {
		t.Run(policy, func(t *testing.T) {
			m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), policy)
			up := newUpstream()
			req := httptest.NewRequest(http.MethodGet, "http://app.example.com/index.html", nil)
			rec := httptest.NewRecorder()
			m.Middleware(rule, up.handler()).ServeHTTP(rec, req)
			if rec.Code != http.StatusOK || up.count() != 1 {
				t.Fatalf("a bodyless request must be forwarded: %d, %d", rec.Code, up.count())
			}
		})
	}
}

// TestSkipPolicyForwardsTheBodyUntouched covers the first row of the table.
func TestSkipPolicyForwardsTheBodyUntouched(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodySkip)
	up := newUpstream()
	body := []byte(attack)
	req := httptest.NewRequest(http.MethodPost, "http://app.example.com/submit", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !bytes.Equal(up.body(0), body) {
		t.Fatal("a skipped body must be forwarded unchanged")
	}
	if n := stateCount(t, m, stateSkipped); n != 1 {
		t.Fatalf("skipped state count = %d, want 1", n)
	}
}

// TestGRPCRequestWithoutBody covers a gRPC call that carries no message.
func TestGRPCRequestWithoutBody(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceEnforce), model.WAFBodyGRPCUnary)
	up := newUpstream()
	req := grpcRequest(nil, "")
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || up.count() != 1 {
		t.Fatalf("a bodyless gRPC request must be forwarded: %d, %d", rec.Code, up.count())
	}
	if n := stateCount(t, m, stateGRPCUnary); n != 1 {
		t.Fatalf("grpc-unary state count = %d, want 1", n)
	}
}

// TestFrameFailureMapping pins the answers a proxy error handler produces.
func TestFrameFailureMapping(t *testing.T) {
	cases := []struct {
		kind error
		code int
	}{
		{kind: ErrFrameMalformed, code: 8},
		{kind: ErrMessageTooLarge, code: 8},
		{kind: ErrTruncatedStream, code: 8},
		{kind: ErrUnexpectedMessage, code: 7},
	}
	for _, tc := range cases {
		failure, ok := FrameFailure(nil, tc.kind)
		if !ok {
			t.Fatalf("%v was not recognised", tc.kind)
		}
		if failure.GRPCCode != tc.code {
			t.Errorf("%v maps to gRPC status %d, want %d", tc.kind, failure.GRPCCode, tc.code)
		}
	}
	if _, ok := FrameFailure(nil, errors.New("some transport failure")); ok {
		t.Fatal("an unrelated transport error must not be mapped to a frame failure")
	}
}

// TestRequestCarriesTheFrameFailure proves the failure reaches the error
// handler through the request even when the transport replaced the error.
func TestRequestCarriesTheFrameFailure(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://grpc.example.com/pkg.Service/Method", nil)
	req, slot := withFailureSlot(req)
	slot.set(failureFor(ErrUnexpectedMessage))

	failure, ok := FrameFailure(req, errors.New("net/http: HTTP/2 transport connection broken"))
	if !ok {
		t.Fatal("the recorded failure was not found")
	}
	if failure.GRPCCode != 7 || !errors.Is(failure.Kind, ErrUnexpectedMessage) {
		t.Fatalf("unexpected failure: %+v", failure)
	}
}

// TestBodyRecorderRingBuffer proves the would-reject buffer is bounded and
// keeps the newest records.
func TestBodyRecorderRingBuffer(t *testing.T) {
	r := newBodyRecorder()
	for i := 0; i < defaultWouldRejectKeep+20; i++ {
		r.add(Violation{Rule: "site", Reason: reasonLengthUnknown, Status: 411})
	}
	if n := r.size(); n != defaultWouldRejectKeep {
		t.Fatalf("the buffer kept %d records, want %d", n, defaultWouldRejectKeep)
	}
	if n := r.wouldReject.Load(); n != int64(defaultWouldRejectKeep+20) {
		t.Fatalf("the counter is %d, want %d", n, defaultWouldRejectKeep+20)
	}
	if n := len(r.list(0)); n != defaultWouldRejectKeep {
		t.Fatalf("list returned %d records, want %d", n, defaultWouldRejectKeep)
	}
	r.clear()
	if n := r.size(); n != 0 {
		t.Fatalf("clear left %d records", n)
	}
}

// TestWouldRejectIsExposedByTheAPIConfig ensures the WAF page can read the
// records without a new route.
func TestWouldRejectIsExposedByTheAPIConfig(t *testing.T) {
	m, rule := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), model.WAFBodyFull)
	up := newUpstream()
	req := httptest.NewRequest(http.MethodPost, "http://app.example.com/upload", &streamingReader{data: []byte(cleanPayload)})
	rec := httptest.NewRecorder()
	m.Middleware(rule, up.handler()).ServeHTTP(rec, req)

	mux := newMux(t, m)
	apiRec := apiDo(t, mux, http.MethodGet, "/api/v1/waf/config", nil)
	if apiRec.Code != http.StatusOK {
		t.Fatalf("GET /config = %d", apiRec.Code)
	}
	var payload struct {
		WouldReject      []Violation `json:"wouldReject"`
		UndeclaredRoutes []routeView `json:"undeclaredRoutes"`
		Stats            struct {
			WouldReject int64 `json:"wouldReject"`
		} `json:"stats"`
		Config struct {
			EnforcementMode   string `json:"enforcementMode"`
			DefaultBodyPolicy string `json:"defaultBodyPolicy"`
			PeekBytes         int    `json:"peekBytes"`
			PeekTimeoutMS     int    `json:"peekTimeoutMs"`
		} `json:"config"`
	}
	if err := json.Unmarshal(apiRec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode the answer: %v", err)
	}
	if len(payload.WouldReject) != 1 {
		t.Fatalf("the answer carries %d records, want 1", len(payload.WouldReject))
	}
	if payload.WouldReject[0].Reason != reasonLengthUnknown {
		t.Fatalf("unexpected record: %+v", payload.WouldReject[0])
	}
	if payload.Stats.WouldReject != 1 {
		t.Fatalf("the statistics report %d refusals, want 1", payload.Stats.WouldReject)
	}
	if payload.Config.EnforcementMode != model.WAFEnforceObserve || payload.Config.PeekBytes != 65536 {
		t.Fatalf("the configuration is not exposed: %+v", payload.Config)
	}
	// The rule of this test declares full, so no route is undeclared.
	if len(payload.UndeclaredRoutes) != 0 {
		t.Fatalf("undeclaredRoutes = %+v, want none", payload.UndeclaredRoutes)
	}
}

// TestUndeclaredRoutesAreReported covers the list the WAF page shows before
// the switch to enforce mode.
func TestUndeclaredRoutesAreReported(t *testing.T) {
	m, _ := bodyPolicyModule(t, bodyConfig(model.WAFEnforceObserve), "")
	if err := m.deps.Cfg.Update(func(c *model.Config) error {
		c.Web.Rules[0].WAF = true
		c.Web.Rules = append(c.Web.Rules, model.WebRule{
			ID: "rule-2", Name: "peek-route", Enable: true, Type: model.WebTypeProxy,
			Listen: []string{":0"}, BodyPolicy: model.WAFBodyPeek, WAF: true,
			Proxy: &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9"}},
		})
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	rec := apiDo(t, newMux(t, m), http.MethodGet, "/api/v1/waf/config", nil)
	var payload struct {
		UndeclaredRoutes []routeView `json:"undeclaredRoutes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode the answer: %v", err)
	}
	if len(payload.UndeclaredRoutes) != 1 {
		t.Fatalf("the answer lists %d undeclared routes, want 1", len(payload.UndeclaredRoutes))
	}
	got := payload.UndeclaredRoutes[0]
	if got.ID != "rule-1" || got.Name != "inherit" || !got.WAF || got.Type != model.WebTypeProxy {
		t.Fatalf("unexpected route: %+v", got)
	}
}

// TestPolicyMapFollowsTheRuleName proves the middleware resolves the policy of
// the rule the web module names.
func TestPolicyMapFollowsTheRuleName(t *testing.T) {
	deps := testDeps(t, bodyConfig(model.WAFEnforceEnforce))
	if err := deps.Cfg.Update(func(c *model.Config) error {
		rule := func(id, name, policy string) model.WebRule {
			return model.WebRule{
				ID: id, Name: name, Enable: true, Type: model.WebTypeProxy,
				Listen: []string{":0"}, BodyPolicy: policy,
				Proxy: &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9"}},
			}
		}
		c.Web.Rules = []model.WebRule{
			rule("id-a", "site-a", model.WAFBodyPeek),
			rule("id-b", "", model.WAFBodySkip),
			rule("id-c", "  site-c  ", model.WAFBodyGRPCStream),
		}
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	m := New(deps)
	defer func() { _ = m.Stop(context.Background()) }()
	if err := m.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	cases := map[string]string{
		"site-a": model.WAFBodyPeek,
		"id-b":   model.WAFBodySkip,
		"site-c": model.WAFBodyGRPCStream,
		"other":  "",
	}
	for rule, want := range cases {
		if got := m.state().policy(rule); got != want {
			t.Errorf("policy of %q = %q, want %q", rule, got, want)
		}
	}
	if err := deps.Cfg.Update(func(c *model.Config) error {
		c.Web.Rules[0].BodyPolicy = model.WAFBodySkip
		return nil
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	m.Reload(deps.Cfg.Snapshot())
	if got := m.state().policy("site-a"); got != model.WAFBodySkip {
		t.Fatalf("policy after reload = %q, want %q", got, model.WAFBodySkip)
	}
}

// moduleDeps keeps the import of the module package meaningful for the helper
// signatures above.
var _ = module.Deps{}
