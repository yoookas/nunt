//go:build linux

package sysinfo

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func hostStats(diskPath string) *HostStats {
	stats := &HostStats{}

	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
				stats.UptimeSec = int64(v)
			}
		}
	}
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			stats.Load1, _ = strconv.ParseFloat(fields[0], 64)
			stats.Load5, _ = strconv.ParseFloat(fields[1], 64)
			stats.Load15, _ = strconv.ParseFloat(fields[2], 64)
		}
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer func() { _ = f.Close() }()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "MemTotal:"):
				stats.MemTotalBytes = parseKB(line) * 1024
			case strings.HasPrefix(line, "MemAvailable:"):
				stats.MemFreeBytes = parseKB(line) * 1024
			}
		}
	}
	if stats.MemTotalBytes > 0 {
		used := stats.MemTotalBytes - stats.MemFreeBytes
		stats.MemUsedPct = float64(used) / float64(stats.MemTotalBytes) * 100
	}
	if diskPath == "" {
		diskPath = "/"
	}
	var fsStat syscall.Statfs_t
	if err := syscall.Statfs(diskPath, &fsStat); err == nil {
		stats.DiskPath = diskPath
		stats.DiskTotalBytes = fsStat.Blocks * uint64(fsStat.Bsize)
		stats.DiskFreeBytes = fsStat.Bavail * uint64(fsStat.Bsize)
	}
	return stats
}

func parseKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	v, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return v
}
