package ip2region

import (
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"sync"
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
		// Current official layout: country|province|city|isp|ISO code.
		{"中国|江苏省|南京市|南京新锋信息|CN", Record{Country: "中国", Province: "江苏省", City: "南京市", ISP: "南京新锋信息", Raw: "中国|江苏省|南京市|南京新锋信息|CN"}},
		{"Australia|Queensland|Brisbane|0|AU", Record{Country: "Australia", Province: "Queensland", City: "Brisbane", Raw: "Australia|Queensland|Brisbane|0|AU"}},
		// Reserved ranges have no geography at all.
		{"Reserved|Reserved|Reserved|0|0", Record{Raw: "Reserved|Reserved|Reserved|0|0"}},
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
	for _, name := range provinceNames {
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
	if err := s.Configure(Paths{}); err != nil {
		t.Fatalf("empty configure: %v", err)
	}
	if v4, v6 := s.Statuses(); v4.Loaded || v6.Loaded {
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
	if err := s.Configure(Paths{V4: bad}); err == nil {
		t.Fatal("a non xdb file must be rejected")
	}
	if v4, _ := s.Statuses(); v4.Loaded || v4.Error == "" {
		t.Fatalf("status = %+v", v4)
	}
	if _, err := s.Probe(filepath.Join(dir, "missing.xdb")); err == nil {
		t.Fatal("a missing file must be rejected")
	}
}

// writeEmptyXDB writes a syntactically valid v2 IPv4 database with an empty
// vector index: every lookup returns an empty region without touching disk.
// It is enough to exercise the searcher pool and its concurrency.
func writeEmptyXDB(t *testing.T) string {
	t.Helper()
	const headerInfo = 256
	const vectorIndex = 256 * 256 * 8
	data := make([]byte, headerInfo+vectorIndex+8)
	data[0] = 2  // version
	data[2] = 1  // index policy
	data[16] = 4 // IPv4
	data[18] = 4 // runtime pointer bytes
	path := filepath.Join(t.TempDir(), "empty.xdb")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write xdb: %v", err)
	}
	return path
}

func TestConcurrentLookups(t *testing.T) {
	path := writeEmptyXDB(t)
	s := New()
	if err := s.Configure(Paths{V4: path}); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if v4, _ := s.Statuses(); !v4.Loaded || v4.IPVersion != 4 {
		t.Fatalf("status = %+v", v4)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				ip := net.IPv4(10, 0, byte(i), byte(j))
				if _, err := s.Lookup(ip); err != nil {
					errs <- err
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent lookup: %v", err)
	}
}

// A database for one address family must not be installed for the other one.
func TestConfigureRejectsTheWrongFamily(t *testing.T) {
	s := New()
	if err := s.Configure(Paths{V6: writeEmptyXDB(t)}); err == nil {
		t.Fatal("an IPv4 database must not be accepted as the IPv6 database")
	}
	if v4, v6 := s.Statuses(); v4.Loaded || v6.Loaded {
		t.Fatal("nothing should be loaded after a rejected file")
	}
}

// writeRegionXDBv6 writes a minimal IPv6 database with one segment covering
// [lo, hi] whose region is the given string.
func writeRegionXDBv6(t *testing.T, region string, lo, hi net.IP) string {
	t.Helper()
	const headerInfo = 256
	const vectorIndex = 256 * 256 * 8
	segOff := headerInfo + vectorIndex
	data := make([]byte, segOff+38+len(region))
	data[0] = 2  // version
	data[2] = 1  // index policy
	data[16] = 6 // IPv6
	data[18] = 4 // runtime pointer bytes
	binary.LittleEndian.PutUint32(data[8:], uint32(segOff))
	binary.LittleEndian.PutUint32(data[12:], uint32(segOff))
	idx := int(lo[0])*256*8 + int(lo[1])*8
	binary.LittleEndian.PutUint32(data[headerInfo+idx:], uint32(segOff))
	binary.LittleEndian.PutUint32(data[headerInfo+idx+4:], uint32(segOff))
	copy(data[segOff:], lo.To16())
	copy(data[segOff+16:], hi.To16())
	binary.LittleEndian.PutUint16(data[segOff+32:], uint16(len(region)))
	binary.LittleEndian.PutUint32(data[segOff+34:], uint32(segOff+38))
	copy(data[segOff+38:], region)
	path := filepath.Join(t.TempDir(), "v6.xdb")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write v6 xdb: %v", err)
	}
	return path
}

func TestIPv6DatabaseIsUsedForIPv6Only(t *testing.T) {
	path := writeRegionXDBv6(t, "中国|0|浙江省|杭州市|电信",
		net.ParseIP("2400:3200::"), net.ParseIP("2400:3200::ffff"))
	s := New()
	if err := s.Configure(Paths{V6: path}); err != nil {
		t.Fatalf("configure: %v", err)
	}
	v4, v6 := s.Statuses()
	if v4.Loaded || !v6.Loaded || v6.IPVersion != 6 {
		t.Fatalf("status v4=%+v v6=%+v", v4, v6)
	}
	rec, err := s.Lookup(net.ParseIP("2400:3200::1"))
	if err != nil {
		t.Fatalf("v6 lookup: %v", err)
	}
	if rec.Province != "浙江省" || rec.Country != "中国" {
		t.Fatalf("v6 record = %+v", rec)
	}
	if _, err := s.Lookup(net.ParseIP("1.1.1.1")); err != ErrUnavailable {
		t.Fatalf("v4 lookup without a v4 database = %v", err)
	}
}
