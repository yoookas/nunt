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
	mu     sync.Mutex
	data   atomic.Pointer[dataset]
	status Status
	mtime  time.Time
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

// Configure loads the database at path. An empty path unloads it. Reloading
// the same, unchanged file is a no-op.
func (s *Service) Configure(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		s.data.Store(nil)
		s.mu.Lock()
		s.status = Status{}
		s.mtime = time.Time{}
		s.mu.Unlock()
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		s.setError(path, err)
		return fmt.Errorf("ip2region database %s: %w", path, err)
	}
	s.mu.Lock()
	same := s.data.Load() != nil && s.status.Path == path && s.mtime.Equal(info.ModTime())
	s.mu.Unlock()
	if same {
		return nil
	}
	data, status, err := load(path, info)
	if err != nil {
		s.setError(path, err)
		return err
	}
	s.data.Store(data)
	s.mu.Lock()
	s.status = status
	s.mtime = info.ModTime()
	s.mu.Unlock()
	return nil
}

// Reload rereads the configured file.
func (s *Service) Reload() error {
	s.mu.Lock()
	path := s.status.Path
	s.mu.Unlock()
	if path == "" {
		return ErrUnavailable
	}
	return s.Configure(path)
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
	_, status, err := load(path, info)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	return status, nil
}

// Lookup resolves the record of one address. IPv6 and private addresses have
// no row in the common IPv4 database; they return an empty record.
func (s *Service) Lookup(ip net.IP) (Record, error) {
	v4 := ip.To4()
	if v4 == nil {
		return Record{}, nil
	}
	data := s.data.Load()
	if data == nil {
		return Record{}, ErrUnavailable
	}
	raw, err := data.search([]byte(v4))
	if err != nil {
		return Record{}, err
	}
	return ParseRegion(raw), nil
}

// ProvincesFromDatabase returns the provinces that occur in the loaded
// database. The second result is false when no database is loaded.
func (s *Service) ProvincesFromDatabase() ([]string, bool) {
	data := s.data.Load()
	if data == nil {
		return nil, false
	}
	return append([]string{}, data.provinces...), true
}

// Status reports the current database.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Service) setError(path string, err error) {
	s.data.Store(nil)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = Status{Path: path, Error: err.Error()}
}

func load(path string, info os.FileInfo) (*dataset, Status, error) {
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
	provinces := collectProvinces(data, header, version)
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
