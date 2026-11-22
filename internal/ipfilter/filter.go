// Package ipfilter evaluates the access rule of a web or forward rule: an
// explicit CIDR list, optionally combined with the country/province data of
// ip2region. A rule either allows or denies the union of those sets.
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
	mode      string
	nets      []*net.IPNet
	countries []string
	provinces []string
	geo       Lookup
}

// Compile turns a stored access rule into a filter. Invalid CIDRs are an
// error: a typo must never silently open or close a rule.
func Compile(access model.Access, geo Lookup) (*Filter, error) {
	nets, err := netutil.ParseIPList(access.IPs)
	if err != nil {
		return nil, err
	}
	f := &Filter{
		mode:      access.Mode,
		nets:      nets,
		countries: cleanList(access.Countries),
		provinces: cleanList(access.Provinces),
		geo:       geo,
	}
	return f, nil
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
	if len(f.countries) == 0 && len(f.provinces) == 0 {
		return false, "", nil
	}
	if f.geo == nil {
		return false, "geo-unavailable", ip2region.ErrUnavailable
	}
	record, err := f.geo.Lookup(ip)
	if err != nil {
		return false, "geo-error", err
	}
	if record.Country != "" {
		for _, country := range f.countries {
			if strings.EqualFold(strings.TrimSpace(country), record.Country) {
				return true, "country:" + record.Country, nil
			}
		}
	}
	if record.Province != "" {
		province := ip2region.NormalizeProvince(record.Province)
		for _, want := range f.provinces {
			if province != "" && province == ip2region.NormalizeProvince(want) {
				return true, "province:" + province, nil
			}
		}
	}
	return false, "", nil
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
