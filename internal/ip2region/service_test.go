package ip2region

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestParseRegion(t *testing.T) {
	cases := []struct {
		raw  string
		want Record
	}{
		{"中国|0|浙江省|杭州市|电信", Record{Country: "中国", Province: "浙江省", City: "杭州市", ISP: "电信", Raw: "中国|0|浙江省|杭州市|电信"}},
		{"0|0|0|0|0", Record{Raw: "0|0|0|0|0"}},
		{"", Record{}},
		{"美国|0|加利福尼亚州|洛杉矶|0", Record{Country: "美国", Province: "加利福尼亚州", City: "洛杉矶", Raw: "美国|0|加利福尼亚州|洛杉矶|0"}},
	}
	for _, tc := range cases {
		if got := ParseRegion(tc.raw); got != tc.want {
			t.Fatalf("ParseRegion(%q) = %+v, want %+v", tc.raw, got, tc.want)
		}
	}
}

func TestNormalizeProvince(t *testing.T) {
	cases := map[string]string{
		"浙江省":      "浙江",
		"浙江":       "浙江",
		"北京市":      "北京",
		"内蒙古自治区":   "内蒙古",
		"广西壮族自治区":  "广西",
		"宁夏回族自治区":  "宁夏",
		"新疆维吾尔自治区": "新疆",
		"西藏自治区":    "西藏",
		"香港特别行政区":  "香港",
		"台湾省":      "台湾",
		"":         "",
	}
	for in, want := range cases {
		if got := NormalizeProvince(in); got != want {
			t.Fatalf("NormalizeProvince(%q) = %q, want %q", in, got, want)
		}
	}
	for _, name := range Provinces() {
		if !KnownProvince(name) {
			t.Fatalf("province %q is not known", name)
		}
	}
	if KnownProvince("火星") {
		t.Fatal("an unknown province must be rejected")
	}
}

func TestEmptyService(t *testing.T) {
	s := New()
	if err := s.Configure(""); err != nil {
		t.Fatalf("empty configure: %v", err)
	}
	if s.Status().Loaded {
		t.Fatal("an empty service reports a loaded database")
	}
	if _, err := s.Lookup(net.ParseIP("1.1.1.1")); err != ErrUnavailable {
		t.Fatalf("lookup without a database = %v", err)
	}
	if err := s.Reload(); err != ErrUnavailable {
		t.Fatalf("reload without a database = %v", err)
	}
}

func TestConfigureRejectsBadFile(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.xdb")
	if err := os.WriteFile(bad, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New()
	if err := s.Configure(bad); err == nil {
		t.Fatal("a non xdb file must be rejected")
	}
	if status := s.Status(); status.Loaded || status.Error == "" {
		t.Fatalf("status = %+v", status)
	}
	if _, err := s.Probe(filepath.Join(dir, "missing.xdb")); err == nil {
		t.Fatal("a missing file must be rejected")
	}
}
