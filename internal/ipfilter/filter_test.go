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

func entry(action, kind, value string) model.AccessEntry {
	return model.AccessEntry{Action: action, Kind: kind, Value: value}
}

func list(rest string, entries ...model.AccessEntry) model.AccessList {
	return model.AccessList{Rest: rest, Entries: entries}
}

func rules(ipList, uaList model.AccessList) model.Access {
	return model.Access{Mode: model.AccessRules, IP: ipList, UA: uaList}
}

var uaPassthrough = list(model.AccessAllow)

func TestOrderedAccessLists(t *testing.T) {
	china := fakeGeo{record: ip2region.Record{Country: "中国", Province: "浙江省", City: "杭州市"}}

	cases := []struct {
		name   string
		access model.Access
		lookup Lookup
		ip     string
		ua     string
		want   bool
		reason string
	}{
		{
			name:   "the first matching entry wins",
			access: rules(list(model.AccessDeny, entry("allow", "ip", "10.0.0.0/8"), entry("deny", "ip", "10.1.0.0/16")), uaPassthrough),
			ip:     "10.1.2.3",
			want:   true,
			reason: "allow:ip:10.0.0.0/8",
		},
		{
			name:   "swapping the order swaps the verdict",
			access: rules(list(model.AccessDeny, entry("deny", "ip", "10.1.0.0/16"), entry("allow", "ip", "10.0.0.0/8")), uaPassthrough),
			ip:     "10.1.2.3",
			want:   false,
			reason: "deny:ip:10.1.0.0/16",
		},
		{
			name:   "nothing matches, the list denies",
			access: rules(list(model.AccessDeny, entry("allow", "ip", "10.0.0.0/8")), uaPassthrough),
			ip:     "192.168.1.1",
			want:   false,
			reason: "rest:deny",
		},
		{
			name:   "nothing matches, the list allows",
			access: rules(list(model.AccessAllow, entry("deny", "ip", "10.0.0.0/8")), uaPassthrough),
			ip:     "192.168.1.1",
			want:   true,
			reason: "pass",
		},
		{
			name:   "an earlier ip entry means the geo entry is not reached",
			access: rules(list(model.AccessDeny, entry("allow", "ip", "10.0.0.0/8"), entry("deny", "geo", "中国")), uaPassthrough),
			lookup: china,
			ip:     "10.1.1.1",
			want:   true,
			reason: "allow:ip:10.0.0.0/8",
		},
		{
			name:   "a geo entry matches country and province",
			access: rules(list(model.AccessAllow, entry("deny", "geo", "浙江")), uaPassthrough),
			lookup: china,
			ip:     "1.1.1.1",
			want:   false,
			reason: "deny:geo:浙江",
		},
		{
			name:   "an address without geography falls through to the rest",
			access: rules(list(model.AccessAllow, entry("deny", "geo", "中国")), uaPassthrough),
			lookup: fakeGeo{},
			ip:     "10.0.0.1",
			want:   true,
			reason: "pass",
		},
		{
			name:   "a geo lookup failure fails closed",
			access: rules(list(model.AccessAllow, entry("allow", "geo", "中国")), uaPassthrough),
			lookup: fakeGeo{err: errors.New("no database")},
			ip:     "1.1.1.1",
			want:   false,
			reason: "geo-unavailable",
		},
		{
			name:   "the user agent list denies after the address list allowed",
			access: rules(list(model.AccessAllow), list(model.AccessAllow, entry("deny", "ua", "curl"))),
			ip:     "192.168.1.1",
			ua:     "curl/8.0",
			want:   false,
			reason: "deny:ua:curl",
		},
		{
			name:   "the user agent rest denies an unmatched client",
			access: rules(list(model.AccessAllow), list(model.AccessDeny, entry("allow", "ua", "mozilla"))),
			ip:     "192.168.1.1",
			ua:     "curl/8.0",
			want:   false,
			reason: "ua-rest:deny",
		},
		{
			name:   "a denied address never reaches the user agent list",
			access: rules(list(model.AccessDeny, entry("deny", "ip", "10.0.0.0/8")), list(model.AccessAllow, entry("allow", "ua", "mozilla"))),
			ip:     "10.1.1.1",
			ua:     "mozilla/5.0",
			want:   false,
			reason: "deny:ip:10.0.0.0/8",
		},
		{
			name:   "mode off ignores the lists",
			access: model.Access{Mode: model.AccessOff, IP: list(model.AccessDeny, entry("deny", "ip", "10.0.0.0/8"))},
			ip:     "10.1.1.1",
			want:   true,
			reason: "off",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			filter, err := Compile(tc.access, tc.lookup)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			got, reason := filter.Allowed(net.ParseIP(tc.ip), tc.ua)
			if got != tc.want {
				t.Fatalf("Allowed(%s) = %v, want %v (reason %q)", tc.ip, got, tc.want, reason)
			}
			if reason != tc.reason {
				t.Fatalf("reason = %q, want %q", reason, tc.reason)
			}
		})
	}
}

func TestCompileRejectsInvalidEntries(t *testing.T) {
	bad := []model.Access{
		rules(list(model.AccessAllow, entry("allow", "ip", "10.0.0.0/33")), uaPassthrough),
		rules(list(model.AccessAllow, entry("allow", "dns", "example.com")), uaPassthrough),
		rules(list(model.AccessAllow), list(model.AccessAllow, entry("allow", "ip", "10.0.0.0/8"))),
	}
	for i, access := range bad {
		if _, err := Compile(access, nil); err == nil {
			t.Fatalf("case %d compiled although it is invalid", i)
		}
	}
}
