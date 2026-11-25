// Package ip2region wraps the ip2region xdb database: it answers which
// country/province an address belongs to.
//
// The upstream searcher is not safe for concurrent use, so every lookup is
// serialised. A database of a few megabytes lives in memory, which keeps a
// lookup in the microsecond range.
package ip2region

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

// ErrUnavailable is returned when no database is configured or loaded.
var ErrUnavailable = errors.New("ip2region database is not available")

// Record is one decoded ip2region row:
// country|region|province|city|isp.
type Record struct {
	Country  string `json:"country"`
	Region   string `json:"region"`
	Province string `json:"province"`
	City     string `json:"city"`
	ISP      string `json:"isp"`
	Raw      string `json:"raw,omitempty"`
}

// Status describes the loaded database.
type Status struct {
	Path      string     `json:"path"`
	Loaded    bool       `json:"loaded"`
	IPVersion int        `json:"ipVersion,omitempty"`
	Size      int64      `json:"size,omitempty"`
	CreatedAt *time.Time `json:"createdAt,omitempty"`
	Error     string     `json:"error,omitempty"`
}

// Service owns the loaded database. Lookups go through a pool of searchers
// over one immutable content buffer: the upstream searcher keeps a mutable
// counter, so each lookup borrows its own instance instead of serialising on a
// process wide lock.
type Service struct {
	mu sync.Mutex
	// One dataset per address family. Lookups pick by the address they were
	// given; a v4 database never answers a v6 query and vice versa.
	v4     atomic.Pointer[dataset]
	v6     atomic.Pointer[dataset]
	status [2]Status
	mtime  [2]time.Time
}

// Family indexes used by the status and mtime arrays.
const (
	family4 = 0
	family6 = 1
)

// Paths are the database files to load. An empty path disables that family.
type Paths struct {
	V4 string
	V6 string
}

func (s *Service) store(family int, d *dataset) {
	if family == family6 {
		s.v6.Store(d)
		return
	}
	s.v4.Store(d)
}

func (s *Service) loadPtr(family int) *dataset {
	if family == family6 {
		return s.v6.Load()
	}
	return s.v4.Load()
}

// dataset is one loaded database, its searcher pool and the provinces that
// actually appear in it.
type dataset struct {
	pool      sync.Pool
	provinces []string
}

func newDataset(version *xdb.Version, content []byte, provinces []string) (*dataset, error) {
	// Validate the buffer once; pool entries are built from the same bytes and
	// cannot fail after this point.
	if _, err := xdb.NewWithBuffer(version, content); err != nil {
		return nil, err
	}
	d := &dataset{provinces: provinces}
	d.pool.New = func() any {
		searcher, err := xdb.NewWithBuffer(version, content)
		if err != nil {
			return nil
		}
		return searcher
	}
	return d, nil
}

// search borrows one searcher for a single lookup.
func (d *dataset) search(ip []byte) (string, error) {
	value := d.pool.Get()
	searcher, ok := value.(*xdb.Searcher)
	if !ok || searcher == nil {
		return "", errors.New("ip2region searcher pool is empty")
	}
	defer d.pool.Put(searcher)
	return searcher.Search(ip)
}

// New creates an empty service; call Configure to load a database.
func New() *Service { return &Service{} }

// Configure loads both databases. An empty path unloads that family, and a
// file that did not change since the last load is skipped. A failure on one
// family does not prevent the other one from loading.
func (s *Service) Configure(paths Paths) error {
	err4 := s.configureFamily(family4, paths.V4)
	err6 := s.configureFamily(family6, paths.V6)
	if err4 != nil || err6 != nil {
		return errors.Join(err4, err6)
	}
	return nil
}

func (s *Service) configureFamily(family int, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		s.store(family, nil)
		s.mu.Lock()
		s.status[family] = Status{}
		s.mtime[family] = time.Time{}
		s.mu.Unlock()
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		s.setError(family, path, err)
		return fmt.Errorf("ip2region database %s: %w", path, err)
	}
	s.mu.Lock()
	same := s.loadPtr(family) != nil && s.status[family].Path == path && s.mtime[family].Equal(info.ModTime())
	s.mu.Unlock()
	if same {
		return nil
	}
	data, status, err := load(family, path, info)
	if err != nil {
		s.setError(family, path, err)
		return err
	}
	s.store(family, data)
	s.mu.Lock()
	s.status[family] = status
	s.mtime[family] = info.ModTime()
	s.mu.Unlock()
	return nil
}

// Reload rereads the configured files.
func (s *Service) Reload() error {
	s.mu.Lock()
	paths := Paths{V4: s.status[family4].Path, V6: s.status[family6].Path}
	s.mu.Unlock()
	if paths.V4 == "" && paths.V6 == "" {
		return ErrUnavailable
	}
	return s.Configure(paths)
}

// Probe loads a database without installing it, so a new path can be validated
// before it is saved.
func (s *Service) Probe(path string) (Status, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Status{}, errors.New("empty path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return Status{Path: path, Error: err.Error()}, err
	}
	_, status, err := load(-1, path, info)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	return status, nil
}

// Lookup resolves the record of one address. Each family uses its own
// database: a v6 database is only consulted for v6 addresses, and when no
// database is configured for a family the lookup answers as before (an error
// for v4, an empty record for v6).
func (s *Service) Lookup(ip net.IP) (Record, error) {
	if v4 := ip.To4(); v4 != nil {
		data := s.v4.Load()
		if data == nil {
			return Record{}, ErrUnavailable
		}
		raw, err := data.search([]byte(v4))
		if err != nil {
			return Record{}, err
		}
		return ParseRegion(raw), nil
	}
	v6 := ip.To16()
	if v6 == nil {
		return Record{}, nil
	}
	data := s.v6.Load()
	if data == nil {
		return Record{}, nil
	}
	raw, err := data.search([]byte(v6))
	if err != nil {
		return Record{}, err
	}
	return ParseRegion(raw), nil
}

// ProvincesFromDatabase returns the provinces that occur in the loaded
// database. The second result is false when no database is loaded.
func (s *Service) ProvincesFromDatabase() ([]string, bool) {
	data := s.v4.Load()
	if data == nil {
		return nil, false
	}
	return append([]string{}, data.provinces...), true
}

// Statuses reports the IPv4 and IPv6 databases in that order.
func (s *Service) Statuses() (Status, Status) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status[family4], s.status[family6]
}

func (s *Service) setError(family int, path string, err error) {
	s.store(family, nil)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status[family] = Status{Path: path, Error: err.Error()}
	s.mtime[family] = time.Time{}
}

func load(family int, path string, info os.FileInfo) (*dataset, Status, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, Status{Path: path}, fmt.Errorf("read: %w", err)
	}
	header, err := xdb.NewHeader(data)
	if err != nil {
		return nil, Status{Path: path}, fmt.Errorf("invalid database: %w", err)
	}
	version := xdb.IPv4
	if header.IPVersion == xdb.IPv6VersionNo {
		version = xdb.IPv6
	} else if header.IPVersion != xdb.IPv4VersionNo {
		return nil, Status{Path: path}, fmt.Errorf("unsupported ip version %d", header.IPVersion)
	}
	if family == family6 && version != xdb.IPv6 {
		return nil, Status{Path: path}, errors.New("这是 IPv4 地址库，不能作为 IPv6 库使用")
	}
	if family == family4 && version != xdb.IPv4 {
		return nil, Status{Path: path}, errors.New("这是 IPv6 地址库，不能作为 IPv4 库使用")
	}
	provinces := []string(nil)
	if family == family4 {
		// The v6 database has far more segments; the province picker is built
		// from the v4 file and falls back to the built-in list without it.
		provinces = collectProvinces(data, header, version)
	}
	loaded, err := newDataset(version, data, provinces)
	if err != nil {
		return nil, Status{Path: path}, fmt.Errorf("open: %w", err)
	}
	status := Status{
		Path:      path,
		Loaded:    true,
		IPVersion: header.IPVersion,
		Size:      info.Size(),
	}
	if header.CreatedAt > 0 {
		created := time.Unix(int64(header.CreatedAt), 0).UTC()
		status.CreatedAt = &created
	}
	return loaded, status, nil
}

// collectProvinces walks the segment index of the database and collects the
// distinct third field (province) of every row. The database has no
// enumeration API, so this one-time scan is what makes a province picker
// possible without hard-coding a list that can drift from the data.
func collectProvinces(content []byte, header *xdb.Header, version *xdb.Version) []string {
	if header == nil || version == nil {
		return nil
	}
	ipBytes := version.Bytes
	segSize := version.SegmentIndexSize
	if ipBytes <= 0 || segSize < ipBytes*2+6 {
		return nil
	}
	start, end := int(header.StartIndexPtr), int(header.EndIndexPtr)
	seen := map[string]struct{}{}
	for p := start; p <= end && p+segSize <= len(content); p += segSize {
		entry := content[p : p+segSize]
		dataLen := int(binary.LittleEndian.Uint16(entry[ipBytes*2:]))
		dataPtr := int(binary.LittleEndian.Uint32(entry[ipBytes*2+2:]))
		if dataLen <= 0 || dataPtr < 0 || dataPtr+dataLen > len(content) {
			continue
		}
		parts := strings.Split(string(content[dataPtr:dataPtr+dataLen]), "|")
		if len(parts) < 3 {
			continue
		}
		name := NormalizeProvince(parts[2])
		if name == "" || name == "0" {
			continue
		}
		// Only offer provinces the configuration accepts: the picker is built
		// from this list, and validation refuses anything outside the known
		// set, so a database-only name would be unselectable in practice.
		if !provinceSet[name] {
			continue
		}
		seen[name] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// ParseRegion turns a raw ip2region row into a Record. Missing fields are
// normalised to empty strings, and the "0" placeholder is treated the same
// way as an empty value.
func ParseRegion(raw string) Record {
	out := Record{Raw: raw}
	parts := strings.Split(raw, "|")
	fields := []*string{&out.Country, &out.Region, &out.Province, &out.City, &out.ISP}
	for i := 0; i < len(fields) && i < len(parts); i++ {
		value := strings.TrimSpace(parts[i])
		if value == "0" {
			value = ""
		}
		*fields[i] = value
	}
	return out
}

// Provinces lists the province short names used by ip2region and this build.
func Provinces() []string {
	out := make([]string, len(provinceNames))
	copy(out, provinceNames)
	return out
}

var provinceNames = []string{
	"北京", "天津", "河北", "山西", "内蒙古",
	"辽宁", "吉林", "黑龙江",
	"上海", "江苏", "浙江", "安徽", "福建", "江西", "山东",
	"河南", "湖北", "湖南", "广东", "广西", "海南",
	"重庆", "四川", "贵州", "云南", "西藏",
	"陕西", "甘肃", "青海", "宁夏", "新疆",
	"香港", "澳门", "台湾",
}

var provinceSet = func() map[string]bool {
	m := make(map[string]bool, len(provinceNames))
	for _, name := range provinceNames {
		m[name] = true
	}
	return m
}()

// NormalizeProvince reduces both the configured value and the database value
// to the same short name: "浙江省", "浙江" and "浙江市" all become "浙江".
func NormalizeProvince(value string) string {
	name := strings.TrimSpace(value)
	if name == "" {
		return ""
	}
	// The order matters: the long names must be stripped before "自治区".
	for _, suffix := range []string{"壮族自治区", "回族自治区", "维吾尔自治区", "特别行政区", "自治区", "省", "市"} {
		if strings.HasSuffix(name, suffix) {
			name = strings.TrimSuffix(name, suffix)
			break
		}
	}
	return name
}

// KnownProvince reports whether the value is one of the supported provinces
// after normalisation.
func KnownProvince(value string) bool {
	return provinceSet[NormalizeProvince(value)]
}
