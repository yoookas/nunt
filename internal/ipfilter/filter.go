// Package ipfilter evaluates the access rule of a web or forward rule: an
// ordered list of address entries (IP ranges and ip2region countries, provinces
// or cities) followed by an ordered list of user agent fragments, each ending in
// an "everything else" action.
//
// The first entry that matches decides, so the order of the list is the
// priority. The two lists are independent and combined with AND: a request has
// to pass both.
package ipfilter

import (
	"fmt"
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

// addressRule is one compiled entry of the address list.
type addressRule struct {
	allow bool
	kind  string
	// net is set for AccessKindIP, name for AccessKindGeo.
	net  *net.IPNet
	name string
}

// uaRule is one compiled entry of the client list.
type uaRule struct {
	allow   bool
	pattern string
}

// Filter is a compiled access rule. It is safe for concurrent use.
type Filter struct {
	mode      string
	addresses []addressRule
	ua        []uaRule
	// addressRest and uaRest are the actions taken when nothing in the list
	// matches. They come from AccessList.Rest and are false (deny) when unset,
	// so a half configured rule never opens up.
	addressRest bool
	uaRest      bool
	lookup      Lookup
}

// Compile turns a stored access rule into a filter. Invalid entries are an
// error: a typo must never silently open or close a rule.
func Compile(access model.Access, geo Lookup) (*Filter, error) {
	f := &Filter{
		mode:        access.Mode,
		addressRest: access.IP.Rest == model.AccessAllow,
		uaRest:      access.UA.Rest == model.AccessAllow,
		lookup:      geo,
	}
	if f.mode != model.AccessRules {
		f.mode = model.AccessOff
		return f, nil
	}
	for i, entry := range access.IP.Entries {
		rule := addressRule{allow: entry.Action == model.AccessAllow, kind: entry.Kind}
		switch entry.Kind {
		case model.AccessKindIP:
			nets, err := netutil.ParseIPList([]string{entry.Value})
			if err != nil || len(nets) != 1 {
				if err == nil {
					err = fmt.Errorf("%q is not one address range", entry.Value)
				}
				return nil, fmt.Errorf("address rule %d: %w", i+1, err)
			}
			rule.net = nets[0]
		case model.AccessKindGeo:
			rule.name = entry.Value
		default:
			return nil, fmt.Errorf("address rule %d: unsupported kind %q", i+1, entry.Kind)
		}
		f.addresses = append(f.addresses, rule)
	}
	for i, entry := range access.UA.Entries {
		if entry.Kind != model.AccessKindUA && entry.Kind != "" {
			return nil, fmt.Errorf("client rule %d: unsupported kind %q", i+1, entry.Kind)
		}
		f.ua = append(f.ua, uaRule{
			allow:   entry.Action == model.AccessAllow,
			pattern: strings.ToLower(entry.Value),
		})
	}
	return f, nil
}

// Allowed reports whether the address and user agent pass the rule and, when
// they do not, a short reason for the log.
//
// A geo lookup failure is fail-closed: the request is refused instead of being
// judged by a list whose geo entries could not be evaluated. The lookup only
// happens when the walk actually reaches a geo entry, so traffic matched by an
// earlier IP range never touches the database.
func (f *Filter) Allowed(ip net.IP, userAgent string) (bool, string) {
	if f == nil || f.mode != model.AccessRules {
		return true, "off"
	}

	var record ip2region.Record
	loaded := false
	for _, rule := range f.addresses {
		switch rule.kind {
		case model.AccessKindIP:
			if rule.net != nil && rule.net.Contains(ip) {
				return rule.allow, actionText(rule.allow) + ":ip:" + rule.net.String()
			}
		case model.AccessKindGeo:
			if !loaded {
				loaded = true
				if f.lookup == nil {
					return false, "geo-unavailable"
				}
				next, err := f.lookup.Lookup(ip)
				if err != nil {
					return false, "geo-unavailable"
				}
				record = next
			}
			if matchGeoName(rule.name, record) {
				return rule.allow, actionText(rule.allow) + ":geo:" + rule.name
			}
		}
	}
	if !f.addressRest {
		return false, "rest:deny"
	}

	lower := strings.ToLower(userAgent)
	for _, rule := range f.ua {
		if rule.pattern != "" && strings.Contains(lower, rule.pattern) {
			return rule.allow, actionText(rule.allow) + ":ua:" + rule.pattern
		}
	}
	if !f.uaRest {
		return false, "ua-rest:deny"
	}
	return true, "pass"
}

func actionText(allow bool) string {
	if allow {
		return model.AccessAllow
	}
	return model.AccessDeny
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
