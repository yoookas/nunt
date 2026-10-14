package waf

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// This file implements the gRPC path of the body policy: a pull driven scanner
// that validates the length prefixed frames of an application/grpc request and
// buffers exactly one message, the one that is inspected before the upstream is
// contacted.
//
// A gRPC frame is five bytes (a compressed flag and a big endian length)
// followed by the message. The first message is inspected; the frames that
// follow are validated while they are streamed, which is the documented
// capability boundary of a streaming route (see docs/PLAN-waf-body-policy.md).

// gRPC frame layout and limits.
const (
	grpcHeaderLen = 5
	// maxGRPCMessageBytes caps one gRPC message. It is also the cap of the
	// decompression of a compressed message, so a small frame can never expand
	// into an unbounded buffer.
	maxGRPCMessageBytes = 4 << 20
)

// Message encodings the scanner understands.
const (
	grpcIdentityEncoding = "identity"
	grpcGzipEncoding     = "gzip"
)

// gRPC status codes used by the module.
const (
	grpcStatusPermissionDenied  = 7
	grpcStatusResourceExhausted = 8
)

// Frame layer sentinel errors. A proxy error handler recognises them through
// FrameFailure and answers with the gRPC status the protocol expects instead of
// reporting an upstream failure.
var (
	// ErrFrameMalformed reports a frame that is not a valid gRPC frame.
	ErrFrameMalformed = errors.New("waf: malformed grpc frame")
	// ErrMessageTooLarge reports a message above maxGRPCMessageBytes.
	ErrMessageTooLarge = errors.New("waf: grpc message exceeds the size limit")
	// ErrTruncatedStream reports a stream that ended inside a frame.
	ErrTruncatedStream = errors.New("waf: truncated grpc stream")
	// ErrUnexpectedMessage reports a second message on a route declared unary.
	ErrUnexpectedMessage = errors.New("waf: a unary grpc route received a second message")
)

// bodyFailureKinds lists the failures FrameFailure recognises.
var bodyFailureKinds = []error{ErrFrameMalformed, ErrMessageTooLarge, ErrTruncatedStream, ErrUnexpectedMessage}

// errEncodingUnsupported reports a compressed message whose encoding cannot be
// decoded, so the message cannot be inspected at all. It is answered as a
// policy refusal (fail closed), never as a frame error.
var errEncodingUnsupported = errors.New("waf: the compression of the grpc message cannot be inspected")

// Refusal texts of the frame layer (the user facing text is Chinese).
const (
	messageFrameMalformed = "请求体不是合法的 gRPC 帧"
	messageTooLarge       = "gRPC 消息超过大小上限"
	messageTruncated      = "gRPC 流在帧中间结束"
)

// RequestMeta describes the request a message belongs to.
type RequestMeta struct {
	ClientIP    string
	ClientPort  int
	Method      string
	URI         string
	Proto       string
	Host        string
	ContentType string
	Headers     http.Header
	// Rule is the web rule that protects the request.
	Rule string
}

// Verdict is what a BodyInspector decided about one message.
type Verdict struct {
	// Blocked is true when the message must be refused.
	Blocked bool
	// Status is the HTTP status the refusal would use.
	Status  int
	Action  string
	RuleID  int
	Message string
	TxID    string
	// Matched lists the rules that matched the message.
	Matched []ruleHit
}

// BodyInspector inspects one request body message. Per message CRS checks (D),
// an ext_proc call or a descriptor check implement it; the module ships the
// Coraza engine as its default implementation.
type BodyInspector interface {
	Inspect(ctx context.Context, meta RequestMeta, msg []byte, index int) (Verdict, error)
}

// messageSink is the slot every buffered message is handed to. The module
// installs its BodyInspector here and a future per message inspector plugs into
// the same slot; returning an error stops the scan.
type messageSink func(msg []byte, index int) error

// grpcMessage is one message that was buffered by the scanner.
type grpcMessage struct {
	// payload is the message content, decompressed when the frame announced a
	// supported compression.
	payload []byte
	// decoded is false when the compression of the message is not supported;
	// payload then still holds the compressed bytes.
	decoded bool
	// index is the position of the message in the stream, starting at zero.
	index int
	// encoding is the message encoding the client declared.
	encoding string
	// compressed records that the frame announced a compressed message.
	compressed bool
}

// grpcScanner pulls the messages of one gRPC request body. It buffers at most
// one message at a time: the one that is being inspected.
type grpcScanner struct {
	src *timedReader
	// maxMsg caps one message.
	maxMsg int64
	// unary refuses a second message on a route declared grpc-unary.
	unary bool
	// sink receives every buffered message; nil when nothing is inspected.
	sink messageSink
	// fail records a failure that ends the request.
	fail func(BodyFailure)
	// observe records a policy violation that is only reported (observe mode).
	// When it is nil a policy violation ends the request.
	observe func(BodyFailure)

	// replay holds raw bytes that were pulled from the source and still have to
	// be handed to the downstream.
	replay []byte
	// header is the header of the frame that is being streamed, hlen how many
	// of its bytes were read.
	header [grpcHeaderLen]byte
	hlen   int
	// remaining counts the payload bytes of the current frame that were not
	// delivered yet.
	remaining int64
	// index counts the messages whose header was accepted.
	index int
	// sawEOF records that the body ended.
	sawEOF bool
	// err is the sticky failure that ended the scan.
	err error
}

// newGRPCScanner wraps a request body. unary selects the rule that refuses a
// second message.
func newGRPCScanner(src *timedReader, unary bool) *grpcScanner {
	return &grpcScanner{src: src, maxMsg: maxGRPCMessageBytes, unary: unary}
}

// Read implements io.ReadCloser for the downstream handler. Buffered bytes are
// served first, every frame after the first message is validated while it is
// streamed.
func (s *grpcScanner) Read(p []byte) (int, error) {
	if s.err != nil {
		return 0, s.err
	}
	return s.stream(p)
}

// Close releases the request body.
func (s *grpcScanner) Close() error { return s.src.Close() }

// stream forwards the frames that follow the buffered message.
//
// Every byte that is pulled from the source is queued in the replay buffer
// before it is served, so the header of a frame reaches the downstream whether
// it was already read while probing for the end of the request or arrives just
// now.
func (s *grpcScanner) stream(p []byte) (int, error) {
	for {
		if len(s.replay) > 0 {
			n := copy(p, s.replay)
			s.replay = s.replay[n:]
			return n, nil
		}
		if len(p) == 0 {
			return 0, nil
		}
		if s.remaining > 0 {
			n, err := s.src.Read(p)
			if n > 0 {
				if int64(n) > s.remaining {
					// The source handed out more than the frame declares; the
					// surplus belongs to the next frame.
					s.src.unread(p[s.remaining:n])
					n = int(s.remaining)
				}
				s.remaining -= int64(n)
				return n, nil
			}
			if err == nil {
				continue
			}
			return 0, s.stop(ErrTruncatedStream)
		}
		if s.hlen == grpcHeaderLen {
			if err := s.startFrame(); err != nil {
				return 0, err
			}
			continue
		}
		n, err := s.src.Read(s.header[s.hlen:grpcHeaderLen])
		if n > 0 {
			s.hlen += n
			s.replay = append(s.replay, s.header[s.hlen-n:s.hlen]...)
		}
		if s.hlen < grpcHeaderLen {
			if err == nil {
				continue
			}
			if errors.Is(err, io.EOF) && s.hlen == 0 {
				s.sawEOF = true
				return 0, io.EOF
			}
			return 0, s.stop(ErrTruncatedStream)
		}
		if errors.Is(err, io.EOF) {
			s.sawEOF = true
		}
		if err := s.startFrame(); err != nil {
			return 0, err
		}
	}
}

// first pulls the first message of the stream, waiting no longer than deadline.
//
// It reports errPeekTimeout when the client did not send a complete message in
// time: a stream the server is expected to open, which the caller forwards
// untouched. An io.EOF means the body was empty. Everything that was pulled
// stays in the replay buffer, so the caller can forward the request whichever
// way the scan ended.
func (s *grpcScanner) first(deadline time.Time, encoding string) (*grpcMessage, error) {
	s.hlen = 0
	for s.hlen < grpcHeaderLen {
		chunk, err := s.src.pull(grpcHeaderLen-s.hlen, deadline)
		if len(chunk) > 0 {
			n := copy(s.header[s.hlen:], chunk)
			s.hlen += n
			s.replay = append(s.replay, chunk[:n]...)
			if n < len(chunk) {
				s.src.unread(chunk[n:])
			}
			continue
		}
		if err == nil {
			continue
		}
		switch {
		case errors.Is(err, errPeekTimeout):
			return nil, errPeekTimeout
		case errors.Is(err, io.EOF):
			if s.hlen == 0 {
				s.sawEOF = true
				return nil, io.EOF
			}
			return nil, s.stop(ErrTruncatedStream)
		default:
			return nil, err
		}
	}
	msg, err := s.message(deadline, encoding)
	if err != nil {
		return nil, err
	}
	// A message whose compression could not be decoded is not handed to an
	// inspector: judging compressed bytes would only produce noise, and the
	// caller decides what an uninspectable message means.
	if s.sink != nil && msg.decoded {
		if serr := s.sink(msg.payload, msg.index); serr != nil {
			return nil, serr
		}
	}
	return msg, nil
}

// message reads and decodes the message of the buffered frame header.
func (s *grpcScanner) message(deadline time.Time, encoding string) (*grpcMessage, error) {
	flags := s.header[0]
	if flags > 1 {
		return nil, s.stop(ErrFrameMalformed)
	}
	length := int64(binary.BigEndian.Uint32(s.header[1:grpcHeaderLen]))
	if length > s.maxMsg {
		return nil, s.stop(ErrMessageTooLarge)
	}
	payload := make([]byte, 0, length)
	for int64(len(payload)) < length {
		chunk, err := s.src.pull(int(length)-len(payload), deadline)
		if len(chunk) > 0 {
			need := int(length) - len(payload)
			if len(chunk) > need {
				s.src.unread(chunk[need:])
				chunk = chunk[:need]
			}
			payload = append(payload, chunk...)
			s.replay = append(s.replay, chunk...)
			continue
		}
		if err == nil {
			continue
		}
		if errors.Is(err, errPeekTimeout) {
			// The frame is only half here: hand what arrived to the downstream
			// and let it stream the rest of the frame.
			s.hlen = 0
			s.remaining = length - int64(len(payload))
			s.index = 1
			return nil, errPeekTimeout
		}
		if errors.Is(err, io.EOF) {
			return nil, s.stop(ErrTruncatedStream)
		}
		return nil, err
	}
	s.hlen = 0
	s.index = 1
	decoded, ok, err := decodeMessage(payload, flags == 1, encoding, s.maxMsg)
	if err != nil {
		return nil, s.stop(err)
	}
	return &grpcMessage{
		payload:    decoded,
		decoded:    ok,
		index:      0,
		encoding:   encoding,
		compressed: flags == 1,
	}, nil
}

// complete probes one further byte to learn whether the message that was just
// buffered ended the request body. EOF means the whole request was read (unary
// or server streaming); a byte means another frame follows, and that byte
// becomes the first byte of its header. Anything else (a timeout, a read error)
// is reported as "not complete": the client simply has not sent more yet.
func (s *grpcScanner) complete(deadline time.Time) bool {
	if s.sawEOF || s.err != nil {
		return s.sawEOF
	}
	chunk, err := s.src.pull(1, deadline)
	if len(chunk) > 0 {
		s.header[0] = chunk[0]
		s.hlen = 1
		s.replay = append(s.replay, chunk[0])
		if len(chunk) > 1 {
			s.src.unread(chunk[1:])
		}
		return false
	}
	if errors.Is(err, io.EOF) {
		s.sawEOF = true
		return true
	}
	return false
}

// startFrame validates the header of the frame that is about to be streamed.
func (s *grpcScanner) startFrame() error {
	flags := s.header[0]
	if flags > 1 {
		return s.stop(ErrFrameMalformed)
	}
	length := int64(binary.BigEndian.Uint32(s.header[1:grpcHeaderLen]))
	if length > s.maxMsg {
		return s.stop(ErrMessageTooLarge)
	}
	if s.index >= 1 && s.unary {
		f := failureFor(ErrUnexpectedMessage)
		if s.observe == nil {
			return s.stop(f.Kind)
		}
		s.observe(f)
	}
	s.hlen = 0
	s.remaining = length
	s.index++
	return nil
}

// stop records a frame failure and returns the sentinel error the body reader
// hands to the proxy.
func (s *grpcScanner) stop(kind error) error {
	if s.err == nil {
		s.err = kind
	}
	if s.fail != nil {
		s.fail(failureFor(s.err))
	}
	return s.err
}

// decodeMessage returns the bytes an inspector must look at. A gzip message is
// decompressed under the message size cap, so a small frame can never hide a
// large payload from the inspection; any other compression is reported as not
// decoded so the caller can fail closed.
func decodeMessage(payload []byte, compressed bool, encoding string, limit int64) ([]byte, bool, error) {
	if !compressed {
		return payload, true, nil
	}
	if encoding != grpcGzipEncoding {
		return payload, false, nil
	}
	return gunzipMessage(payload, limit)
}

// gunzipMessage decodes a compressed message and refuses anything that expands
// beyond the message size cap.
func gunzipMessage(data []byte, limit int64) ([]byte, bool, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrFrameMalformed, err)
	}
	defer func() { _ = zr.Close() }()
	out, err := io.ReadAll(io.LimitReader(zr, limit+1))
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrFrameMalformed, err)
	}
	if int64(len(out)) > limit {
		return nil, false, ErrMessageTooLarge
	}
	return out, true, nil
}

// ---------------------------------------------------------------------------
// failures handed to the proxy error handler
// ---------------------------------------------------------------------------

// BodyFailure describes a frame or policy failure of a request body.
type BodyFailure struct {
	// Kind is the sentinel error the body reader stopped on.
	Kind error
	// GRPCCode is the gRPC status of the refusal.
	GRPCCode int
	// Status is the HTTP status used when the request is not gRPC.
	Status int
	// Message is shown to the client.
	Message string
}

// failureFor maps a sentinel error to the answer the client must get.
func failureFor(kind error) BodyFailure {
	switch {
	case errors.Is(kind, ErrMessageTooLarge):
		return BodyFailure{Kind: ErrMessageTooLarge, GRPCCode: grpcStatusResourceExhausted,
			Status: http.StatusRequestEntityTooLarge, Message: messageTooLarge}
	case errors.Is(kind, ErrTruncatedStream):
		return BodyFailure{Kind: ErrTruncatedStream, GRPCCode: grpcStatusResourceExhausted,
			Status: http.StatusBadRequest, Message: messageTruncated}
	case errors.Is(kind, ErrUnexpectedMessage):
		return BodyFailure{Kind: ErrUnexpectedMessage, GRPCCode: grpcStatusPermissionDenied,
			Status: http.StatusForbidden, Message: messageSecondMessage}
	default:
		return BodyFailure{Kind: ErrFrameMalformed, GRPCCode: grpcStatusResourceExhausted,
			Status: http.StatusBadRequest, Message: messageFrameMalformed}
	}
}

// failureSlot carries the failure of one request body from the reader, which
// runs inside the proxy transport, to the proxy error handler.
type failureSlot struct {
	failure atomic.Pointer[BodyFailure]
}

func (s *failureSlot) set(f BodyFailure) { s.failure.Store(&f) }

// failureKey is the context key of the slot.
type failureKey struct{}

// withFailureSlot returns a request carrying the slot the body reader fills in.
func withFailureSlot(r *http.Request) (*http.Request, *failureSlot) {
	slot := &failureSlot{}
	return r.WithContext(context.WithValue(r.Context(), failureKey{}, slot)), slot
}

// FrameFailure reports the body failure a failed upstream request ran into. A
// proxy error handler calls it with the request it was given and the error the
// transport returned; the sentinel errors of the frame layer are recognised
// both directly and through the request, because a transport may wrap them
// beyond recognition.
func FrameFailure(r *http.Request, err error) (BodyFailure, bool) {
	for _, kind := range bodyFailureKinds {
		if errors.Is(err, kind) {
			return failureFor(kind), true
		}
	}
	if r != nil {
		if slot, ok := r.Context().Value(failureKey{}).(*failureSlot); ok {
			if f := slot.failure.Load(); f != nil {
				return *f, true
			}
		}
	}
	return BodyFailure{}, false
}

// WriteFrameFailure answers a request whose body violated the frame layer. A
// gRPC client gets the gRPC status of the failure, every other request the
// matching HTTP status.
func WriteFrameFailure(rw http.ResponseWriter, r *http.Request, f BodyFailure) {
	if grpcContentType(r) {
		writeGRPCStatus(rw, f.GRPCCode, f.Message)
		return
	}
	status := f.Status
	if status < 400 || status > 599 {
		status = http.StatusBadRequest
	}
	http.Error(rw, f.Message, status)
}
