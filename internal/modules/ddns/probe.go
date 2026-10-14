package ddns

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"strings"

	"github.com/nunt/nunt/internal/httpc"
	"github.com/nunt/nunt/internal/model"
)

// detectIP resolves the public address of one family ("4" or "6").
func detectIP(ctx context.Context, cfg model.GetIP, family string) (string, error) {
	switch cfg.Mode {
	case "static":
		ip := net.ParseIP(strings.TrimSpace(cfg.Value))
		if ip == nil {
			return "", fmt.Errorf("%q is not a valid ip address", cfg.Value)
		}
		if family == "4" && ip.To4() == nil {
			return "", fmt.Errorf("%q is not an ipv4 address", cfg.Value)
		}
		if family == "6" && ip.To4() != nil {
			return "", fmt.Errorf("%q is not an ipv6 address", cfg.Value)
		}
		return ip.String(), nil
	case "interface":
		return interfaceIP(cfg.Iface, family)
	default:
		return remoteIP(ctx, cfg, family)
	}
}

func remoteIP(ctx context.Context, cfg model.GetIP, family string) (string, error) {
	if strings.TrimSpace(cfg.Value) != "" {
		code, body, err := httpc.Do(ctx, httpc.Request{URL: cfg.Value, Timeout: httpcTimeout})
		if err == nil && code >= 200 && code < 300 {
			text := strings.TrimSpace(string(body))
			if cfg.Regex != "" {
				re, rerr := regexp.Compile(cfg.Regex)
				if rerr != nil {
					return "", fmt.Errorf("invalid regular expression: %w", rerr)
				}
				if m := re.FindStringSubmatch(text); len(m) > 1 {
					text = m[1]
				} else if len(m) == 1 {
					text = m[0]
				} else {
					text = ""
				}
			} else {
				text = firstIP(text, family)
			}
			if ip := net.ParseIP(strings.Trim(strings.TrimSpace(text), "[]")); ip != nil {
				return ip.String(), nil
			}
		}
	}
	// Fall back to the well known public services.
	return httpc.PublicIP(ctx, family, nil)
}

// firstIP extracts the first address of the wanted family from text.
func firstIP(text, family string) string {
	fields := strings.FieldsFunc(text, func(r rune) bool {
		switch r {
		case 0x20, 0x09, 0x0d, 0x0a, 0x2c, 0x22, 0x27, 0x3c, 0x3e, 0x28, 0x29, 0x3a, 0x3b, 0x3d:
			return true
		}
		return false
	})
	for _, f := range fields {
		ip := net.ParseIP(strings.Trim(f, "[]"))
		if ip == nil {
			continue
		}
		if family == "4" && ip.To4() == nil {
			continue
		}
		if family == "6" && ip.To4() != nil {
			continue
		}
		return ip.String()
	}
	// IPv6 addresses contain colons, so retry on the raw text.
	if family == "6" {
		for _, f := range strings.Fields(text) {
			ip := net.ParseIP(strings.Trim(f, "[]"))
			if ip != nil && ip.To4() == nil {
				return ip.String()
			}
		}
	}
	return ""
}

// interfaceIP returns a global unicast address of an interface.
func interfaceIP(name, family string) (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("list interfaces: %w", err)
	}
	wanted := strings.TrimSpace(name)
	for _, iface := range ifaces {
		if wanted != "" && iface.Name != wanted {
			continue
		}
		if wanted == "" && (iface.Flags&net.FlagUp) == 0 {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP
			if family == "4" {
				if ip.To4() == nil {
					continue
				}
				if !usableV4(ip) {
					continue
				}
				return ip.String(), nil
			}
			if ip.To4() != nil || !usableV6(ip) {
				continue
			}
			return ip.String(), nil
		}
	}
	if wanted != "" {
		return "", fmt.Errorf("interface %q has no usable ipv%s address", wanted, family)
	}
	return "", fmt.Errorf("no usable ipv%s address found on any interface", family)
}

func usableV4(ip net.IP) bool {
	if ip.To4() == nil {
		return false
	}
	return ip.IsGlobalUnicast() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}

func usableV6(ip net.IP) bool {
	if ip.To4() != nil {
		return false
	}
	if !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// Skip unique local addresses (fc00::/7).
	if len(ip) >= 1 && ip[0]&0xfe == 0xfc {
		return false
	}
	return true
}
