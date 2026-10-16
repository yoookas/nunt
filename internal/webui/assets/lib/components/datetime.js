// 组件入口：Shoelace 的格式化元素。
//
// 说明：nunt 自带 fmtBytes/fmtTime/fmtDuration（见 lib/kit.js）已经覆盖了这些组件的用途，
// 因此目前没有任何页面需要它们；这里保留入口是为了「按需加载」的清单完整：
// 以后哪个页面想用 <sl-format-bytes> 而不是 fmtBytes()，import 这个入口即可，
// 不需要再去动 nunt-shoelace.js（那会重新把所有组件拉回首屏）。
import './core.js';
import '../../vendor/shoelace/components/format-bytes/format-bytes.js';
import '../../vendor/shoelace/components/format-date/format-date.js';
import '../../vendor/shoelace/components/format-number/format-number.js';
import '../../vendor/shoelace/components/relative-time/relative-time.js';

export {};
