package waf

import (
	"path"
	"runtime"
	"strings"
	"sync"

	"github.com/corazawaf/coraza/v3/experimental/plugins"
)

// pathTransformsOnce guards installPathTransforms.
var pathTransformsOnce sync.Once

// installPathTransforms replaces the Coraza path normalisation transformations
// on Windows.
//
// Coraza implements t:normalizePath with filepath.Clean, which on Windows
// rewrites every "/" into "\". The OWASP rule set is written for POSIX paths:
// its data files contain entries such as "etc/passwd" or "bin/sh", and the
// rules match them against normalised values. On Windows the rewritten value no
// longer contains those substrings, so whole rule families (932 remote command
// execution, 933 PHP injection, ...) silently stop matching.
//
// The replacements keep the Coraza contract - clean the path and report whether
// it changed - while using slash semantics, which is what the rule set expects
// and what the built-in implementation already does on other platforms. They
// are only installed on Windows.
func installPathTransforms() {
	if runtime.GOOS != "windows" {
		return
	}
	pathTransformsOnce.Do(func() {
		plugins.RegisterTransformation("normalizePath", normalizePathSlash)
		plugins.RegisterTransformation("normalizePathWin", normalizePathWindows)
	})
}

// normalizePathSlash is the slash separated equivalent of the built-in
// normalizePath transformation. The second result reports whether the value
// changed.
func normalizePathSlash(data string) (string, bool, error) {
	if data == "" {
		return data, false, nil
	}
	clean := path.Clean(data)
	if clean == "." {
		return "", true, nil
	}
	if strings.HasSuffix(data, "/") && !strings.HasSuffix(clean, "/") {
		clean += "/"
	}
	return clean, clean != data, nil
}

// normalizePathWindows is the Windows variant: backslashes are folded into
// slashes and the path components Windows resolves away (alternate data stream
// suffixes and trailing dots or spaces) are removed.
func normalizePathWindows(data string) (string, bool, error) {
	if data == "" {
		return data, false, nil
	}
	slashed, _, err := normalizePathSlash(strings.ReplaceAll(data, "\\", "/"))
	if err != nil {
		return slashed, false, err
	}
	out := stripWindowsSuffixes(slashed)
	return out, out != data, nil
}

// stripWindowsSuffixes drops the parts of a slash separated path that the
// Windows file API resolves away: an alternate data stream suffix on the last
// component ("file.txt::$DATA" opens "file.txt") and trailing dots or spaces of
// every component ("file.txt." opens "file.txt").
func stripWindowsSuffixes(p string) string {
	trailing := ""
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		trailing, p = "/", strings.TrimSuffix(p, "/")
	}
	parts := strings.Split(p, "/")
	kept := make([]string, 0, len(parts))
	for i, seg := range parts {
		if i == len(parts)-1 && !isDriveLetter(seg) {
			if idx := strings.IndexByte(seg, ':'); idx > 0 {
				seg = seg[:idx]
			}
		}
		if seg != "" && strings.Trim(seg, ".") != "" {
			seg = strings.TrimRight(seg, ". ")
		}
		if seg == "" && i != 0 && i != len(parts)-1 {
			// A component that resolved to nothing is dropped, like Windows
			// does, instead of leaving a double slash behind.
			continue
		}
		kept = append(kept, seg)
	}
	return strings.Join(kept, "/") + trailing
}

// isDriveLetter reports whether a component is a Windows volume such as "C:".
func isDriveLetter(seg string) bool {
	if len(seg) != 2 || seg[1] != ':' {
		return false
	}
	c := seg[0]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
