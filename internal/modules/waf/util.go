package waf

import (
	"fmt"
	"os"

	"github.com/nunt/nunt/internal/netutil"
)

// statFile reports the file information of a host path.
func statFile(p string) (os.FileInfo, error) { return os.Stat(p) }

// readLocalFile reads a host file, used to describe configured rule files.
func readLocalFile(p string) ([]byte, error) {
	abs, err := localPath(p)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(abs)
}

// ruleFileExists reports whether a configured rule file can be read. It is the
// cheap validation used before a path reaches the SecLang parser.
func ruleFileExists(p string) error {
	abs, err := localPath(p)
	if err != nil {
		return err
	}
	info, err := statFile(abs)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("%s is a directory", p)
	}
	return nil
}

// hostOnly strips the port from a Host header.
func hostOnly(host string) string { return netutil.HostOnly(host) }

// maxURILen bounds the request target stored in an event.
const maxURILen = 512

// truncate shortens s to at most n runes.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "..."
}
