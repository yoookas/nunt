// Package sysinfo collects the runtime statistics shown on the dashboard.
package sysinfo

import (
	"os"
	"runtime"
	"time"
)

var started = time.Now()

// Info is the dashboard payload.
type Info struct {
	Hostname   string     `json:"hostname"`
	OS         string     `json:"os"`
	Arch       string     `json:"arch"`
	NumCPU     int        `json:"numCpu"`
	Goroutines int        `json:"goroutines"`
	HeapBytes  uint64     `json:"heapBytes"`
	SysBytes   uint64     `json:"sysBytes"`
	StartTime  time.Time  `json:"startTime"`
	UptimeSec  int64      `json:"uptimeSec"`
	Host       *HostStats `json:"host,omitempty"`
}

// HostStats carries operating system statistics when available.
type HostStats struct {
	UptimeSec      int64   `json:"uptimeSec,omitempty"`
	Load1          float64 `json:"load1,omitempty"`
	Load5          float64 `json:"load5,omitempty"`
	Load15         float64 `json:"load15,omitempty"`
	MemTotalBytes  uint64  `json:"memTotalBytes,omitempty"`
	MemFreeBytes   uint64  `json:"memFreeBytes,omitempty"`
	MemUsedPct     float64 `json:"memUsedPct,omitempty"`
	DiskTotalBytes uint64  `json:"diskTotalBytes,omitempty"`
	DiskFreeBytes  uint64  `json:"diskFreeBytes,omitempty"`
	DiskPath       string  `json:"diskPath,omitempty"`
}

// Collect gathers a snapshot of the current state.
func Collect(diskPath string) Info {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	hostname, _ := os.Hostname()
	info := Info{
		Hostname:   hostname,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		NumCPU:     runtime.NumCPU(),
		Goroutines: runtime.NumGoroutine(),
		HeapBytes:  ms.HeapAlloc,
		SysBytes:   ms.Sys,
		StartTime:  started,
		UptimeSec:  int64(time.Since(started).Seconds()),
	}
	info.Host = hostStats(diskPath)
	return info
}
