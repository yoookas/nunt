//go:build !linux

package sysinfo

// hostStats returns process independent statistics where the standard library
// does not expose them. The dashboard degrades gracefully in that case.
func hostStats(string) *HostStats {
	return nil
}
