package rest

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// APIError is the error envelope returned by every endpoint.
type APIError struct {
	Error struct {
		Message string `json:"message"`
		Code    string `json:"code,omitempty"`
		Details any    `json:"details,omitempty"`
	} `json:"error"`
}

// MaxBodyBytes is the default request body limit for JSON endpoints.
const MaxBodyBytes = 2 << 20

// JSON writes v as a JSON response.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	if err := enc.Encode(v); err != nil {
		// The response is already committed; nothing sensible is left to do.
		return
	}
}

// OK writes 200 with v.
func OK(w http.ResponseWriter, v any) { JSON(w, http.StatusOK, v) }

// Fail writes an error envelope.
func Fail(w http.ResponseWriter, status int, format string, args ...any) {
	var e APIError
	e.Error.Message = fmt.Sprintf(format, args...)
	JSON(w, status, e)
}

// FailCode writes an error envelope with a machine readable code.
func FailCode(w http.ResponseWriter, status int, code, format string, args ...any) {
	var e APIError
	e.Error.Message = fmt.Sprintf(format, args...)
	e.Error.Code = code
	JSON(w, status, e)
}

// Decode reads a JSON body into v, rejecting oversized payloads.
func Decode(w http.ResponseWriter, r *http.Request, v any) error {
	return DecodeLimit(w, r, v, MaxBodyBytes)
}

// DecodeLimit reads a JSON body with a custom size limit.
func DecodeLimit(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	if r.Body == nil {
		return errors.New("empty request body")
	}
	ct := r.Header.Get("Content-Type")
	if ct != "" && !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		return fmt.Errorf("unsupported content type %q", ct)
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return fmt.Errorf("request body exceeds %d bytes", limit)
		}
		if errors.Is(err, io.EOF) {
			return errors.New("empty request body")
		}
		return fmt.Errorf("invalid json body: %w", err)
	}
	return nil
}

// NoContent writes an empty 204 response.
func NoContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }
