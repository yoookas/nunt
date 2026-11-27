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
	stats.Disks = collectDisks()
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

// collectDisks lists the mounted local file systems (one entry per device, at
// most eight, so the overview stays readable).
func collectDisks() []DiskStat {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := make([]DiskStat, 0, 4)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[0], "/dev/") {
			continue
		}
		if seen[fields[0]] {
			continue
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(fields[1], &stat); err != nil {
			continue
		}
		total := stat.Blocks * uint64(stat.Bsize)
		if total == 0 {
			continue
		}
		seen[fields[0]] = true
		out = append(out, DiskStat{
			Path:       fields[1],
			TotalBytes: total,
			FreeBytes:  stat.Bavail * uint64(stat.Bsize),
		})
		if len(out) >= 8 {
			break
		}
	}
	return out
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
