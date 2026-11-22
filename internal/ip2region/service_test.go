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
	if err := s.Configure(path); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if status := s.Status(); !status.Loaded || status.IPVersion != 4 {
		t.Fatalf("status = %+v", status)
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

// writeProvinceXDB writes a minimal database with one segment whose region is
// 中国|0|浙江省|杭州市|电信, so the province enumeration can be tested.
func writeProvinceXDB(t *testing.T) string {
	t.Helper()
	const headerInfo = 256
	const vectorIndex = 256 * 256 * 8
	region := "中国|0|浙江省|杭州市|电信"
	segOff := headerInfo + vectorIndex
	data := make([]byte, segOff+14+len(region)+16)
	data[0] = 2  // version
	data[2] = 1  // index policy
	data[16] = 4 // IPv4
	data[18] = 4 // runtime pointer bytes
	binary.LittleEndian.PutUint32(data[8:], uint32(segOff))
	binary.LittleEndian.PutUint32(data[12:], uint32(segOff))
	binary.LittleEndian.PutUint32(data[segOff:], 0)
	binary.LittleEndian.PutUint32(data[segOff+4:], ^uint32(0))
	binary.LittleEndian.PutUint16(data[segOff+8:], uint16(len(region)))
	binary.LittleEndian.PutUint32(data[segOff+10:], uint32(segOff+14))
	copy(data[segOff+14:], region)
	path := filepath.Join(t.TempDir(), "province.xdb")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write xdb: %v", err)
	}
	return path
}

func TestProvincesFromDatabase(t *testing.T) {
	s := New()
	if _, ok := s.ProvincesFromDatabase(); ok {
		t.Fatal("an empty service reports a database")
	}
	if err := s.Configure(writeProvinceXDB(t)); err != nil {
		t.Fatalf("configure: %v", err)
	}
	provinces, ok := s.ProvincesFromDatabase()
	if !ok || len(provinces) != 1 || provinces[0] != "浙江" {
		t.Fatalf("provinces = %v, ok = %v", provinces, ok)
	}
}
