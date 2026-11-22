package config

import (
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

func geoConfig(rules ...model.WebRule) *model.Config {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1", Username: "admin", Role: "admin", Enabled: true}}
	cfg.Web.Rules = rules
	return cfg
}

func geoWebRule(mode string, mutate func(*model.WebRule)) model.WebRule {
	r := model.WebRule{
		ID: "rule-geo", Name: "geo", Enable: true, Type: model.WebTypeProxy,
		Listen: []string{":8080"}, Path: "/geo",
		Proxy:  &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}},
		Access: model.Access{Mode: mode, Countries: []string{"中国"}},
	}
	if mutate != nil {
		mutate(&r)
	}
	return r
}

func TestGeoAccessRequiresDatabaseForEnabledRules(t *testing.T) {
	cfg := geoConfig(geoWebRule(model.AccessAllow, nil))
	if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), "ip2regionDb") {
		t.Fatalf("enabled geo rule without a database = %v", err)
	}

	cfg.System.IP2RegionDB = "/data/geoip/ip2region.xdb"
	if err := Validate(cfg); err != nil {
		t.Fatalf("geo rule with a database must validate: %v", err)
	}

	// A disabled draft does not need the database yet.
	draft := geoWebRule(model.AccessAllow, func(r *model.WebRule) { r.Enable = false })
	if err := Validate(geoConfig(draft)); err != nil {
		t.Fatalf("disabled geo rule = %v", err)
	}
}

func TestGeoAccessValidation(t *testing.T) {
	cases := map[string]model.WebRule{
		"off mode": geoWebRule(model.AccessOff, nil),
		"unknown province": geoWebRule(model.AccessAllow, func(r *model.WebRule) {
			r.Access.Provinces = []string{"火星"}
		}),
		"pipe in country": geoWebRule(model.AccessAllow, func(r *model.WebRule) {
			r.Access.Countries = []string{"中国|美国"}
		}),
	}
	for name, rule := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := geoConfig(rule)
			cfg.System.IP2RegionDB = "/data/geoip/ip2region.xdb"
			if err := Validate(cfg); err == nil {
				t.Fatalf("%s must be rejected", name)
			}
		})
	}
}

func TestNormalizeGeoAccess(t *testing.T) {
	access := model.Access{
		Mode:      model.AccessAllow,
		Countries: []string{" 中国 ", "中国", "", "美国"},
		Provinces: []string{"浙江省", "浙江", " 北京市 ", "火星"},
	}
	normalizeGeoAccess(&access)
	if got := strings.Join(access.Countries, ","); got != "中国,美国" {
		t.Fatalf("countries = %q", got)
	}
	// Unknown provinces are kept for Validate to reject; known ones collapse
	// to the short form.
	if got := strings.Join(access.Provinces, ","); got != "浙江,北京,火星" {
		t.Fatalf("provinces = %q", got)
	}
}
