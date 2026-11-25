package config

import (
	"strings"
	"testing"

	"github.com/nunt/nunt/internal/model"
)

func geoConfig(rules ...model.WebRule) *model.Config {
	cfg := Default()
	cfg.Users = []model.User{{ID: "u1"}}
	cfg.Web.Listeners = []model.WebListener{{ID: "l1", Name: "http", Listen: []string{":8080"}}}
	cfg.Web.Rules = rules
	return cfg
}

func geoWebRule(mode string, mutate func(*model.WebRule)) model.WebRule {
	r := model.WebRule{
		ID: "rule-geo", Name: "geo", Enable: true, Type: model.WebTypeProxy,
		ListenerID: "l1", Path: "/geo",
		Proxy:  &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}},
		Access: model.Access{Mode: mode, Geo: []string{"中国"}},
	}
	if mutate != nil {
		mutate(&r)
	}
	return r
}

func TestGeoAccessRequiresDatabaseForEnabledRules(t *testing.T) {
	cfg := geoConfig(geoWebRule(model.AccessAllow, nil))
	if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), "address database") {
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
		"pipe in entry": geoWebRule(model.AccessAllow, func(r *model.WebRule) {
			r.Access.Geo = []string{"中国|美国"}
		}),
		"invalid cidr": geoWebRule(model.AccessAllow, func(r *model.WebRule) {
			r.Access.IPs = []string{"192.168.1.0/33"}
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

func TestNormalizeAccessFlattensLegacyLists(t *testing.T) {
	access := model.Access{
		Mode:      model.AccessAllow,
		Geo:       []string{" 杭州 "},
		Countries: []string{" 中国 ", "中国", "", "美国"},
		Provinces: []string{"浙江省", "浙江", " 北京市 ", "火星"},
	}
	normalizeAccess(&access, true)
	// Known provinces collapse to the short form, legacy lists are merged and
	// cleared, duplicates disappear and a city stays as typed.
	want := "杭州,中国,美国,浙江,北京,火星"
	if got := strings.Join(access.Geo, ","); got != want {
		t.Fatalf("geo = %q, want %q", got, want)
	}
	if len(access.Countries) != 0 || len(access.Provinces) != 0 {
		t.Fatalf("legacy lists must be cleared: %+v", access)
	}
}

func TestNormalizeAccessInherit(t *testing.T) {
	access := model.Access{
		Mode: model.AccessInherit,
		IPs:  []string{"10.0.0.0/8"},
		Geo:  []string{"中国"},
		UAs:  []string{"*bot*"},
	}
	normalizeAccess(&access, true)
	if access.Mode != model.AccessInherit || len(access.IPs) != 0 || len(access.Geo) != 0 || len(access.UAs) != 0 {
		t.Fatalf("an inherited rule must not carry its own lists: %+v", access)
	}
	// Forward rules have no listener to inherit from.
	forward := model.Access{Mode: model.AccessInherit}
	normalizeAccess(&forward, false)
	if forward.Mode != model.AccessOff {
		t.Fatalf("forward inherit = %q, want off", forward.Mode)
	}
}
