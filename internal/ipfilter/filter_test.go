package ipfilter

import (
	"errors"
	"net"
	"testing"

	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/model"
)

type fakeGeo struct {
	record ip2region.Record
	err    error
}

func (f fakeGeo) Lookup(net.IP) (ip2region.Record, error) { return f.record, f.err }

func TestFilterCIDRAndGeoUnion(t *testing.T) {
	cn := fakeGeo{record: ip2region.Record{Country: "中国", Province: "浙江省"}}
	cases := []struct {
		name string
		acc  model.Access
		geo  Lookup
		ip   string
		want bool
	}{
		{"cidr allow", model.Access{Mode: model.AccessAllow, IPs: []string{"10.0.0.0/8"}}, nil, "10.1.2.3", true},
		{"cidr allow miss", model.Access{Mode: model.AccessAllow, IPs: []string{"10.0.0.0/8"}}, nil, "192.168.1.1", false},
		{"country allow", model.Access{Mode: model.AccessAllow, Countries: []string{"中国"}}, cn, "1.1.1.1", true},
		{"country allow miss", model.Access{Mode: model.AccessAllow, Countries: []string{"美国"}}, cn, "1.1.1.1", false},
		{"province full name", model.Access{Mode: model.AccessAllow, Provinces: []string{"浙江省"}}, cn, "1.1.1.1", true},
		{"province short name", model.Access{Mode: model.AccessAllow, Provinces: []string{"浙江"}}, cn, "1.1.1.1", true},
		{"cidr or country", model.Access{Mode: model.AccessAllow, IPs: []string{"10.0.0.0/8"}, Countries: []string{"美国"}}, cn, "192.168.1.1", false},
		{"deny country", model.Access{Mode: model.AccessDeny, Countries: []string{"中国"}}, cn, "1.1.1.1", false},
		{"deny country miss", model.Access{Mode: model.AccessDeny, Countries: []string{"美国"}}, cn, "1.1.1.1", true},
		{"deny cidr", model.Access{Mode: model.AccessDeny, IPs: []string{"1.1.1.0/24"}}, cn, "1.1.1.1", false},
		{"off", model.Access{Mode: model.AccessOff, Countries: []string{"中国"}}, nil, "1.1.1.1", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, err := Compile(tc.acc, tc.geo)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			got, _ := f.Allowed(net.ParseIP(tc.ip))
			if got != tc.want {
				t.Fatalf("Allowed(%s) = %v, want %v", tc.ip, got, tc.want)
			}
		})
	}
}

func TestFilterFailsClosedOnGeoErrors(t *testing.T) {
	broken := fakeGeo{err: errors.New("boom")}
	for _, mode := range []string{model.AccessAllow, model.AccessDeny} {
		f, err := Compile(model.Access{Mode: mode, Countries: []string{"中国"}}, broken)
		if err != nil {
			t.Fatalf("compile: %v", err)
		}
		if ok, reason := f.Allowed(net.ParseIP("1.1.1.1")); ok || reason != "geo-error" {
			t.Fatalf("%s mode with a broken database = %v %q", mode, ok, reason)
		}
	}
	// A geo rule compiled without a lookup also refuses instead of allowing.
	f, err := Compile(model.Access{Mode: model.AccessAllow, Provinces: []string{"浙江"}}, nil)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if ok, _ := f.Allowed(net.ParseIP("1.1.1.1")); ok {
		t.Fatal("a geo rule without a database must refuse")
	}
}

func TestCompileRejectsBadCIDR(t *testing.T) {
	if _, err := Compile(model.Access{Mode: model.AccessAllow, IPs: []string{"nope"}}, nil); err == nil {
		t.Fatal("an invalid CIDR must be rejected")
	}
}
