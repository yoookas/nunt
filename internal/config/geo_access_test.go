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
	// The store normalises before it validates; do the same so the fixtures do
	// not have to spell out every default.
	Normalize(cfg)
	return cfg
}

func geoWebRule(action string, mutate func(*model.WebRule)) model.WebRule {
	r := model.WebRule{
		ID: "rule-geo", Name: "geo", Enable: true, Type: model.WebTypeProxy,
		ListenerID: "l1", Path: "/geo",
		Proxy: &model.ProxyTarget{Targets: []string{"http://127.0.0.1:9000"}},
		Access: model.Access{
			Mode: model.AccessRules,
			IP: model.AccessList{
				Rest:    model.AccessDeny,
				Entries: []model.AccessEntry{{Action: action, Kind: model.AccessKindGeo, Value: "中国"}},
			},
			UA: model.AccessList{Rest: model.AccessAllow},
		},
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

	// A disabled rule is not served, so it may keep a geo entry without the
	// database being configured.
	draft := geoWebRule(model.AccessAllow, func(r *model.WebRule) { r.Enable = false })
	draftCfg := geoConfig(draft)
	if err := Validate(draftCfg); err != nil {
		t.Fatalf("disabled geo rule must validate without a database: %v", err)
	}
}

func TestAccessRuleValidation(t *testing.T) {
	cfg := geoConfig(geoWebRule(model.AccessAllow, func(r *model.WebRule) {
		r.Access.IP.Entries[0].Value = "中国|美国"
	}))
	if err := Validate(cfg); err == nil {
		t.Fatal("a geo entry containing a pipe must be rejected")
	}

	cfg = geoConfig(geoWebRule(model.AccessAllow, func(r *model.WebRule) {
		r.Access.IP.Entries[0] = model.AccessEntry{Action: model.AccessAllow, Kind: model.AccessKindIP, Value: "192.168.1.0/33"}
	}))
	if err := Validate(cfg); err == nil || !strings.Contains(err.Error(), "address rule 1") {
		t.Fatalf("an invalid CIDR must be rejected with its position: %v", err)
	}

	cfg = geoConfig(geoWebRule(model.AccessAllow, func(r *model.WebRule) {
		r.Access.IP.Entries[0].Action = "maybe"
	}))
	if err := Validate(cfg); err == nil {
		t.Fatal("an unknown action must be rejected")
	}

	cfg = geoConfig(geoWebRule(model.AccessAllow, func(r *model.WebRule) {
		r.Access.IP.Entries[0].Kind = "dns"
	}))
	if err := Validate(cfg); err == nil {
		t.Fatal("an unknown kind must be rejected")
	}
}

func TestNormalizeAccessFillsTheRestAndKeepsTheOrder(t *testing.T) {
	access := model.Access{
		Mode: "RULES",
		IP: model.AccessList{Entries: []model.AccessEntry{
			{Action: "ALLOW", Kind: "", Value: " 10.0.0.0/8 "},
			{Action: "deny", Kind: "geo", Value: " 杭州 "},
		}},
		UA: model.AccessList{Entries: []model.AccessEntry{{Action: "deny", Value: " curl "}}},
	}
	normalizeAccess(&access, true, true)

	if access.Mode != model.AccessRules {
		t.Fatalf("mode = %q", access.Mode)
	}
	if access.IP.Rest != model.AccessDeny || access.UA.Rest != model.AccessDeny {
		t.Fatalf("rest defaults = %q/%q, want deny/deny", access.IP.Rest, access.UA.Rest)
	}
	// The kind is inferred from the value when it is missing.
	if access.IP.Entries[0].Kind != model.AccessKindIP {
		t.Fatalf("first entry kind = %q, want ip", access.IP.Entries[0].Kind)
	}
	if access.IP.Entries[0].Action != model.AccessAllow {
		t.Fatalf("first entry action = %q, want allow", access.IP.Entries[0].Action)
	}
	// The order is preserved, and a province is stored in its short form.
	if access.IP.Entries[1].Value != "杭州" || access.IP.Entries[1].Kind != model.AccessKindGeo {
		t.Fatalf("second entry = %+v", access.IP.Entries[1])
	}
	if access.UA.Entries[0].Kind != model.AccessKindUA || access.UA.Entries[0].Value != "curl" {
		t.Fatalf("client entry = %+v", access.UA.Entries[0])
	}
}

func TestNormalizeAccessInheritAndForward(t *testing.T) {
	inherit := model.Access{
		Mode: model.AccessInherit,
		IP:   model.AccessList{Rest: model.AccessAllow, Entries: []model.AccessEntry{{Action: "allow", Kind: "ip", Value: "10.0.0.0/8"}}},
	}
	normalizeAccess(&inherit, true, true)
	if len(inherit.IP.Entries) != 0 {
		t.Fatalf("an inherited rule must not carry a list: %+v", inherit.IP)
	}

	// A forward rule has no user agent, so the client list is cleared and left
	// as "allow everything" instead of silently refusing every connection.
	forward := model.Access{
		Mode: model.AccessRules,
		IP:   model.AccessList{Rest: model.AccessDeny},
		UA:   model.AccessList{Rest: model.AccessDeny, Entries: []model.AccessEntry{{Action: "deny", Kind: "ua", Value: "curl"}}},
	}
	normalizeAccess(&forward, false, false)
	if len(forward.UA.Entries) != 0 || forward.UA.Rest != model.AccessAllow {
		t.Fatalf("forward client list = %+v, want empty and allow", forward.UA)
	}
}
