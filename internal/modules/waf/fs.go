package waf

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	coreruleset "github.com/corazawaf/coraza-coreruleset/v4"
)

// rulesFS is the SecLang parser root. Names starting with "@" are served from
// the embedded CORERULESET tree, every other name is read from the host file
// system, which is what lets one engine mix the built-in rule set with rule
// files uploaded by the administrator.
//
// The type only implements the read side of fs.FS: rule files are never written
// through it.
type rulesFS struct{}

// crsPath normalises a name for the embedded file system. Windows separators
// and a leading "./" are removed because io/fs only accepts slash separated
// relative paths.
func crsPath(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.TrimPrefix(name, "./")
	if idx := strings.Index(name, "@"); idx > 0 {
		name = name[idx:]
	}
	return name
}

// localPath resolves a host file system path. Relative paths are resolved
// against the process working directory, absolute ones are only cleaned.
func localPath(name string) (string, error) {
	if name == "" {
		return "", errors.New("empty rule file path")
	}
	if strings.ContainsRune(name, 0) {
		return "", errors.New("rule file path contains a NUL byte")
	}
	p := filepath.FromSlash(strings.ReplaceAll(name, "\\", "/"))
	if !filepath.IsAbs(p) {
		abs, err := filepath.Abs(p)
		if err != nil {
			return "", err
		}
		p = abs
	}
	return filepath.Clean(p), nil
}

// Open implements fs.FS.
func (rulesFS) Open(name string) (fs.File, error) {
	if strings.HasPrefix(name, "@") {
		return coreruleset.FS.Open(crsPath(name))
	}
	p, err := localPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	return os.Open(p)
}

// ReadFile implements fs.ReadFileFS.
func (rulesFS) ReadFile(name string) ([]byte, error) {
	if strings.HasPrefix(name, "@") {
		return fs.ReadFile(coreruleset.FS, crsPath(name))
	}
	p, err := localPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "read", Path: name, Err: err}
	}
	return os.ReadFile(p)
}

// ReadDir implements fs.ReadDirFS.
func (rulesFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if strings.HasPrefix(name, "@") {
		return fs.ReadDir(coreruleset.FS, crsPath(name))
	}
	p, err := localPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: err}
	}
	return os.ReadDir(p)
}

// Stat implements fs.StatFS.
func (rulesFS) Stat(name string) (fs.FileInfo, error) {
	if strings.HasPrefix(name, "@") {
		return fs.Stat(coreruleset.FS, crsPath(name))
	}
	p, err := localPath(name)
	if err != nil {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: err}
	}
	return os.Stat(p)
}
