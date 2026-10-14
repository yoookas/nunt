package waf

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nunt/nunt/internal/model"
)

// This file implements the request body inspection policy of the module: the
// decision table of the plan (which body is inspected, and how), the refusal
// answers and the bounded reader every "peek" style policy is built on.
//
// Hard rule: no policy branch may wait for the client to finish its body. A
// branch either knows the exact number of bytes it still has to read (full,
// bounded by the declared Content-Length and the engine body limit) or reads
// with a deadline and forwards whatever is left (peek, gRPC). The reader below
// is what makes the timed reads safe: it is the only goroutine that ever reads
// the request body, so a read that stopped waiting can still hand its bytes to
// the next consumer instead of losing them to a concurrent reader.

// bodyPolicy is the body handling strategy chosen for one request.
type bodyPolicy string

const (
	policyFull       bodyPolicy = model.WAFBodyFull
	policyPeek       bodyPolicy = model.WAFBodyPeek
	policySkip       bodyPolicy = model.WAFBodySkip
	policyGRPCUnary  bodyPolicy = model.WAFBodyGRPCUnary
	policyGRPCStream bodyPolicy = model.WAFBodyGRPCStream
)

// bodyState is what the module actually did with the body of one request.
// Every request that reaches the engine records exactly one state.
type bodyState string

const (
	stateFull            bodyState = "full"
	statePeeked          bodyState = "peeked"
	stateSkipped         bodyState = "skipped"
	stateGRPCUnary       bodyState = "grpc-unary"
	stateGRPCStream      bodyState = "grpc-stream"
	stateGRPCServerFirst bodyState = "grpc-server-first"
	stateFrameError      bodyState = "frame-error"
)

// bodyStates lists every recorded state, in the order shown by the UI.
var bodyStates = []bodyState{
	stateFull, statePeeked, stateSkipped,
	stateGRPCUnary, stateGRPCStream, stateGRPCServerFirst, stateFrameError,
}

// Reasons of a "would reject" record. They name the decision table row that
// refused the request, so an operator can fix the declaration.
const (
	reasonLengthUnknown = "content-length-unknown"
	reasonSecondMessage = "grpc-second-message"
	reasonEncoding      = "grpc-encoding-unsupported"
	reasonFrameError    = "grpc-frame-error"
	reasonRuleMatch     = "rule-match"
)

// pullChunk bounds how many bytes one background read asks for. It changes the
// number of reads, never how much of a body is inspected.
const pullChunk = 32 << 10

// errPeekTimeout reports that a bounded read did not deliver data in time. It
// is not a failure of the request: the caller forwards what it has.
var errPeekTimeout = errors.New("the client did not send request body data in time")

// resolveBodyPolicy applies the request body decision table:
//
//  1. a declared skip  -> skip, the body is forwarded untouched
//  2. a declared peek  -> peek, the first PeekBytes are inspected
//  3. an application/grpc content type is handled by the gRPC path and is
//     unary unless the rule declares grpc-stream
//  4. everything else is full: a declared length is inspected completely
//     before the upstream is contacted, a missing length is refused
//
// declared is the policy of the web rule (empty inherits the global default)
// and fallback is that global default (full, peek, skip or grpc). An unknown
// value is treated as full, so a configuration the runtime does not understand
// fails closed instead of forwarding an uninspected body.
func resolveBodyPolicy(declared, fallback string, grpcContent bool) bodyPolicy {
	name := validPolicyName(declared)
	if name == "" {
		name = validPolicyName(fallback)
	}
	switch name {
	case model.WAFBodySkip:
		return policySkip
	case model.WAFBodyPeek:
		return policyPeek
	case model.WAFBodyGRPCStream:
		if grpcContent {
			return policyGRPCStream
		}
	case model.WAFBodyGRPCUnary, model.WAFBodyGRPC:
		if grpcContent {
			return policyGRPCUnary
		}
	case model.WAFBodyFull:
		if grpcContent {
			return policyGRPCUnary
		}
	}
	return policyFull
}

// validPolicyName returns the canonical spelling of a configured policy, or an
// empty string when the value is unknown.
func validPolicyName(v string) string {
	switch v = strings.ToLower(strings.TrimSpace(v)); v {
	case model.WAFBodyFull, model.WAFBodyPeek, model.WAFBodySkip, model.WAFBodyGRPC,
		model.WAFBodyGRPCUnary, model.WAFBodyGRPCStream:
		return v
	}
	return ""
}

// grpcContentType reports whether the request body carries gRPC frames. Only
// the content type is used: gRPC always announces itself, and a client that
// hides it sends plain HTTP, which the full policy covers.
func grpcContentType(r *http.Request) bool {
	if r == nil {
		return false
	}
	return isGRPCContentType(r.Header.Get("Content-Type"))
}

// isGRPCContentType reports whether a content type selects the gRPC path.
func isGRPCContentType(contentType string) bool {
	if i := strings.IndexByte(contentType, ';'); i >= 0 {
		contentType = contentType[:i]
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "application/grpc")
}

// grpcEncoding returns the message encoding the client declared. The gRPC
// specification defaults to identity, which means "not compressed".
func grpcEncoding(r *http.Request) string {
	if r == nil {
		return grpcIdentityEncoding
	}
	v := strings.ToLower(strings.TrimSpace(r.Header.Get("Grpc-Encoding")))
	if v == "" {
		return grpcIdentityEncoding
	}
	return v
}

// rulePolicies maps the rule names the middleware is called with to the body
// policy the matching rule declared. The web module passes the display name of
// a rule (its name, or its id when the name is empty), so the same naming is
// used here; a rule that is not found inherits the global default.
func rulePolicies(cfg *model.Config) map[string]string {
	if cfg == nil {
		return nil
	}
	out := make(map[string]string, len(cfg.Web.Rules))
	for _, r := range cfg.Web.Rules {
		name := strings.TrimSpace(r.Name)
		if name == "" {
			name = strings.TrimSpace(r.ID)
		}
		if name == "" {
			continue
		}
		out[name] = strings.TrimSpace(r.BodyPolicy)
	}
	return out
}

// ---------------------------------------------------------------------------
// bounded reader
// ---------------------------------------------------------------------------

// pullResult is the outcome of one background read.
type pullResult struct {
	data []byte
	err  error
}

// timedReader reads a request body with a deadline. A read that times out is
// not aborted: the bytes it eventually captures stay available to the next
// consumer through Read, so a policy that stopped waiting never loses body
// bytes and never has to read the body concurrently with the downstream.
type timedReader struct {
	rc      io.ReadCloser
	chunk   int
	pending chan pullResult
	left    []byte
	tail    error
}

// newTimedReader wraps a request body. The returned reader is the only reader
// of rc: callers must not read rc themselves any more.
func newTimedReader(rc io.ReadCloser, chunk int) *timedReader {
	if chunk <= 0 {
		chunk = pullChunk
	}
	if rc == nil {
		// A request without a body (a synthetic request, for instance) reads
		// as an empty one instead of dereferencing a nil reader.
		rc = http.NoBody
	}
	return &timedReader{rc: rc, chunk: chunk}
}

// pull returns the next bytes of the body. It waits at most until deadline
// (zero means "wait for the client") and reports errPeekTimeout when the
// deadline passed first. The read that timed out keeps running in the
// background; Read hands its bytes to the downstream.
func (t *timedReader) pull(size int, deadline time.Time) ([]byte, error) {
	if len(t.left) > 0 {
		data := t.left
		t.left = nil
		return data, nil
	}
	if t.tail != nil {
		err := t.tail
		t.tail = nil
		return nil, err
	}
	if size <= 0 || size > t.chunk {
		size = t.chunk
	}
	if t.pending == nil {
		ch := make(chan pullResult, 1)
		buf := make([]byte, size)
		t.pending = ch
		go func() {
			n, err := t.rc.Read(buf)
			if n == 0 && err == nil {
				// A reader that reports no progress would make the caller
				// spin; the contract of io.Reader allows this but discourages
				// it, so it is reported as an error instead.
				err = io.ErrNoProgress
			}
			ch <- pullResult{data: buf[:n], err: err}
		}()
	}
	var timeout <-chan time.Time
	if !deadline.IsZero() {
		wait := time.Until(deadline)
		if wait <= 0 {
			return nil, errPeekTimeout
		}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		timeout = timer.C
	}
	select {
	case res := <-t.pending:
		t.pending = nil
		if len(res.data) > 0 {
			if res.err != nil {
				// The error belongs after the data.
				t.tail = res.err
			}
			return res.data, nil
		}
		return nil, res.err
	case <-timeout:
		return nil, errPeekTimeout
	}
}

// Read implements io.Reader for the downstream handler. It serves the bytes of
// a read that was still in flight when a policy stopped waiting and then reads
// the body directly.
func (t *timedReader) Read(p []byte) (int, error) {
	if len(t.left) > 0 {
		n := copy(p, t.left)
		t.left = t.left[n:]
		return n, nil
	}
	if t.pending != nil {
		res := <-t.pending
		t.pending = nil
		if len(res.data) > 0 {
			if res.err != nil {
				t.tail = res.err
			}
			n := copy(p, res.data)
			t.left = res.data[n:]
			return n, nil
		}
		t.tail = res.err
	}
	if t.tail != nil {
		err := t.tail
		t.tail = nil
		return 0, err
	}
	if t.rc == nil {
		return 0, io.EOF
	}
	n, err := t.rc.Read(p)
	if n == 0 && err == nil {
		// A reader that reports no progress would make the caller spin.
		err = io.ErrNoProgress
	}
	return n, err
}

// unread puts bytes back in front of the reader. It is used when a read
// returned more than the caller asked for.
func (t *timedReader) unread(data []byte) {
	if len(data) == 0 {
		return
	}
	if len(t.left) == 0 {
		t.left = data
		return
	}
	rest := make([]byte, 0, len(data)+len(t.left))
	rest = append(rest, data...)
	t.left = append(rest, t.left...)
}

// Close releases the underlying body.
func (t *timedReader) Close() error {
	if t == nil || t.rc == nil {
		return nil
	}
	return t.rc.Close()
}

// peekBody reads at most limit bytes, waiting no longer than deadline for the
// client. The second result is the reader the downstream must receive: it
// still yields every byte of the body, including the peeked ones.
func peekBody(rc io.ReadCloser, limit int, deadline time.Time) (data []byte, rest io.ReadCloser, err error) {
	tr := newTimedReader(rc, pullChunk)
	if limit <= 0 {
		return nil, tr, nil
	}
	for len(data) < limit {
		size := limit - len(data)
		if size > tr.chunk {
			size = tr.chunk
		}
		chunk, perr := tr.pull(size, deadline)
		if len(chunk) > 0 {
			data = append(data, chunk...)
			continue
		}
		if perr != nil {
			if errors.Is(perr, errPeekTimeout) {
				return data, tr, nil
			}
			// EOF and read failures both end the peek; the reader keeps
			// reporting the failure to the downstream.
			return data, tr, perr
		}
	}
	return data, tr, nil
}

// bodyReader joins the bytes that were already inspected with the rest of the
// request body.
func bodyReader(prefix []byte, rest io.Reader) io.ReadCloser {
	if len(prefix) == 0 {
		if rc, ok := rest.(io.ReadCloser); ok {
			return rc
		}
		return io.NopCloser(rest)
	}
	return io.NopCloser(io.MultiReader(bytes.NewReader(prefix), rest))
}

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

// rejection describes a request the body policy refused.
type rejection struct {
	// Status is the HTTP status of a non gRPC refusal.
	Status int
	// GRPCCode is the gRPC status of an application/grpc refusal.
	GRPCCode int
	// Message is shown to the client.
	Message string
	// Reason names the decision the refusal comes from.
	Reason string
	// Rule is the web rule that was protected.
	Rule string
}

// Refusal texts. The user facing text of the project is Chinese.
const (
	messageLengthRequired = "请求体没有声明长度（Content-Length），该路由要求完整检查请求体，" +
		"请使用声明了长度的上传方式，或将该路由的请求体策略改为 peek"
	messageSecondMessage       = "该路由声明为 grpc-unary，但请求发送了多条消息"
	messageUnsupportedEncoding = "请求的第一条消息使用了一种无法检查的压缩编码"
)

// writeRejection answers a refused request. A gRPC client must never see an
// HTTP error status: the refusal travels in the gRPC status of a successful
// HTTP response (trailers-only form, grpc-status 7 PERMISSION_DENIED).
func (w *WAF) writeRejection(rw http.ResponseWriter, r *http.Request, rej rejection) {
	if grpcContentType(r) {
		writeGRPCStatus(rw, rej.GRPCCode, rej.Message)
		return
	}
	status := rej.Status
	if status < 400 || status > 599 {
		status = http.StatusForbidden
	}
	h := rw.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	rw.WriteHeader(status)
	_, _ = io.WriteString(rw, rej.Message+"\n")
}

// writeGRPCStatus writes a trailers-only gRPC answer: HTTP 200 with the status
// in the response headers and no body. gRPC clients accept this for a call that
// failed before the server produced a message.
func writeGRPCStatus(rw http.ResponseWriter, code int, message string) {
	h := rw.Header()
	h.Set("Content-Type", "application/grpc")
	h.Set("Grpc-Status", strconv.Itoa(code))
	if message != "" {
		h.Set("Grpc-Message", grpcEncodeMessage(message))
	}
	h.Set("Cache-Control", "no-store")
	rw.WriteHeader(http.StatusOK)
}

// grpcEncodeMessage percent-encodes a status message as the gRPC specification
// requires: printable ASCII may stay, everything else is escaped.
func grpcEncodeMessage(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 0x20 && c <= 0x7e && c != '%' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}
