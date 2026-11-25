// Package ipfilter evaluates the access rule of a web or forward rule: an
// explicit CIDR list, optionally combined with the country, province or city
// data of ip2region. A rule either allows or denies the union of those sets.
package ipfilter

import (
	"net"
	"strings"

	"github.com/nunt/nunt/internal/ip2region"
	"github.com/nunt/nunt/internal/model"
	"github.com/nunt/nunt/internal/netutil"
)

// Lookup resolves the geo information of an address.
type Lookup interface {
	Lookup(net.IP) (ip2region.Record, error)
}

// Filter is a compiled access rule. It is safe for concurrent use.
type Filter struct {
	mode   string
	nets   []*net.IPNet
	names  []string
	lookup Lookup
}

// Compile turns a stored access rule into a filter. Invalid CIDRs are an
// error: a typo must never silently open or close a rule.
func Compile(access model.Access, geo Lookup) (*Filter, error) {
	nets, err := netutil.ParseIPList(access.IPs)
	if err != nil {
		return nil, err
	}
	return &Filter{
		mode:   access.Mode,
		nets:   nets,
		names:  cleanList(access.Geo),
		lookup: geo,
	}, nil
}

// Allowed reports whether the client address passes the rule and, when it does
// not, a short reason for the log. A geo lookup failure is fail-closed: the
// request is refused in both allow and deny mode.
func (f *Filter) Allowed(ip net.IP) (bool, string) {
	if f == nil || f.mode == "" || f.mode == model.AccessOff {
		return true, "off"
	}
	matched, reason, err := f.match(ip)
	if err != nil {
		return false, reason
	}
	if f.mode == model.AccessAllow {
		if matched {
			return true, reason
		}
		return false, "no-match"
	}
	if matched {
		return false, reason
	}
	return true, "no-match"
}

func (f *Filter) match(ip net.IP) (bool, string, error) {
	if ip == nil {
		return false, "", nil
	}
	for _, n := range f.nets {
		if n.Contains(ip) {
			return true, "cidr", nil
		}
	}
	if len(f.names) == 0 {
		return false, "", nil
	}
	if f.lookup == nil {
		return false, "geo-unavailable", ip2region.ErrUnavailable
	}
	record, err := f.lookup.Lookup(ip)
	if err != nil {
		return false, "geo-error", err
	}
	for _, want := range f.names {
		if matchGeoName(want, record) {
			return true, "geo:" + want, nil
		}
	}
	return false, "", nil
}

// matchGeoName compares one entry against the country, province and city of a
// record. Provinces use the short spelling ("浙江" matches "浙江省") and cities
// ignore the common administrative suffixes ("杭州" matches "杭州市").
func matchGeoName(want string, record ip2region.Record) bool {
	want = strings.TrimSpace(want)
	if want == "" {
		return false
	}
	if record.Country != "" && strings.EqualFold(want, record.Country) {
		return true
	}
	if record.Province != "" {
		wantProvince := ip2region.NormalizeProvince(want)
		if wantProvince != "" && wantProvince == ip2region.NormalizeProvince(record.Province) {
			return true
		}
	}
	if record.City != "" && cityMatches(want, record.City) {
		return true
	}
	return false
}

func cityMatches(want, city string) bool {
	if strings.EqualFold(want, city) {
		return true
	}
	return strings.EqualFold(trimAdministrativeSuffix(want), trimAdministrativeSuffix(city))
}

func trimAdministrativeSuffix(name string) string {
	for _, suffix := range []string{"自治州", "地区", "市", "盟"} {
		if strings.HasSuffix(name, suffix) && len(name) > len(suffix) {
			return strings.TrimSuffix(name, suffix)
		}
	}
	return name
}

func cleanList(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, item := range in {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}
