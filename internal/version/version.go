// Package version carries build metadata injected at compile time.
package version

import "runtime"

// These values are overridden with -ldflags "-X ...".
var (
	Name      = "nunt"
	Version   = "dev"
	Commit    = "none"
	BuildTime = "unknown"
)

// Info is a serialisable description of the running build.
type Info struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
	GoVersion string `json:"goVersion"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

// Get returns the build information of the current process.
func Get() Info {
	return Info{
		Name:      Name,
		Version:   Version,
		Commit:    Commit,
		BuildTime: BuildTime,
		GoVersion: runtime.Version(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
	}
}
