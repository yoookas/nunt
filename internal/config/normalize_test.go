package config

import (
	"testing"

	"github.com/nunt/nunt/internal/model"
)

// The renewal window is capped while the configuration is normalised so an old
// configuration that asked for 365 days cannot renew a 90 day certificate on
// every check.
func TestNormalizeCapsRenewDays(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{0, 30}, {365, 30}, {7, 7}} {
		cfg := Default()
		cfg.ACME.Jobs = []model.CertJob{{
			ID: "job-1", Domains: []string{"a.example.com"}, RenewDays: tc.in,
		}}
		Normalize(cfg)
		if got := cfg.ACME.Jobs[0].RenewDays; got != tc.want {
			t.Fatalf("renewDays %d normalised to %d, want %d", tc.in, got, tc.want)
		}
	}
}
