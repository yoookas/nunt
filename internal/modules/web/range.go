package web

import (
	"errors"
	"strconv"
	"strings"
)

// errRangeNotSatisfiable reports a syntactically valid range that cannot be
// served for the requested size.
var errRangeNotSatisfiable = errors.New("range not satisfiable")

// errInvalidRange reports a malformed Range header.
var errInvalidRange = errors.New("invalid range header")

// parseRange interprets a Range header. It returns the offset of the first
// byte and the number of bytes to send; partial reports whether a 206 reply
// must be produced.
func parseRange(header string, size int64) (start, length int64, partial bool, err error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, size, false, nil
	}
	if !strings.HasPrefix(header, "bytes=") {
		return 0, size, false, nil // an unknown unit is ignored, as in net/http
	}
	specs := strings.Split(header[len("bytes="):], ",")
	if len(specs) != 1 {
		// Multipart ranges are not supported; serving the whole entity is a
		// valid answer for any range request.
		return 0, size, false, nil
	}
	spec := strings.TrimSpace(specs[0])
	if spec == "" {
		return 0, size, false, errInvalidRange
	}
	dash := strings.Index(spec, "-")
	if dash < 0 {
		return 0, size, false, errInvalidRange
	}
	first, last := strings.TrimSpace(spec[:dash]), strings.TrimSpace(spec[dash+1:])
	switch {
	case first == "":
		// Suffix range: the last n bytes.
		n, perr := strconv.ParseInt(last, 10, 64)
		if perr != nil || n < 0 {
			return 0, size, false, errInvalidRange
		}
		if n == 0 {
			return 0, 0, false, errRangeNotSatisfiable
		}
		if n > size {
			n = size
		}
		return size - n, n, true, nil
	default:
		s, perr := strconv.ParseInt(first, 10, 64)
		if perr != nil || s < 0 {
			return 0, size, false, errInvalidRange
		}
		if s >= size {
			return 0, 0, false, errRangeNotSatisfiable
		}
		if last == "" {
			return s, size - s, true, nil
		}
		e, perr := strconv.ParseInt(last, 10, 64)
		if perr != nil || e < s {
			return 0, size, false, errInvalidRange
		}
		if e >= size {
			e = size - 1
		}
		return s, e - s + 1, true, nil
	}
}
