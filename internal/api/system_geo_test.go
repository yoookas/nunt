package api

import (
	"net/http"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// The system settings form no longer edits the address database (it lives on
// its own page and endpoint). Because handleUpdateSettings replaces the whole
// SystemConfig, a save from that form must not clear the stored path.
func TestUpdateSettingsKeepsTheConfiguredAddressDatabase(t *testing.T) {
	env := newTestEnv(t)
	cookies, csrf := login(t, env)

	const dbPath = "/data/geoip/ip2region.xdb"
	if err := env.store.Update(func(c *model.Config) error {
		c.System.IP2RegionDB = dbPath
		return nil
	}); err != nil {
		t.Fatalf("seed address database path: %v", err)
	}

	settings := currentSettings(env)
	settings.IP2RegionDB = "" // what the trimmed-down form sends
	settings.LogLevel = "debug"
	rec := env.do(t, http.MethodPut, "/api/v1/system/settings", settings, cookies,
		map[string]string{"X-CSRF-Token": csrf})
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /system/settings = %d: %s", rec.Code, rec.Body.String())
	}
	if got := env.store.Snapshot().System.IP2RegionDB; got != dbPath {
		t.Fatalf("stored ip2regionDb = %q, want it preserved as %q", got, dbPath)
	}
	if got := env.store.Snapshot().System.LogLevel; got != "debug" {
		t.Fatalf("the unrelated field did not save: logLevel = %q", got)
	}
}
