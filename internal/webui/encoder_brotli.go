package webui

import (
	"bytes"

	"github.com/andybalholm/brotli"
)

// brotliQuality 是预压缩使用的质量等级。
//
// 这些资源每个进程只压一次并常驻内存，所以可以挑一个「明显比 gzip 好、又不至于
// 让首个请求卡住」的档位。实测（2026-10，见 docs/screenshots/before/REPORT.md）：
//
//	文件            原始     gzip-9   br-q6    br-q11
//	index.html       988       572      478      398
//	app.js         29447      8094     7374     6743
//	style.css      24099      5665     5468     4775
//	pages/waf.js  102104     29953    27184    25044
//
// q11 还能再小 8%~12%，但压缩耗时是 q6 的 20~30 倍（waf.js 216ms vs 7.8ms），
// 放在请求路径上不合适。
const brotliQuality = 6

func init() { registerEncoder(encodingBrotli, brotliBytes) }

func brotliBytes(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	buf.Grow(len(data)/3 + 64)
	zw := brotli.NewWriterLevel(&buf, brotliQuality)
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
