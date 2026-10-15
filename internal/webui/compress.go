package webui

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// 这个文件负责「静态资源预压缩」：嵌入的文本资源在第一次被请求时压缩一次，
// 结果留在内存里，之后的请求直接返回缓存。
//
// 为什么不做成构建期产物：项目承诺零构建、单二进制，仓库里不提交 .gz/.br 文件，
// 所以压缩只能发生在运行时；而资源是嵌入的、内容不变，压缩一次就够。
//
// 为什么需要它：前端从「手写 DOM」换成组件库之后，未压缩体积会明显变大
// （见 docs/PLAN-frontend-webcomponents.md），而原来的实现是 http.FileServer
// 直接把源码吐出去，白送了 60%~75% 的带宽。

// 支持的编码名。
const (
	encodingIdentity = "identity"
	encodingGzip     = "gzip"
	encodingBrotli   = "br"
)

// encoderPriority 是协商时的优先级：同等 q 值下靠前的优先，所以 br 优先于 gzip。
//
// brotli 的实现在 encoder_brotli.go，删掉那个文件就会自动退化成只支持 gzip。
var encoderPriority = []string{encodingBrotli, encodingGzip}

// encoders 保存真正编译进来的编码器。
var encoders = map[string]func([]byte) ([]byte, error){}

func init() { registerEncoder(encodingGzip, gzipBytes) }

// registerEncoder 把一个编码器登记进协商表。
func registerEncoder(name string, fn func([]byte) ([]byte, error)) { encoders[name] = fn }

// hasEncoder 报告某个编码当前是否可用（测试与协商都要用）。
func hasEncoder(name string) bool {
	_, ok := encoders[name]
	return ok
}

func gzipBytes(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	buf.Grow(len(data)/3 + 64)
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// etagFor 用内容哈希生成强 ETag，并把编码写进 ETag。
//
// 编码必须参与：同一个 URL 的 gzip 表示和 identity 表示是**不同的**表示，
// 共用一个 ETag 会让缓存（无论浏览器还是中间层）把 gzip 的字节当成
// 未压缩的字节复用。
func etagFor(body []byte, encoding string) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:16]) + "-" + encoding + `"`
}

// encodedAsset 是缓存里的一条压缩结果。
type encodedAsset struct {
	body []byte
	etag string
}

// encodeCache 缓存压缩结果与 ETag。
//
// 资源是嵌入的、进程生命周期内不会变，所以缓存不需要失效；键是
// 「资源名 + 编码」，条目数量被资源数量本身限制住（几百条，量级几百 KB）。
type encodeCache struct {
	mu    sync.RWMutex
	items map[string]*encodedAsset
	// compressions 记录真正执行压缩的次数，测试用它证明缓存命中时不会重复压缩。
	compressions atomic.Int64
}

func newEncodeCache() *encodeCache {
	return &encodeCache{items: make(map[string]*encodedAsset)}
}

func (c *encodeCache) get(key string) (*encodedAsset, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	v, ok := c.items[key]
	return v, ok
}

func (c *encodeCache) put(key string, v *encodedAsset) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = v
}

// encoded 返回资源在指定编码下的字节，必要时先压缩。
//
// 两个并发首请求可能各压缩一次，结果相同、写回幂等，因此这里不做单飞合并。
func (c *encodeCache) encoded(name, encoding string, raw []byte) (*encodedAsset, error) {
	key := name + "|" + encoding
	if v, ok := c.get(key); ok {
		return v, nil
	}
	fn, ok := encoders[encoding]
	if !ok {
		return nil, fmt.Errorf("webui: no encoder for %q", encoding)
	}
	body, err := fn(raw)
	if err != nil {
		return nil, err
	}
	c.compressions.Add(1)
	v := &encodedAsset{body: body, etag: etagFor(body, encoding)}
	c.put(key, v)
	return v, nil
}

// identityETag 返回未压缩表示的 ETag（内容哈希只算一次）。
func (c *encodeCache) identityETag(name string, raw []byte) string {
	key := name + "|" + encodingIdentity
	if v, ok := c.get(key); ok {
		return v.etag
	}
	etag := etagFor(raw, encodingIdentity)
	c.put(key, &encodedAsset{etag: etag})
	return etag
}

// negotiateEncoding 从 Accept-Encoding 里挑一个我们能生成的编码。
//
// 规则（RFC 9110 12.5.3 的简化实现）：q 值大的优先，q 相同按 encoderPriority
// 的顺序（br 优先于 gzip），q=0 表示明确拒绝，"*" 表示任何编码都接受；
// 没有任何可用编码时返回 identity。
func negotiateEncoding(header string) string {
	if strings.TrimSpace(header) == "" {
		return encodingIdentity
	}
	bestName := ""
	bestQ := 0.0
	wildcard := 0.0
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		name := strings.ToLower(strings.TrimSpace(fields[0]))
		q := 1.0
		for _, f := range fields[1:] {
			f = strings.TrimSpace(f)
			if v, ok := strings.CutPrefix(f, "q="); ok {
				if parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = parsed
				}
			}
		}
		if q <= 0 {
			continue
		}
		if name == "*" {
			wildcard = q
			continue
		}
		if !hasEncoder(name) {
			continue
		}
		if bestName == "" || q > bestQ || (q == bestQ && priorityOf(name) < priorityOf(bestName)) {
			bestName, bestQ = name, q
		}
	}
	if bestName != "" {
		return bestName
	}
	if wildcard > 0 {
		for _, name := range encoderPriority {
			if hasEncoder(name) {
				return name
			}
		}
	}
	return encodingIdentity
}

func priorityOf(name string) int {
	for i, n := range encoderPriority {
		if n == name {
			return i
		}
	}
	return len(encoderPriority)
}
