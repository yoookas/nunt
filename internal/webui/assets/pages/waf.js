// WAF 防护：引擎配置 + 请求体检查策略面板 + 规则文件列表 + 请求测试 + 拦截日志。
//
// 阶段 2 迁移（批次 D）：全部改用 kit —— 表格走 nunt-table（列标题全部有文字，
// 不再有 axe 的 empty-table-header），表单走 formGrid（控件与标签天然关联，8 条
// critical 的 label / select-name 一起消失），提示 / 对话框 / 三态走 toast /
// openDialog / nunt-error 等。卡片标题一律 h2（迁移前是 h3，触发 heading-order）。
// 页面私有样式用 pwaf- 前缀并随 mount 的清理函数移除。
//
// 数据流与迁移前一致：GET/PUT /api/v1/waf/config（提交时回传原配置对象再覆盖几项）、
// GET /api/v1/waf/rules、GET /api/v1/waf/logs?limit=200（每 10 秒自动刷新）、
// POST /api/v1/waf/test（{method,url,body,path}）、GET /api/v1/web/rules（未声明
// bodyPolicy 路由的兜底来源）。本页没有 SSE 订阅；两个轮询定时器在 cleanup 里全部停掉。
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtBytes, fmtTime,
} from '../lib/kit.js';

const LF = String.fromCharCode(10);
const MODE_LABEL = { detect: '检测模式', block: '拦截模式' };

const PAGE_CSS = [
  '.pwaf-panel{margin-bottom:4px}',
  '.pwaf-sub{margin-top:12px}',
  '.pwaf-sub-title{font-size:13px;font-weight:600;margin:0 0 6px}',
  '.pwaf-scroll{max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 10px}',
  '.pwaf-rule{display:flex;align-items:center;gap:10px;padding:3px 0;font-size:13px;border-bottom:1px solid rgba(127,127,127,.08)}',
  '.pwaf-rule:last-child{border-bottom:0}',
  '.pwaf-rule .pwaf-id{font-family:var(--sl-font-mono);font-size:12px;color:var(--text-faint);min-width:70px}',
  '.pwaf-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
  '.pwaf-tools .pwaf-search{width:220px}',
  '.pwaf-result{margin-top:12px}',
  '.pwaf-states{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px}',
  '.pwaf-state{border:1px solid var(--line);border-radius:var(--radius-sm);padding:7px 9px;display:flex;flex-direction:column;gap:3px;background:var(--bg-soft)}',
  '.pwaf-state .k{font-size:12px;color:var(--text-dim)}',
  '.pwaf-state .v{font-size:17px;font-weight:600;line-height:1.1}',
  '.pwaf-state .s{font-size:11px;color:var(--text-dim)}',
  '.pwaf-state.zero{opacity:.7}',
  '.pwaf-coverage{font-size:12px;margin-left:6px}',
  '.pwaf-hit-tag{font-family:var(--sl-font-mono);font-size:12px;color:var(--text-faint)}',
  '.pwaf-label{font-size:12px;color:var(--text-faint);margin-top:2px}',
  '.pwaf-compat{font-size:12px;color:var(--text-faint);margin-top:10px;line-height:1.6}',
  '.pwaf-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
  '.pwaf-grpc{display:flex;flex-wrap:wrap;gap:6px}',
  '.pwaf-grpc-item{display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:var(--bg-soft);font-size:12px}',
  '.pwaf-grpc-item .k{color:var(--text-dim)}',
  '.pwaf-grpc-item .v{font-weight:600;font-variant-numeric:tabular-nums}',
  '.pwaf-grpc-item.miss .v{font-weight:400;color:var(--text-faint)}',
  '.pwaf-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
  '.pwaf-chips-more{font-size:11px;color:var(--text-faint)}',
  '.pwaf-legend{font-size:12px;font-weight:600;color:var(--text-dim);margin:6px 0 2px}',
  '.pwaf-legend:first-child{margin-top:0}',
].join(LF);

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/** legendField：把迁移前 fieldSet 的小标题塞进 formGrid（用 div，避免 h3 触发 heading-order）。 */
function legendField(name, text) {
  const node = document.createElement('div');
  node.className = 'pwaf-legend';
  node.textContent = text;
  return { name, label: false, type: 'custom', wide: true, node };
}

/** chipList：规则 ID 这类多值单元格（超出 max 折叠成 +N）。 */
function chipList(list, max) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => x !== null && x !== undefined && String(x) !== '');
  if (!arr.length) return html`<span class="muted">-</span>`;
  const limit = max || 3;
  return html`<div class="pwaf-chips">
    ${arr.slice(0, limit).map((item) => html`<sl-tag size="small">${String(item)}</sl-tag>`)}
    ${arr.length > limit ? html`<span class="pwaf-chips-more">+${arr.length - limit}</span>` : nothing}
  </div>`;
}

/** unwrap / numOf / splitLines：与迁移前一致的取值口径。 */
function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

function numOf(value, dflt) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text === '') return dflt === undefined ? 0 : dflt;
  const n = Number(text);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}

/** makePoller：固定间隔轮询，返回停止函数（cleanup 会把它全部停掉）。 */
function makePoller(fn, ms) {
  let timer = null;
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try { await fn(); } catch (err) { /* 轮询失败静默 */ }
    if (!stopped) timer = setTimeout(tick, ms);
  }
  timer = setTimeout(tick, ms);
  return () => { stopped = true; if (timer) clearTimeout(timer); timer = null; };
}

function levelOptions(value, dflt) {
  return [1, 2, 3, 4].map((n) => ({ value: String(n), label: 'PL' + n }));
}

function wafRuleId(item) {
  return item.id || item.name || item.file || item.path || item.group || item.key || '';
}

function wafRuleTitle(item) {
  return item.title || item.label || item.name || item.file || item.path || wafRuleId(item);
}

function wafRuleCount(item) {
  const n = item.count !== undefined ? item.count : (item.rules !== undefined ? item.rules : (item.ruleCount !== undefined ? item.ruleCount : undefined));
  if (Array.isArray(n)) return n.length;
  return n;
}

// ruleRange：规则文件的规则 ID 区间（禁用整份文件时写进 disabledRules 的就是它）。
function ruleRange(item) {
  const lo = Number(item && item.minId) || 0;
  const hi = Number(item && item.maxId) || 0;
  return (lo > 0 && hi > 0) ? lo + '-' + hi : '';
}

function parseRange(text) {
  const parts = String(text === undefined || text === null ? '' : text).trim().split('-');
  if (parts.length !== 2) return null;
  const lo = Number(parts[0]);
  const hi = Number(parts[1]);
  if (!isFinite(lo) || !isFinite(hi) || lo <= 0 || hi <= 0) return null;
  return [lo, hi];
}

function ruleIdsOf(l) {
  const v = l.rules || l.ruleIds || l.matched || l.ruleId || l.rule;
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? (x.id || x.ruleId || JSON.stringify(x)) : x));
  return [v];
}

/* ---------------------------------------------------------------------------
 * 请求体检查策略（CONTRACT.md 第 8 节 / PLAN-waf-body-policy.md）
 *
 * 字段名与后端 model.WAFConfig 冻结的 JSON tag 一致：
 *   enforcementMode   observe | enforce（默认 observe）
 *   defaultBodyPolicy full | peek | skip | grpc（默认 full）
 *   peekBytes         默认 65536
 *   peekTimeoutMs     默认 250
 *   notifyBodyRatio   非 full 占比告警阈值，0–1（默认 0 = 关闭）
 * 后端接口尚未落地这些字段时，读取会退回到「未设置」并在页面上给出明确提示，
 * 不会白屏；保存时也不会把后端不认识的值写回去（见 savePolicy）。
 * ------------------------------------------------------------------------- */

const POLICY_DEFAULTS = { enforcementMode: 'observe', defaultBodyPolicy: 'full', peekBytes: 65536, peekTimeoutMs: 250, notifyBodyRatio: 0 };
// 与 internal/config/validate.go 的边界一致：超出范围保存会被后端拒绝，
// 前端先拦一次并给出中文提示。
const POLICY_LIMITS = {
  peekBytes: { min: 0, max: 4 * 1024 * 1024, low: 1024 },
  peekTimeoutMs: { min: 0, max: 10000, low: 50 },
  notifyBodyRatio: { min: 0, max: 1 },
};

// 执行模式：observe 只记录「本应拒绝」，不真的拒绝。
const ENFORCEMENT_OPTIONS = [
  { value: 'observe', label: '观察模式（observe）：只记录，不拒绝' },
  { value: 'enforce', label: '强制模式（enforce）：真的拒绝' },
];
const ENFORCEMENT_LABEL = { observe: '观察', enforce: '强制' };

// 全局默认策略只允许 full | peek | skip | grpc（grpc 会按 gRPC 首消息路径处理）。
const DEFAULT_POLICY_OPTIONS = [
  { value: 'full', label: '全量（full，fail-closed：形态上无法完整检查就拒绝）' },
  { value: 'peek', label: '偷看（peek，只检查前 PeekBytes 字节）' },
  { value: 'skip', label: '跳过（skip，只查 URI / 请求头）' },
  { value: 'grpc', label: 'gRPC（grpc，Content-Type 为 application/grpc* 时走首消息路径）' },
];
const DEFAULT_POLICY_SHORT = { full: '全量 full', peek: '偷看 peek', skip: '跳过 skip', grpc: 'gRPC grpc' };

// bodyState 的完整取值集合（缺项的按 0 展示，便于确认后端是否在计数）。
const BODY_STATE_KEYS = [
  { key: 'full', label: '全量检查', desc: '完整检查后转发' },
  { key: 'peeked', label: '部分检查', desc: '读满 PeekBytes / 超时' },
  { key: 'skipped', label: '声明跳过', desc: '只查 URI / 请求头' },
  { key: 'grpc-unary', label: 'gRPC 单消息', desc: '首消息 + EOF 完成判定' },
  { key: 'grpc-stream', label: 'gRPC 流式', desc: '只查首消息 + 帧校验' },
  { key: 'grpc-server-first', label: '服务端先说话', desc: '首消息等待超时后放行' },
  { key: 'frame-error', label: '帧错误', desc: '畸形 / 超长 / 截断帧' },
];
const BODY_STATE_ALIASES = {
  full: ['full', 'fullBody'],
  peeked: ['peeked', 'peek'],
  skipped: ['skipped', 'skip'],
  'grpc-unary': ['grpc-unary', 'grpcUnary', 'grpc_unary'],
  'grpc-stream': ['grpc-stream', 'grpcStream', 'grpc_stream'],
  'grpc-server-first': ['grpc-server-first', 'grpcServerFirst', 'grpc_server_first', 'serverFirst'],
  'frame-error': ['frame-error', 'frameError', 'frame_error', 'frameErrors'],
};
const NON_FULL_STATES = ['peeked', 'skipped', 'grpc-stream', 'grpc-server-first', 'frame-error'];

// FIELD_ALIASES 是「同一个语义字段的多种后端命名」兜底表：后端把字段放在
// config / stats / policy 任意一层、或换个写法时都能读到（命中未知命名会在
// 页面上注明，避免误以为数据缺失）。
const FIELD_ALIASES = {
  enforcementMode: ['enforcementMode', 'EnforcementMode', 'mode'],
  defaultBodyPolicy: ['defaultBodyPolicy', 'DefaultBodyPolicy', 'bodyPolicy'],
  peekBytes: ['peekBytes', 'PeekBytes', 'peekSize', 'peekLimit'],
  peekTimeoutMs: ['peekTimeoutMs', 'PeekTimeoutMS', 'PeekTimeoutMs', 'peekTimeout'],
  notifyBodyRatio: ['notifyBodyRatio', 'NotifyBodyRatio'],
  bodyState: ['bodyState', 'bodyStates', 'bodyStateCounts', 'bodyStateDist', 'bodyStateDistribution'],
  wouldReject: ['wouldReject', 'wouldRejects', 'wouldRejectSamples', 'wouldRejectList', 'wouldRejectItems', 'wouldRejectRecent', 'wouldRejectLog', 'wouldRejectCount'],
  undeclared: ['undeclaredRoutes', 'undeclaredBodyPolicyRoutes', 'undeclaredBodyPolicy', 'undeclared', 'missingBodyPolicy', 'routesWithoutBodyPolicy', 'unclaimedRoutes', 'inheritedRoutes'],
};

// COUNTER_FIELDS 是 stats.* 里请求体与拒绝计数的契约名（附 snake_case 兜底）。
// 只有真正的数字才会命中：根级 wouldReject 是样例数组，不能被当成计数。
const COUNTER_FIELDS = {
  bodyRequests: ['bodyRequests', 'body_requests'],
  bodyFull: ['bodyFull', 'body_full'],
  bodyNonFull: ['bodyNonFull', 'body_non_full'],
  bodyNonFullRatio: ['bodyNonFullRatio', 'body_non_full_ratio'],
  wouldReject: ['wouldReject', 'would_reject'],
  refused: ['refused'],
  wouldRejectKept: ['wouldRejectKept', 'would_reject_kept'],
  wouldRejectLimit: ['wouldRejectLimit', 'would_reject_limit'],
};

// GRPC_COUNTER_FIELDS 是 stats.grpc* 的契约名。
const GRPC_COUNTER_FIELDS = {
  grpcRequests: ['grpcRequests', 'grpc_requests'],
  grpcUnary: ['grpcUnary', 'grpc_unary'],
  grpcStream: ['grpcStream', 'grpc_stream'],
  grpcServerFirst: ['grpcServerFirst', 'grpc_server_first'],
  grpcFrameErrors: ['grpcFrameErrors', 'grpc_frame_errors'],
  grpcSecondMessage: ['grpcSecondMessage', 'grpc_second_message'],
  grpcMessages: ['grpcMessages', 'grpc_messages'],
  grpcCompressed: ['grpcCompressed', 'grpc_compressed'],
};

// GRPC_METRIC_KEYS 是策略卡片里 gRPC 统计行的展示项（缺失时显示 —）。
const GRPC_METRIC_KEYS = [
  { key: 'grpcRequests', label: 'requests', desc: '识别为 gRPC 的请求数' },
  { key: 'grpcUnary', label: 'unary', desc: '单消息（unary）请求数' },
  { key: 'grpcStream', label: 'stream', desc: '流式（stream）请求数' },
  { key: 'grpcServerFirst', label: 'server-first', desc: '服务端先说话、首消息等待超时的请求数' },
  { key: 'grpcFrameErrors', label: 'frame-errors', desc: '解析 gRPC 帧失败的请求数' },
  { key: 'grpcSecondMessage', label: 'second-message', desc: '单消息路由上出现第二条消息的次数' },
  { key: 'grpcMessages', label: 'messages', desc: '已解析的 gRPC 消息总数' },
  { key: 'grpcCompressed', label: 'compressed', desc: '带压缩标志的 gRPC 消息数' },
];

// REJECT_FILTERS 按 Violation.enforced 给样例分组：true=实际拒绝，false=观察期只记录。
const REJECT_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'enforced', label: '实际拒绝（enforced=true）' },
  { id: 'observe', label: '观察期本应拒绝（enforced=false）' },
  { id: 'unknown', label: '未返回 enforced' },
];

// BODY_STATE_LABEL 把 bodyState / policy 的取值翻成中文短标签。
const BODY_STATE_LABEL = {
  full: '全量',
  peeked: '部分',
  skipped: '跳过',
  'grpc-unary': 'gRPC 单消息',
  'grpc-stream': 'gRPC 流式',
  'grpc-server-first': '服务端先说话',
  'frame-error': '帧错误',
};

function bodyStateChip(value) {
  const key = String(value || '').trim();
  if (!key) return html`<span class="muted">-</span>`;
  const variant = (key === 'full' || key === 'grpc-unary') ? 'success' : ((key === 'skipped' || key === 'frame-error') ? 'danger' : 'warning');
  return html`<sl-badge pill variant=${variant}>${BODY_STATE_LABEL[key] || key}</sl-badge>`;
}

// routeOf 拼出「域名 + 路径」，后端 Violation 里这两项是分开的。
function routeOf(s) {
  const host = s.host || '';
  const uri = s.path || s.uri || s.url || '';
  if (!host) return uri;
  return host + uri;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function pickAlias(root, key) {
  const names = FIELD_ALIASES[key] || [key];
  const hosts = [root, root && root.policy, root && root.stats, root && root.status, root && root.extra];
  for (const host of hosts) {
    for (const name of names) {
      if (isPlainObject(host) && host[name] !== undefined && host[name] !== null) return { value: host[name], field: name };
    }
  }
  return { value: undefined, field: '' };
}

// pickAliasWhere 与 pickAlias 相同，但只接受满足 accept 的值。用于同一字段名
// 在不同层承载不同类型的情况（例如 wouldReject 既是计数也是样例数组）。
function pickAliasWhere(root, key, accept) {
  const names = FIELD_ALIASES[key] || [key];
  const hosts = [root, root && root.policy, root && root.stats, root && root.status, root && root.extra];
  for (const host of hosts) {
    for (const name of names) {
      if (isPlainObject(host) && host[name] !== undefined && host[name] !== null && accept(host[name])) {
        return { value: host[name], field: name };
      }
    }
  }
  return { value: undefined, field: '' };
}

function parseAliasedInt(root, key) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const n = Number(hit.value);
  return { value: isFinite(n) && n >= 0 ? Math.trunc(n) : null, field: hit.field };
}

// parseAliasedFloat 读浮点策略字段（notifyBodyRatio 是 0–1 的比例，不能截断成整数）。
function parseAliasedFloat(root, key) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const n = Number(hit.value);
  return { value: isFinite(n) ? n : null, field: hit.field };
}

function parseAliasedEnum(root, key, allowed) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const text = String(hit.value).trim();
  return { value: allowed.indexOf(text) >= 0 ? text : null, field: hit.field };
}

// normalizeBodyState 兼容三种形状：{full: 12} / [{state,count}] / {full:{count}}。
function normalizeBodyState(raw) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) continue;
      const name = item.state || item.name || item.key || item.bodyState || item.type;
      const value = numLike(item.count !== undefined ? item.count : (item.value !== undefined ? item.value : (item.total !== undefined ? item.total : item.n)));
      if (name !== undefined && name !== null && name !== '') out[String(name)] = value;
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const value = raw[key];
      if (isPlainObject(value)) {
        const inner = numLike(value.count !== undefined ? value.count : (value.value !== undefined ? value.value : value.total));
        if (inner !== null) out[key] = inner;
        continue;
      }
      const n = numLike(value);
      if (n !== null) out[key] = n;
    }
  }
  return out;
}

function numLike(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// statNumber 只接受数字或纯数字字符串：stats.wouldReject 是计数，而响应根级的
// wouldReject 是样例数组，用类型区分两者，避免把数组读成 0。
function statNumber(hosts, names) {
  for (const host of hosts) {
    if (!isPlainObject(host)) continue;
    for (const name of names) {
      const raw = host[name];
      if (typeof raw === 'number' && isFinite(raw)) return { value: raw, field: name };
      if (typeof raw === 'string' && raw.trim() !== '' && isFinite(Number(raw))) return { value: Number(raw), field: name };
    }
  }
  return { value: null, field: '' };
}

// readCounters 按契约名表读一组计数，返回 { key: { value, field } }。
function readCounters(hosts, table) {
  const out = {};
  for (const key of Object.keys(table)) out[key] = statNumber(hosts, table[key]);
  return out;
}

// fmtCount 缺值时显示占位符。
function fmtCount(value, missing) {
  return (value === null || value === undefined) ? (missing || '—') : String(value);
}

// bodyStateValue 按别名表取某个状态的计数。
function bodyStateValue(map, key) {
  for (const name of (BODY_STATE_ALIASES[key] || [key])) {
    if (map[name] !== undefined) return map[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) return map[k];
    }
  }
  return null;
}

// normalizeSamples 兼容三种形状：数组 / {items|samples|list} / 单条对象。
function normalizeSamples(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === 'object');
  if (isPlainObject(raw)) {
    for (const key of ['items', 'samples', 'list', 'entries', 'recent', 'records']) {
      if (Array.isArray(raw[key])) return raw[key].filter((x) => x && typeof x === 'object');
    }
    if (raw.rule || raw.path || raw.uri || raw.reason) return [raw];
  }
  return [];
}

// GRPC_STATUS_HINT 是 gRPC 状态码的中文含义。后端 Violation.grpcStatus 直接给出
// 数值，前端只负责显示，不再按 policy 猜；请求体检查最常返回 7 = PERMISSION_DENIED
// 与 8 = RESOURCE_EXHAUSTED（见 internal/modules/waf/grpc.go 的映射），其它值显示数字。
const GRPC_STATUS_HINT = {
  0: 'OK（成功，无错误）',
  1: 'CANCELLED（调用已被取消）',
  2: 'UNKNOWN（未知错误）',
  3: 'INVALID_ARGUMENT（参数无效）',
  4: 'DEADLINE_EXCEEDED（超过截止时间）',
  5: 'NOT_FOUND（目标不存在）',
  6: 'ALREADY_EXISTS（已存在）',
  7: 'PERMISSION_DENIED（拒绝访问：请求被 WAF 拦下）',
  8: 'RESOURCE_EXHAUSTED（资源耗尽：请求体过大 / 帧畸形截断）',
  9: 'FAILED_PRECONDITION（前置条件不满足）',
  10: 'ABORTED（操作被中止）',
  11: 'OUT_OF_RANGE（超出有效范围）',
  12: 'UNIMPLEMENTED（服务端未实现）',
  13: 'INTERNAL（服务端内部错误）',
  14: 'UNAVAILABLE（服务不可用）',
  15: 'DATA_LOSS（数据丢失）',
  16: 'UNAUTHENTICATED（未认证）',
};

// REJECT_REASON_LABEL 把 Violation.reason（决策行）翻成中文说明。
const REJECT_REASON_LABEL = {
  'content-length-unknown': 'Content-Length 未知：无法确认能完整检查请求体',
  'grpc-second-message': 'gRPC 出现第二个消息：单消息路由只接受一条',
  'grpc-encoding-unsupported': 'gRPC 压缩编码不支持',
  'grpc-frame-error': 'gRPC 帧错误：畸形 / 超长 / 截断',
  'rule-match': '命中 WAF 规则',
};

function grpcStatusOf(s) {
  const raw = (s && s.grpcStatus !== undefined && s.grpcStatus !== null) ? s.grpcStatus : (s ? s.grpcCode : undefined);
  const n = numLike(raw);
  return n === null ? null : Math.trunc(n);
}

function grpcStatusMeaning(code) {
  return GRPC_STATUS_HINT[code] || ('未知 gRPC 状态码 ' + code);
}

// sampleEnforced 直接读 Violation.enforced：true=实际拒绝，false=观察期只记录。
// 后端未返回该字段时才退回 action / blocked 推断，并在界面上标注是推断值。
function sampleEnforced(s) {
  const raw = s ? s.enforced : undefined;
  if (raw === true || raw === false) return { value: raw, inferred: false };
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return { value: true, inferred: false };
    if (t === 'false' || t === '0' || t === 'no') return { value: false, inferred: false };
  }
  const act = String((s && (s.action || s.disruption)) || '').toLowerCase();
  if (act) return { value: act.indexOf('block') >= 0 || act === 'deny', inferred: true };
  if (s && s.blocked !== undefined && s.blocked !== null) return { value: !!s.blocked, inferred: true };
  return { value: null, inferred: true };
}

// rejectStatusCell 渲染「本应返回」：
//   grpcStatus > 0 → HTTP <status> + grpc-status <code>，hover / 小字给出中文含义
//   grpcStatus = 0 → 只显示 HTTP status
//   字段缺失       → 退回旧的 policy=grpc* 推断分支，并标注为推断
function rejectStatusCell(s) {
  const statusRaw = (s && s.status !== undefined && s.status !== null && s.status !== '') ? s.status
    : ((s && s.statusCode !== undefined && s.statusCode !== null && s.statusCode !== '') ? s.statusCode : null);
  const statusText = statusRaw === null ? '' : String(statusRaw);
  const code = grpcStatusOf(s);
  if (code !== null && code > 0) {
    const meaning = grpcStatusMeaning(code);
    return html`<div title=${'grpc-status ' + code + ' = ' + meaning}>
      <sl-badge pill variant="warning">${(statusText ? 'HTTP ' + statusText + ' + ' : '') + 'grpc-status ' + code}</sl-badge>
      <div class="pwaf-label">${meaning}</div>
    </div>`;
  }
  if (code === null) {
    const policy = String((s && s.policy) || '');
    if (policy.indexOf('grpc') === 0) {
      const inferred = (s && s.secondMessage) ? 13 : 7;
      const meaning = grpcStatusMeaning(inferred);
      return html`<div title=${'后端未返回 grpcStatus，按 policy=' + policy + ' 推断：' + meaning}>
        <sl-badge pill variant="warning">${(statusText ? 'HTTP ' + statusText + ' + ' : '') + 'grpc-status ' + inferred + '（推断）'}</sl-badge>
        <div class="pwaf-label">${meaning}</div>
      </div>`;
    }
  }
  if (statusRaw === null) return html`<span class="muted">-</span>`;
  return html`<sl-badge pill variant="warning">${statusText}</sl-badge>`;
}

function enforcedCell(s) {
  const e = sampleEnforced(s);
  if (e.value === true) {
    return html`<div><sl-badge pill variant="danger">实际拒绝</sl-badge>
      <div class="pwaf-label">${e.inferred ? 'enforced=true（按 action 推断）' : 'enforced=true'}</div></div>`;
  }
  if (e.value === false) {
    return html`<div><sl-badge pill variant="warning">观察期记录</sl-badge>
      <div class="pwaf-label">${e.inferred ? 'enforced=false（按 action 推断）' : 'enforced=false'}</div></div>`;
  }
  return html`<div><sl-badge pill variant="warning">未知</sl-badge>
    <div class="pwaf-label">后端未返回 enforced</div></div>`;
}

// reasonCell 显示 Violation.reason（决策行），带中文含义；message 是给客户端看的文案。
function reasonCell(s) {
  const reason = String(s.reason || s.msg || '').trim();
  const message = String(s.message || '').trim();
  const label = REJECT_REASON_LABEL[reason];
  return html`<div>
    <div class="muted">${reason || message || '-'}</div>
    ${label ? html`<div class="pwaf-label">${label}</div>` : nothing}
    ${message && message !== reason ? html`<div class="pwaf-label">${message}</div>` : nothing}
  </div>`;
}

/* ------------------------------------------------------------------ 页面 */

class WafPage extends NuntElement {
  static properties = {
    configLoading: { type: Boolean },
    savingConfig: { type: Boolean },
    savingPolicy: { type: Boolean },
    rulesLoading: { type: Boolean },
    logsLoading: { type: Boolean },
    testBusy: { type: Boolean },
    ruleQuery: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.disposed = false;
    this.dialogs = new Set();
    this.dialogHosts = new Set();
    this.pollerStops = new Set();
    this.ruleTimer = null;
    this.ruleQuery = '';

    this.config = null;
    this.configError = null;
    this.configLoading = true;
    this.configForm = null;

    this.rules = [];
    this.rulesError = null;
    this.rulesLoading = true;

    this.logs = [];
    this.logsError = null;
    this.logsLoading = true;

    this.policy = null;
    this.policyStats = null;
    this.policyError = null;
    this.policyLoading = true;
    this.policyForm = null;
    this.policyRatioInvalid = false;
    this.fallback = {};
    this.compatNotes = [];
    this.webRules = null;
    this.webRulesError = null;
    this.rejectCount = 0;
    this.refusedCount = 0;
    this.rejectFilter = 'all';

    this.testForm = null;
    this.testResult = null;
    this.testBusy = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadConfig();
    this.loadRules();
    this.loadLogs();
    this.loadPolicy();
    this.pollerStops.add(makePoller(() => this.loadLogs(), 10000));
    this.pollerStops.add(makePoller(() => this.reloadPolicy(), 15000));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  firstUpdated() {
    this.buildTestForm();
    this.paintTest();
  }

  /** dispose 由 mount 返回的清理函数调用：停轮询、清对话框、移除元素。 */
  dispose() {
    this.disposed = true;
    if (this.ruleTimer) { clearTimeout(this.ruleTimer); this.ruleTimer = null; }
    for (const stop of Array.from(this.pollerStops)) {
      try { stop(); } catch (err) { /* 忽略 */ }
    }
    this.pollerStops.clear();
    for (const host of Array.from(this.dialogHosts)) {
      try { renderInto(host, nothing); } catch (err) { /* 忽略 */ }
    }
    this.dialogHosts.clear();
    for (const dialog of Array.from(this.dialogs)) {
      try { dialog.close(); } catch (err) { /* 忽略 */ }
    }
    this.dialogs.clear();
    this.remove();
  }

  host(name) {
    return this.querySelector('[data-host="' + name + '"]');
  }

  /* ---------------------------------------------------------------- 引擎配置 */

  buildConfigForm(cfg) {
    const c = cfg || {};
    this.configForm = formGrid([
      { name: 'enable', label: '总开关', type: 'switch', value: !!c.enable, text: '启用 WAF' },
      {
        name: 'mode',
        label: '模式',
        type: 'select',
        value: c.mode || 'detect',
        options: [
          { value: 'detect', label: '检测模式（只记录不拦截）' },
          { value: 'block', label: '拦截模式' },
        ],
      },
      { name: 'useCrs', label: '内置 CRS', type: 'switch', value: c.useCrs !== false, text: '使用内置 CRS 规则集' },
      { name: 'logOnly', label: '仅记录', type: 'switch', value: !!c.logOnly, text: '仅记录（不返回 403）' },
      { name: 'adminProtect', label: '保护后台', type: 'switch', value: c.adminProtect !== false, text: '保护后台管理接口' },
      {
        name: 'paranoiaLevel',
        label: 'CRS 等级 (PL)',
        type: 'select',
        value: String(c.paranoiaLevel || 1),
        options: levelOptions(),
        hint: '等级越高越严格，误报也越多',
      },
      { name: 'executingLevel', label: '执行等级', type: 'select', value: String(c.executingLevel || c.paranoiaLevel || 1), options: levelOptions() },
      { name: 'inboundThreshold', label: '入站阈值', type: 'number', value: Number(c.inboundThreshold) || 5, min: 0, hint: '异常分数达到该值触发' },
      { name: 'outboundThreshold', label: '出站阈值', type: 'number', value: Number(c.outboundThreshold) || 4, min: 0 },
      { name: 'bodyLimitKb', label: '请求体限制 (KB)', type: 'number', value: Number(c.bodyLimitKb) || 0, min: 0, placeholder: '0 表示默认' },
      legendField('legendExtra', '附加规则'),
      {
        name: 'extraRules',
        label: 'SecLang 规则片段',
        type: 'textarea',
        rows: 4,
        wide: true,
        value: c.extraRules || '',
        placeholder: '追加的 SecLang 规则，例如：' + LF + 'SecRule ARGS "@contains evil" "id:100001,phase:2,deny,status:403,msg:自定义规则"',
        hint: '保存后立即重新编译规则集',
      },
    ]);
    return this.configForm;
  }

  paintConfig() {
    const host = this.host('config');
    if (!host) return;
    if (this.configError) {
      renderInto(host, html`<nunt-error .error=${this.configError} heading="无法读取 WAF 配置" .onRetry=${() => this.loadConfig()}></nunt-error>`);
      return;
    }
    if (!this.config) {
      renderInto(host, html`<nunt-loading text="正在加载 WAF 配置…"></nunt-loading>`);
      return;
    }
    host.replaceChildren();
    host.appendChild(this.configForm.node);
    const hint = document.createElement('p');
    hint.className = 'pwaf-compat';
    hint.textContent = '保存时会把整份配置回传给 PUT /api/v1/waf/config（否则后端会把未提交的字段重置成零值）。';
    host.appendChild(hint);
  }

  async loadConfig() {
    this.configLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/waf/config');
      if (this.disposed) return;
      this.config = (data && data.config) ? data.config : (data || {});
      this.configError = null;
      this.buildConfigForm(this.config);
    } catch (err) {
      if (this.disposed) return;
      this.config = null;
      this.configError = err;
    } finally {
      if (!this.disposed) {
        this.configLoading = false;
        this.paintConfig();
      }
    }
  }

  async saveConfig() {
    if (!this.config || !this.configForm) { toast('配置尚未加载完成', 'warn'); return; }
    const values = this.configForm.read();
    const payload = Object.assign({}, this.config, {
      enable: !!values.enable,
      mode: String(values.mode || 'detect'),
      useCrs: !!values.useCrs,
      paranoiaLevel: numOf(values.paranoiaLevel, 1),
      executingLevel: numOf(values.executingLevel, 1),
      inboundThreshold: numOf(values.inboundThreshold, 5),
      outboundThreshold: numOf(values.outboundThreshold, 4),
      bodyLimitKb: numOf(values.bodyLimitKb, 0),
      logOnly: !!values.logOnly,
      adminProtect: !!values.adminProtect,
      extraRules: String(values.extraRules || ''),
    });
    if (this.rules.length) payload.disabledRules = this.computeDisabledRules();
    this.savingConfig = true;
    try {
      await this.ctx.api.put('/api/v1/waf/config', payload);
      if (this.disposed) return;
      toast('配置已保存', 'ok');
      await this.loadConfig();
      await this.loadRules();
    } catch (err) {
      if (this.disposed) return;
      toast('保存失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.savingConfig = false;
    }
  }

  /* ---------------------------------------------------------------- 规则文件 */

  // computeDisabledRules：勾选框状态 -> disabledRules。
  //
  // 迁移前是按「文件名」比对 disabledRules，而后端 disabledByRange 只认
  // 「起始-结束」的规则 ID 区间，所以那个勾选从来没生效过。这里用后端返回的
  // minId / maxId 组成区间；不是区间形态的历史条目（例如单个规则 id）原样保留。
  computeDisabledRules() {
    const base = ((this.config && this.config.disabledRules) || []).slice();
    const managed = this.rules.map((item) => item.range).filter(Boolean);
    const keep = base.filter((entry) => {
      const range = parseRange(entry);
      if (!range) return true;
      return !managed.some((text) => {
        const other = parseRange(text);
        return other && range[0] <= other[1] && range[1] >= other[0];
      });
    });
    const off = this.rules.filter((item) => !item.enabled).map((item) => item.range).filter(Boolean);
    return keep.concat(off);
  }

  setRuleEnabled(item, on) {
    if (item) item.enabled = !!on;
  }

  async loadRules() {
    this.rulesLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/waf/rules');
      if (this.disposed) return;
      this.rules = unwrap(data, ['rules', 'items', 'files', 'groups']).map((it) => ({
        id: wafRuleId(it),
        title: wafRuleTitle(it),
        count: wafRuleCount(it),
        range: ruleRange(it),
        // 「CRS 被整体关掉」不算用户取消勾选，否则保存时会把所有文件都写进 disabledRules。
        enabled: it.enabled !== false || it.reason === 'crs disabled',
        raw: it,
      })).filter((it) => it.id);
      this.rulesError = null;
    } catch (err) {
      if (this.disposed) return;
      this.rules = [];
      this.rulesError = err;
    } finally {
      if (!this.disposed) {
        this.rulesLoading = false;
        this.paintRules();
      }
    }
  }

  onRuleSearch(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.ruleTimer) clearTimeout(this.ruleTimer);
    this.ruleTimer = setTimeout(() => {
      this.ruleTimer = null;
      if (this.disposed) return;
      this.ruleQuery = value;
      this.paintRules();
    }, 200);
  }

  paintRules() {
    const host = this.host('rules');
    if (!host) return;
    if (this.rulesError) {
      renderInto(host, html`<nunt-error .error=${this.rulesError} heading="无法读取规则文件列表" .onRetry=${() => this.loadRules()}></nunt-error>`);
      return;
    }
    if (this.rulesLoading && !this.rules.length) {
      renderInto(host, html`<nunt-loading text="正在加载规则列表…"></nunt-loading>`);
      return;
    }
    if (!this.rules.length) {
      renderInto(host, html`<nunt-empty text="未获取到规则文件列表"
        hint="可能未启用 CRS，或模块未实现该接口。"></nunt-empty>`);
      return;
    }
    const q = this.ruleQuery.trim().toLowerCase();
    const list = this.rules.filter((it) => !q || (it.title + ' ' + it.id).toLowerCase().indexOf(q) >= 0);
    if (!list.length) {
      renderInto(host, html`<nunt-empty text="没有匹配的规则文件" hint="换个关键字试试。"></nunt-empty>`);
      return;
    }
    renderInto(host, html`
      <div class="pwaf-scroll">
        ${list.map((item) => html`<div class="pwaf-rule">
          <sl-checkbox size="small" ?checked=${item.enabled}
            @sl-change=${(event) => this.setRuleEnabled(item, !!event.target.checked)}>${item.title}</sl-checkbox>
          <span class="pwaf-id">${item.id}</span>
          <span class="spacer"></span>
          ${item.count === undefined || item.count === null ? nothing : html`<sl-badge pill variant="neutral">${String(item.count)} 条</sl-badge>`}
        </div>`)}
      </div>
      <div class="pwaf-compat">取消勾选表示禁用该规则文件 / 规则组，保存后写入 disabledRules（规则 ID 区间）并重新编译。</div>`);
  }

  /* ---------------------------------------------------------------- 拦截日志 */

  logColumns() {
    return [
      { key: 'time', title: '时间', width: 180, render: (l) => html`<span class="muted">${fmtTime(l.time || l.ts || l.at)}</span>` },
      {
        key: 'action',
        title: '动作',
        width: 110,
        render: (l) => {
          const act = (l.action || l.disruption || (l.blocked ? 'block' : 'detect'));
          const blocked = String(act).indexOf('block') >= 0 || !!l.blocked;
          return html`<sl-badge pill variant=${blocked ? 'danger' : 'warning'}>${String(act).toUpperCase()}</sl-badge>`;
        },
      },
      { key: 'ip', title: '客户端', width: 150, render: (l) => html`<span class="mono">${l.ip || l.clientIp || l.remoteAddr || '-'}</span>` },
      {
        key: 'request',
        title: '请求',
        render: (l) => html`<span class="mono pwaf-hit-tag">${(l.method || '-') + ' ' + (l.path || l.uri || l.url || '-')}</span>`,
      },
      { key: 'rules', title: '规则', width: 170, render: (l) => chipList(ruleIdsOf(l), 3) },
      { key: 'message', title: '说明', render: (l) => html`<span class="muted">${l.message || l.msg || l.reason || '-'}</span>` },
    ];
  }

  async loadLogs() {
    this.logsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/waf/logs', { limit: 200 });
      if (this.disposed) return;
      this.logs = unwrap(data, ['logs', 'items']);
      this.logsError = null;
    } catch (err) {
      if (this.disposed) return;
      this.logs = [];
      this.logsError = err;
    } finally {
      if (!this.disposed) {
        this.logsLoading = false;
        this.paintLogs();
      }
    }
  }

  paintLogs() {
    const host = this.host('logs');
    if (!host) return;
    renderInto(host, html`<nunt-table caption="WAF 拦截日志"
      .columns=${this.logColumns()} .rows=${this.logs} .loading=${this.logsLoading}
      .error=${this.logsError} .onRetry=${() => this.loadLogs()}
      .rowKey=${(row, index) => String(index)}
      empty="暂无拦截日志"
      emptyHint="检测 / 拦截模式下，WAF 记下的请求会出现在这里。"></nunt-table>`);
  }

  /* ---------------------------------------------------------------- 请求测试 */

  buildTestForm() {
    this.testForm = formGrid([
      {
        name: 'method',
        label: '方法',
        type: 'select',
        value: 'GET',
        options: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m })),
      },
      { name: 'url', label: 'URL', wide: true, value: '', placeholder: '/admin?id=1 union select 1 或完整 URL' },
      { name: 'body', label: '请求体', type: 'textarea', rows: 2, wide: true, value: '', placeholder: '请求体（POST/PUT 时填写）' },
    ]);
    const host = this.host('testForm');
    if (host) { host.replaceChildren(); host.appendChild(this.testForm.node); }
  }

  async runTest() {
    if (!this.testForm) return;
    const values = this.testForm.read();
    const url = String(values.url || '').trim();
    if (!url) { this.testForm.fieldError('url', '请填写要测试的 URL'); return; }
    this.testForm.clearErrors();
    this.testBusy = true;
    this.testResult = { loading: true };
    this.paintTest();
    try {
      // 提交体与迁移前一致（method / url / body）；迁移前还多带了一个 path 别名，
      // 而后端 testRequest 没有这个字段、rest.Decode 又是 DisallowUnknownFields，
      // 于是「请求测试」从来没能成功提交过。这里去掉那个多余的别名。
      const res = await this.ctx.api.post('/api/v1/waf/test', {
        method: String(values.method || 'GET'),
        url,
        body: String(values.body || ''),
      });
      if (this.disposed) return;
      this.testResult = { data: res || {} };
    } catch (err) {
      if (this.disposed) return;
      this.testResult = { error: err };
    } finally {
      if (!this.disposed) {
        this.testBusy = false;
        this.paintTest();
      }
    }
  }

  paintTest() {
    const host = this.host('testResult');
    if (!host) return;
    const result = this.testResult;
    if (!result) { renderInto(host, nothing); return; }
    if (result.loading) { renderInto(host, html`<nunt-loading text="正在检测…" compact></nunt-loading>`); return; }
    if (result.error) {
      renderInto(host, html`<nunt-error .error=${result.error} heading="检测失败" .onRetry=${() => this.runTest()}></nunt-error>`);
      return;
    }
    const data = result.data || {};
    const blocked = !!(data.blocked || data.interrupted || data.action === 'block' || data.disruption);
    const ids = ruleIdsOf(data);
    const score = data.score !== undefined ? String(data.score) : (data.anomalyScore !== undefined ? String(data.anomalyScore) : '-');
    const rows = [
      { key: 'matched', label: '命中规则数', node: String(ids.length || (data.matchedCount || 0)) },
      { key: 'ids', label: '规则 ID', node: ids.length ? chipList(ids, 12) : html`<span class="muted">-</span>` },
      { key: 'score', label: '异常分数', node: score },
      { key: 'action', label: '动作', node: String(data.action || data.disruption || '-') },
      { key: 'status', label: 'HTTP 状态', node: String(data.status !== undefined ? data.status : '-') },
    ];
    renderInto(host, html`<div class="pwaf-result">
      <div class="row">
        ${blocked ? html`<sl-badge pill variant="danger">已被拦截</sl-badge>` : html`<sl-badge pill variant="success">未拦截</sl-badge>`}
        <span class="muted">${data.message || data.msg || ''}</span>
      </div>
      <div class="pwaf-sub">
        <nunt-table caption="请求测试结果" .rows=${rows}
          .columns=${[
            { key: 'label', title: '项目', width: 140, render: (row) => html`<span class="muted">${row.label}</span>` },
            { key: 'node', title: '值', render: (row) => row.node },
          ]}
          .rowKey=${(row) => row.key}></nunt-table>
      </div>
    </div>`);
  }

  /* ---------------------------------------------------------------- 策略：读取 */

  // refreshWebRules 取一次 Web 规则，用于「未声明 bodyPolicy 的路由」列表。
  async refreshWebRules() {
    try {
      const data = await this.ctx.api.get('/api/v1/web/rules');
      this.webRules = unwrap(data, ['rules', 'items']);
      this.webRulesError = null;
    } catch (err) {
      this.webRules = null;
      this.webRulesError = err;
    }
  }

  // readPolicy 从 GET /waf/config 的返回里解析策略字段，命中未知命名时记录提示。
  readPolicy(root, fallback) {
    const f = { mode: false, policy: false, peekBytes: false, peekTimeoutMs: false, notifyBodyRatio: false };
    const enforce = parseAliasedEnum(root, 'enforcementMode', ['observe', 'enforce']);
    const dflt = parseAliasedEnum(root, 'defaultBodyPolicy', ['full', 'peek', 'skip', 'grpc']);
    const bytes = parseAliasedInt(root, 'peekBytes');
    const timeout = parseAliasedInt(root, 'peekTimeoutMs');
    const ratio = parseAliasedFloat(root, 'notifyBodyRatio');
    f.mode = enforce.value === null;
    f.policy = dflt.value === null;
    f.peekBytes = bytes.value === null;
    f.peekTimeoutMs = timeout.value === null;
    // notifyBodyRatio 的零值带 omitempty：后端在 0（关闭）时不会回传该字段，
    // 因此这里的「缺失」同时覆盖「后端确实没有该字段」与「当前就是 0」，界面上
    // 按 0 显示并注明后端未返回；保存时始终提交输入值（见 savePolicy）。
    f.notifyBodyRatio = ratio.value === null;
    const notes = [];
    if (enforce.field && enforce.field !== 'enforcementMode') notes.push('enforcementMode ← ' + enforce.field);
    if (dflt.field && dflt.field !== 'defaultBodyPolicy') notes.push('defaultBodyPolicy ← ' + dflt.field);
    if (bytes.field && bytes.field !== 'peekBytes') notes.push('peekBytes ← ' + bytes.field);
    if (timeout.field && timeout.field !== 'peekTimeoutMs') notes.push('peekTimeoutMs ← ' + timeout.field);
    if (ratio.field && ratio.field !== 'notifyBodyRatio') notes.push('notifyBodyRatio ← ' + ratio.field);
    return {
      values: {
        enforcementMode: enforce.value === null ? fallback.enforcementMode : enforce.value,
        defaultBodyPolicy: dflt.value === null ? fallback.defaultBodyPolicy : dflt.value,
        peekBytes: bytes.value === null ? fallback.peekBytes : bytes.value,
        peekTimeoutMs: timeout.value === null ? fallback.peekTimeoutMs : timeout.value,
        notifyBodyRatio: ratio.value === null ? fallback.notifyBodyRatio : ratio.value,
      },
      fallback: f,
      notes: notes,
    };
  }

  // readPolicyStats 解析 bodyState 分布、拒绝计数、gRPC 指标、wouldReject 样例与
  // 未声明路由列表。计数只认数字、样例只认数组，两者不会互相遮蔽。
  readPolicyStats(root) {
    const bodyHit = pickAlias(root, 'bodyState');
    const sampleHit = pickAliasWhere(root, 'wouldReject', (v) => Array.isArray(v) || isPlainObject(v));
    const undeclaredHit = pickAlias(root, 'undeclared');
    const hosts = [root && root.stats, root && root.config, root, root && root.policy, root && root.status, root && root.extra];
    const counters = readCounters(hosts, COUNTER_FIELDS);
    const grpc = readCounters(hosts, GRPC_COUNTER_FIELDS);
    const states = normalizeBodyState(bodyHit.value);
    const samples = normalizeSamples(sampleHit.value);
    let rejectCount = counters.wouldReject.value;
    if (rejectCount === null) {
      const inner = isPlainObject(sampleHit.value)
        ? numLike(sampleHit.value.count !== undefined ? sampleHit.value.count : sampleHit.value.total) : null;
      rejectCount = inner === null ? samples.length : Math.max(inner, samples.length);
    }
    let refused = counters.refused.value;
    if (refused === null) {
      refused = samples.filter((s) => sampleEnforced(s).value === true).length;
    }
    return {
      states,
      samples,
      counters,
      grpc,
      rejectCount: rejectCount,
      refusedCount: refused,
      undeclaredFromConfig: Array.isArray(undeclaredHit.value) ? undeclaredHit.value.filter(Boolean) : [],
      undeclaredField: undeclaredHit.field,
      fields: {
        bodyState: bodyHit.field,
        wouldReject: counters.wouldReject.field || sampleHit.field,
        wouldRejectSamples: sampleHit.field,
        refused: counters.refused.field,
        undeclared: undeclaredHit.field,
      },
    };
  }

  sumStates(states) {
    let total = 0;
    for (const name of Object.keys(states)) {
      const v = numLike(states[name]);
      if (v !== null) total += v;
    }
    return total;
  }

  nonFullCount(states) {
    let n = 0;
    for (const key of NON_FULL_STATES) {
      const v = bodyStateValue(states, key);
      if (v !== null) n += v;
    }
    return n;
  }

  // undeclaredRoutes 直接使用后端字段 undeclaredRoutes（routeView：id/name/path/
  // type/waf）；只有该字段整体缺失时才退回从 GET /web/rules 推导（enable 且
  // bodyPolicy 为空的规则即未声明）。列表会标注当前用的是哪种来源。
  undeclaredRoutes(stats) {
    const s = stats || {};
    if (s.undeclaredFromConfig && s.undeclaredFromConfig.length) {
      return {
        source: 'config',
        list: s.undeclaredFromConfig.map((item, i) => {
          if (isPlainObject(item)) {
            return {
              id: String(item.id || item.ruleId || item.name || ('#' + (i + 1))),
              name: String(item.name || item.rule || item.path || ''),
              path: String(item.path || item.uri || '/'),
              type: String(item.type || ''),
              waf: (item.waf === undefined || item.waf === null) ? true : !!item.waf,
            };
          }
          return { id: String(item), name: '', path: '/', type: '', waf: true };
        }),
      };
    }
    if (s.undeclaredField) {
      // 字段存在但是空数组：后端明确表示没有未声明的路由，不必再去推导。
      return { list: [], source: 'config-empty' };
    }
    if (this.webRules) {
      return {
        source: 'webRules',
        list: this.webRules
          .filter((r) => r && r.enable !== false && !String(r.bodyPolicy || '').trim())
          .map((r) => ({
            id: String(r.id || ''),
            name: String(r.name || ''),
            path: String(r.path || '/'),
            type: String(r.type || ''),
            waf: r.waf !== false,
          })),
      };
    }
    return { list: [], source: this.webRulesError ? 'error' : 'none' };
  }

  // undeclaredSourceNote 说明未声明路由列表来自后端字段还是前端推导。
  undeclaredSourceNote(source) {
    if (source === 'config') return '来源：后端 GET /api/v1/waf/config 的 undeclaredRoutes 字段（元素含 id / name / path / type / waf）。';
    if (source === 'config-empty') return '来源：后端 undeclaredRoutes 字段（本次为空，表示没有未声明 bodyPolicy 的启用路由）。';
    if (source === 'webRules') return '来源：后端未返回 undeclaredRoutes 字段，此处由 GET /web/rules 推导（enable 且 bodyPolicy 为空的规则），仅供参考。';
    if (source === 'error') return '来源：后端未返回 undeclaredRoutes 字段，且 GET /web/rules 读取失败，无法列出未声明路由。';
    return '来源：既没有 undeclaredRoutes 字段，也拿不到 GET /web/rules，暂时无法列出未声明路由。';
  }

  /* ---------------------------------------------------------------- 策略：渲染 */

  buildPolicyForm(cfg) {
    const peekHint = document.createElement('div');
    peekHint.className = 'pwaf-compat';
    peekHint.textContent = 'peek 策略读满 ' + fmtBytes(numOf(cfg.peekBytes, POLICY_DEFAULTS.peekBytes)) + ' 或空闲 ' +
      numOf(cfg.peekTimeoutMs, POLICY_DEFAULTS.peekTimeoutMs) + 'ms 就先检查已到达的部分，其余字节流式透传（bodyState=peeked）；' +
      '只有声明了 peek 的路由会用到这两个参数。';
    const ratioHint = document.createElement('div');
    ratioHint.className = 'pwaf-compat';
    this.policyRatioInvalid = false;

    const form = formGrid([
      {
        name: 'enforcementMode',
        label: '执行模式',
        type: 'select',
        value: cfg.enforcementMode,
        options: ENFORCEMENT_OPTIONS,
        hint: cfg.enforcementMode === 'enforce'
          ? '强制模式（enforce）：形态上无法完整检查的请求会被真的拒绝（例如 Content-Length 未知的请求返回 411）。'
          : '观察模式（observe）：只记录「本应拒绝」，请求照常放行——用于上线前扫出漏声明的路由。',
        onChange: (value) => this.paintPolicyWarnings(String(value || 'observe')),
      },
      {
        name: 'defaultBodyPolicy',
        label: '默认请求体策略（未声明 bodyPolicy 的路由使用）',
        type: 'select',
        value: cfg.defaultBodyPolicy,
        options: DEFAULT_POLICY_OPTIONS,
        hint: '默认 full 是 fail-closed：攻击者只能通过改变请求形态落到「拒绝」，不存在自动降级为部分检查的路径。',
      },
      {
        name: 'peekBytes',
        label: 'PeekBytes（peek 检查的字节数）',
        type: 'number',
        value: Number(cfg.peekBytes),
        min: POLICY_LIMITS.peekBytes.min,
        max: POLICY_LIMITS.peekBytes.max,
        step: 1024,
        placeholder: '65536',
        onChange: () => this.syncPeekHint(peekHint),
      },
      {
        name: 'peekTimeoutMs',
        label: 'PeekTimeoutMS（空闲超时，毫秒）',
        type: 'number',
        value: Number(cfg.peekTimeoutMs),
        min: POLICY_LIMITS.peekTimeoutMs.min,
        max: POLICY_LIMITS.peekTimeoutMs.max,
        step: 50,
        placeholder: '250',
        onChange: () => this.syncPeekHint(peekHint),
      },
      {
        name: 'notifyBodyRatio',
        label: '非 full 占比告警阈值',
        type: 'number',
        value: Number(cfg.notifyBodyRatio),
        min: POLICY_LIMITS.notifyBodyRatio.min,
        max: POLICY_LIMITS.notifyBodyRatio.max,
        step: 0.05,
        placeholder: '0',
        hint: '0=关闭；取值 0 – 1，例如 0.3 表示非 full 占比超过 30% 时告警（严格大于才发）。告警经通知模块发送，同一进程每小时最多一次，样本少于 50 条不发。',
        onChange: () => this.syncRatioHint(form, ratioHint),
      },
      { name: 'peekHint', label: false, type: 'custom', wide: true, node: peekHint },
      { name: 'ratioHint', label: false, type: 'custom', wide: true, node: ratioHint },
    ]);
    return form;
  }

  syncPeekHint(node) {
    if (!node || !this.policyForm) return;
    const values = this.policyForm.read();
    const bytes = numOf(values.peekBytes, POLICY_DEFAULTS.peekBytes);
    const ms = numOf(values.peekTimeoutMs, POLICY_DEFAULTS.peekTimeoutMs);
    node.textContent = 'peek 策略读满 ' + fmtBytes(bytes) + ' 或空闲 ' + ms +
      'ms 就先检查已到达的部分，其余字节流式透传（bodyState=peeked）；只有声明了 peek 的路由会用到这两个参数。';
  }

  // syncRatioHint：非法输入 → 字段级红字错误；后端未返回该字段 → 黄字说明。
  // 只在「合法 ↔ 非法」翻转时调用 form.fieldError，避免每次按键都重渲染表单。
  syncRatioHint(form, hintNode) {
    if (!form) return;
    const values = form.read();
    const lim = POLICY_LIMITS.notifyBodyRatio;
    const raw = String(values.notifyBodyRatio === undefined || values.notifyBodyRatio === null ? '' : values.notifyBodyRatio).trim();
    const num = raw === '' ? POLICY_DEFAULTS.notifyBodyRatio : Number(raw);
    const invalid = raw !== '' && (!isFinite(num) || num < lim.min || num > lim.max);
    if (invalid !== this.policyRatioInvalid) {
      this.policyRatioInvalid = invalid;
      form.fieldError('notifyBodyRatio', invalid
        ? '取值必须是 ' + lim.min + ' – ' + lim.max + ' 之间的数字（0 表示关闭），当前输入非法，保存会被拦下。'
        : '');
    }
    if (hintNode) {
      hintNode.textContent = this.fallback.notifyBodyRatio
        ? '后端未返回 notifyBodyRatio（0 时后端按 omitempty 省略），这里按 0（关闭）显示；填入非 0 值保存后即写入配置。'
        : (num > 0 ? '当前阈值 ' + (Math.round(num * 1000) / 10) + '%：非 full 占比严格大于该值、且样本数 ≥ 50 时发一条告警。' : '');
    }
  }

  // paintPolicyWarnings：后端缺失字段提示 + enforce 模式的提醒卡。
  paintPolicyWarnings(mode) {
    const host = this.host('policyWarn');
    if (!host) return;
    const missing = [];
    if (this.fallback.mode) missing.push('enforcementMode');
    if (this.fallback.policy) missing.push('defaultBodyPolicy');
    if (this.fallback.peekBytes) missing.push('peekBytes');
    if (this.fallback.peekTimeoutMs) missing.push('peekTimeoutMs');
    const cards = [];
    if (missing.length) {
      cards.push({
        title: '后端尚未返回这些字段：' + missing.join('、'),
        text: '界面按 CONTRACT.md 第 8 节的默认值显示（observe / full / 65536 / 250）。' +
          '这种情况下「保存策略」不会把这些字段写回配置，避免把默认值当成你的选择落盘；等后端把字段加进 model.WAFConfig 后自动生效。',
      });
    }
    if (String(mode || 'observe') === 'enforce') {
      cards.push({
        title: '当前是强制模式（enforce）：不符合策略的请求会被拒绝',
        text: '确认「未声明 bodyPolicy 的路由」已经补齐；下面列出它们，点「去 Web 规则页设置」可以逐个声明。' +
          '观察期累计「本应拒绝」（enforced=false）：' + fmtCount(numLike(this.rejectCount), '0') + ' 条；已实际拒绝（enforced=true）：' +
          fmtCount(numLike(this.refusedCount), '0') + ' 条（切换前请确认已看完）。',
      });
    }
    if (!cards.length) { renderInto(host, nothing); return; }
    renderInto(host, html`<div>
      ${cards.map((card) => html`<div class="notice">
        <div class="pwaf-sub-title">${card.title}</div>
        <div>${card.text}</div>
      </div>`)}
    </div>`);
  }

  countedValue(key) {
    const counters = (this.policyStats && this.policyStats.counters) || {};
    return counters[key] ? counters[key].value : null;
  }

  paintBodyStates() {
    const host = this.host('policyStates');
    if (!host) return;
    const stats = this.policyStats || { states: {} };
    const states = stats.states || {};
    const totalRaw = this.countedValue('bodyRequests');
    const fullRaw = this.countedValue('bodyFull');
    const nonFullRaw = this.countedValue('bodyNonFull');
    const ratioRaw = this.countedValue('bodyNonFullRatio');
    const total = totalRaw === null ? this.sumStates(states) : totalRaw;
    const nonFull = nonFullRaw === null ? this.nonFullCount(states) : nonFullRaw;
    const ratio = ratioRaw === null ? (total ? nonFull / total : 0) : ratioRaw;
    const pct = Math.round(ratio * 1000) / 10;
    renderInto(host, html`<div class="pwaf-sub">
      <div class="row">
        <span class="pwaf-sub-title">bodyState 分布</span>
        <span class="pwaf-coverage muted">${total ? ('总样本 ' + total + '，非 full 占比 ' + pct + '%') : '暂无样本'}</span>
      </div>
      ${!total
        ? html`<nunt-empty text="暂无 bodyState 计数" hint="可能还没有流量，或后端尚未暴露该字段。"></nunt-empty>`
        : html`
          <div class="pwaf-states">
            ${BODY_STATE_KEYS.map((item) => {
              const value = bodyStateValue(states, item.key);
              const count = value === null ? 0 : value;
              return html`<div class="pwaf-state ${count ? '' : 'zero'}" title=${item.key + '：' + item.desc}>
                <span class="k">${item.label}</span>
                <span class="v">${String(count)}</span>
                <span class="s">${item.key + (value === null ? '（后端未返回）' : '')}</span>
              </div>`;
            })}
          </div>
          <div class="pwaf-compat">后端计数：bodyRequests ${fmtCount(totalRaw)}，bodyFull ${fmtCount(fullRaw)}，bodyNonFull ${fmtCount(nonFullRaw)}，bodyNonFullRatio ${ratioRaw === null ? '—' : (Math.round(ratioRaw * 1000) / 10 + '%')}</div>
          ${nonFull > 0
            ? html`<div class="pwaf-label">非 full 的请求表示检查存在缺口（peek 只覆盖前若干字节，skip / grpc-stream 只覆盖首消息或请求头）；这些请求仍然会被 WAF 的 URI / 请求头检查覆盖。</div>`
            : nothing}`}
    </div>`);
  }

  // paintRejectCounters：stats.refused（真的拒绝）与 stats.wouldReject（观察期只记录）
  // 两个计数，并给出环形缓冲的容量提示（wouldRejectKept / wouldRejectLimit）。
  paintRejectCounters() {
    const host = this.host('policyCounters');
    if (!host) return;
    const refused = this.countedValue('refused');
    const would = this.countedValue('wouldReject');
    const kept = this.countedValue('wouldRejectKept');
    const limit = this.countedValue('wouldRejectLimit');
    renderInto(host, html`<div class="pwaf-sub">
      <div class="row">
        <span class="pwaf-sub-title">拒绝计数</span>
        <span class="pwaf-coverage muted">stats.refused / stats.wouldReject</span>
      </div>
      <div class="pwaf-states">
        <div class="pwaf-state" title="enforced=true：请求真的被拒绝（stats.refused）">
          <span class="k">实际拒绝</span><span class="v">${fmtCount(refused, '0')}</span><span class="s">enforced=true</span>
        </div>
        <div class="pwaf-state" title="enforced=false：观察期只记录，请求照常放行（stats.wouldReject）">
          <span class="k">观察期本应拒绝</span><span class="v">${fmtCount(would, '0')}</span><span class="s">enforced=false</span>
        </div>
        <div class="pwaf-state" title="环形缓冲里保留的样例数 / 缓冲上限（stats.wouldRejectKept / wouldRejectLimit）">
          <span class="k">样例缓存</span><span class="v">${fmtCount(kept) + ' / ' + fmtCount(limit)}</span><span class="s">wouldRejectKept / Limit</span>
        </div>
      </div>
      ${(kept !== null && limit !== null && limit > 0 && kept >= limit)
        ? html`<div class="pwaf-label">样例缓存已写满：更早的拒绝记录已被覆盖，但上面的计数仍是累计值。</div>`
        : nothing}
    </div>`);
  }

  // paintGRPCStats：stats.grpc* 一行（requests / unary / stream / server-first /
  // frame-errors / second-message / messages / compressed），缺失时显示 —。
  paintGRPCStats() {
    const host = this.host('policyGrpc');
    if (!host) return;
    const grpc = (this.policyStats && this.policyStats.grpc) || {};
    const value = (key) => (grpc[key] ? grpc[key].value : null);
    const any = GRPC_METRIC_KEYS.some((item) => value(item.key) !== null);
    renderInto(host, html`<div class="pwaf-sub">
      <div class="row">
        <span class="pwaf-sub-title">gRPC 统计</span>
        <span class="pwaf-coverage muted">${any ? 'stats.grpc*（requests 为 0 表示还没有 gRPC 流量）' : '后端未返回 gRPC 计数（stats.grpc*）'}</span>
      </div>
      <div class="pwaf-grpc">
        ${GRPC_METRIC_KEYS.map((item) => {
          const v = value(item.key);
          return html`<span class="pwaf-grpc-item ${v === null ? 'miss' : ''}" title=${item.desc + '（stats.' + item.key + '）'}>
            <span class="k">${item.label}</span><span class="v">${fmtCount(v)}</span>
          </span>`;
        })}
      </div>
    </div>`);
  }

  // paintRejects：拒绝样例分区，按 Violation.enforced 分组（true=实际拒绝，
  // false=观察期本应拒绝），可用上方按钮按分组筛选。
  paintRejects() {
    const host = this.host('policyRejects');
    if (!host) return;
    const stats = this.policyStats || { samples: [] };
    const samples = stats.samples || [];
    const groups = { all: samples, enforced: [], observe: [], unknown: [] };
    for (const s of samples) {
      const v = sampleEnforced(s).value;
      if (v === true) groups.enforced.push(s);
      else if (v === false) groups.observe.push(s);
      else groups.unknown.push(s);
    }
    const active = groups[this.rejectFilter] ? this.rejectFilter : 'all';
    this.rejectFilter = active;
    const refused = numLike(stats.refusedCount);
    const would = numLike(stats.rejectCount);
    const kept = this.countedValue('wouldRejectKept');
    const limit = this.countedValue('wouldRejectLimit');
    const summary = '实际拒绝 refused ' + fmtCount(refused, '0') + '（enforced=true）｜观察期本应拒绝 wouldReject ' + fmtCount(would, '0') +
      '（enforced=false）｜样例 ' + samples.length + ' 条' +
      ((kept === null && limit === null) ? '' : '，样例缓存 ' + fmtCount(kept) + ' / ' + fmtCount(limit));

    const columns = [
      { key: 'enforced', title: '判定', width: 150, render: (s) => enforcedCell(s) },
      {
        key: 'rule',
        title: '规则',
        render: (s) => html`<div>
          <div>${s.rule || s.ruleName || s.ruleId || s.site || '-'}</div>
          <div class="pwaf-hit-tag">${routeOf(s)}</div>
        </div>`,
      },
      {
        key: 'request',
        title: '请求',
        render: (s) => html`<span class="mono pwaf-hit-tag">${(s.method ? s.method + ' ' : '') + (s.uri || s.path || s.url || '-')}</span>`,
      },
      { key: 'reason', title: '原因', render: (s) => reasonCell(s) },
      {
        key: 'policy',
        title: '策略 / 状态',
        width: 170,
        render: (s) => html`<div class="row">
          ${bodyStateChip(String(s.policy || s.bodyPolicy || ''))}
          ${s.bodyState ? bodyStateChip(String(s.bodyState)) : nothing}
        </div>`,
      },
      { key: 'status', title: '本应返回', width: 210, render: (s) => rejectStatusCell(s) },
      { key: 'client', title: '客户端', width: 140, render: (s) => html`<span class="mono">${s.clientIp || s.ip || s.remoteAddr || '-'}</span>` },
      { key: 'time', title: '时间', width: 180, render: (s) => html`<span>${fmtTime(s.time || s.ts || s.at || s.timestamp)}</span>` },
    ];
    const rows = groups[active];

    renderInto(host, html`<div class="pwaf-sub">
      <div class="row">
        <span class="pwaf-sub-title">拒绝样例（按 enforced 分组）</span>
        <span class="pwaf-coverage muted">${summary}</span>
      </div>
      <div class="pwaf-filters">
        ${REJECT_FILTERS.map((item) => html`<sl-button size="small"
          variant=${active === item.id ? 'primary' : 'default'}
          @click=${() => { this.rejectFilter = item.id; this.paintRejects(); }}>${item.label + '（' + groups[item.id].length + '）'}</sl-button>`)}
      </div>
      ${!samples.length
        ? html`<nunt-empty text="暂无拒绝记录" hint=${numLike(stats.rejectCount)
          ? '后端返回了计数 ' + stats.rejectCount + '，但没有样例详情；请确认响应根级的 wouldReject 数组（[]Violation）是否一起返回。'
          : '观察模式下本应被拒绝的请求记为 enforced=false，强制模式下真的被拒绝的记为 enforced=true。'}></nunt-empty>`
        : (!rows.length
          ? html`<nunt-empty text="该分组下没有样例" compact></nunt-empty>`
          : html`<nunt-table caption="拒绝样例" .columns=${columns} .rows=${rows}
              .rowKey=${(row, index) => String(index)}></nunt-table>`)}
    </div>`);
  }

  // rejectRuleIds 统计 wouldReject 样例里出现过的规则名（每个记条数）。
  rejectRuleIds() {
    const map = {};
    for (const s of (this.policyStats && this.policyStats.samples) || []) {
      const name = s.rule || s.ruleName || s.ruleId || s.site || '';
      if (!name) continue;
      map[name] = (map[name] || 0) + 1;
    }
    return map;
  }

  paintUndeclared() {
    const host = this.host('policyUndeclared');
    if (!host) return;
    const found = this.undeclaredRoutes(this.policyStats || {});
    const hits = this.rejectRuleIds();
    const offCount = found.list.filter((r) => r.waf === false).length;
    const inherit = DEFAULT_POLICY_SHORT[(this.policy && this.policy.defaultBodyPolicy) || 'full'] || 'full';
    const columns = [
      {
        key: 'name',
        title: '名称',
        render: (r) => html`<div><div>${r.name || r.id || '-'}</div><div class="muted mono">${r.id || ''}</div></div>`,
      },
      { key: 'path', title: '路径', render: (r) => html`<span class="mono">${r.path || '/'}</span>` },
      { key: 'type', title: '类型', width: 110, render: (r) => html`<span class="muted">${r.type || '—'}</span>` },
      { key: 'waf', title: 'WAF 开关', width: 120, render: (r) => (r.waf ? html`<sl-badge pill variant="success">已开启</sl-badge>` : html`<sl-badge pill variant="warning">未开启</sl-badge>`) },
      { key: 'inherit', title: '当前继承', width: 130, render: () => html`<sl-badge pill variant="neutral">${inherit}</sl-badge>` },
      {
        key: 'hits',
        title: '拒绝样例',
        width: 110,
        render: (r) => ((hits[r.id] || hits[r.name])
          ? html`<sl-badge pill variant="warning">${String(hits[r.id] || hits[r.name])}</sl-badge>`
          : html`<span class="muted">—</span>`),
      },
      {
        title: '操作',
        actions: true,
        width: 100,
        render: (r) => html`<sl-button size="small" @click=${() => this.goToRule(r.id)}>去设置</sl-button>`,
      },
    ];
    renderInto(host, html`<div class="pwaf-sub">
      <div class="row">
        <span class="pwaf-sub-title">未声明 bodyPolicy 的路由</span>
        <span class="pwaf-coverage muted">${found.list.length + ' 条（继承全局默认策略 ' + inherit + '）'}</span>
        <span class="spacer"></span>
        ${found.list.length
          ? html`<sl-button size="small" @click=${() => this.goToRule(found.list[0] && found.list[0].id)}>去 Web 规则页设置</sl-button>`
          : nothing}
      </div>
      ${offCount ? html`<div class="pwaf-label">其中 ${offCount} 条规则的 WAF 开关是关闭的，这些路由不会进入请求体检查。</div>` : nothing}
      ${found.source === 'error'
        ? html`<nunt-error .error=${this.webRulesError} heading="无法读取 Web 规则" .onRetry=${() => this.loadPolicy()}></nunt-error>`
        : (!found.list.length
          ? html`<nunt-empty text=${found.source === 'none'
            ? '既没有 undeclaredRoutes 字段，也读不到 GET /web/rules，暂时无法判断哪些路由未声明策略'
            : '所有 Web 规则都已显式声明 bodyPolicy（或当前没有启用的规则）'}></nunt-empty>`
          : html`<nunt-table caption="未声明 bodyPolicy 的路由" .columns=${columns} .rows=${found.list}
              .rowKey=${(row) => row.id}></nunt-table>`)}
      <div class="pwaf-compat">${this.undeclaredSourceNote(found.source)}</div>
    </div>`);
  }

  paintPolicy() {
    const host = this.host('policyForm');
    const warnHost = this.host('policyWarn');
    if (!host) return;
    if (this.policyError) {
      renderInto(host, html`<nunt-error .error=${this.policyError} heading="无法读取请求体检查策略" .onRetry=${() => this.loadPolicy()}></nunt-error>`);
      if (warnHost) renderInto(warnHost, nothing);
      return;
    }
    if (!this.policy || !this.policyForm) {
      renderInto(host, html`<nunt-loading text="正在加载请求体检查策略…"></nunt-loading>`);
      if (warnHost) renderInto(warnHost, nothing);
      return;
    }
    host.replaceChildren();
    host.appendChild(this.policyForm.node);
    this.paintPolicyWarnings(this.policy.enforcementMode);
    this.paintBodyStates();
    this.paintRejectCounters();
    this.paintGRPCStats();
    this.paintRejects();
    this.paintUndeclared();
    this.paintPolicySource();
  }

  paintPolicySource() {
    const host = this.host('policySource');
    if (!host) return;
    const notes = [];
    if (this.compatNotes.length) notes.push('字段兼容读取：' + this.compatNotes.join('，'));
    const sf = (this.policyStats && this.policyStats.fields) || {};
    if (sf.bodyState && sf.bodyState !== 'bodyState' && sf.bodyState !== 'bodyStates') notes.push('bodyStates ← ' + sf.bodyState);
    if (sf.wouldReject && sf.wouldReject !== 'wouldReject') notes.push('wouldReject 计数 ← ' + sf.wouldReject);
    if (sf.wouldRejectSamples && sf.wouldRejectSamples !== 'wouldReject') notes.push('wouldReject 样例 ← ' + sf.wouldRejectSamples);
    if (sf.refused && sf.refused !== 'refused') notes.push('refused 计数 ← ' + sf.refused);
    if (sf.undeclared && sf.undeclared !== 'undeclaredRoutes') notes.push('未声明路由 ← ' + sf.undeclared);
    const source = '数据来源：GET /api/v1/waf/config —— config.enforcementMode / defaultBodyPolicy / peekBytes / peekTimeoutMs；' +
      'stats.bodyStates / bodyRequests / bodyFull / bodyNonFull / bodyNonFullRatio、stats.refused / wouldReject / wouldRejectKept / wouldRejectLimit、' +
      'config.notifyBodyRatio（0–1，0=关闭）；stats.grpc*；响应根级 wouldReject 样例（含 enforced / grpcStatus / reason / bodyState）与 undeclaredRoutes。';
    renderInto(host, html`<div class="pwaf-compat">${notes.length ? (source + notes.join('；')) : source}</div>`);
  }

  async loadPolicy() {
    this.policyLoading = true;
    this.compatNotes = [];
    let data = null;
    let root = null;
    try {
      data = await this.ctx.api.get('/api/v1/waf/config');
      if (this.disposed) return;
      root = (data && data.config) ? data.config : (data || {});
      const read = this.readPolicy(root, POLICY_DEFAULTS);
      this.fallback = read.fallback;
      this.compatNotes = read.notes;
      this.policy = Object.assign({}, read.values, { __fallback: read.fallback });
      this.policyStats = this.readPolicyStats(data);
      this.rejectCount = this.policyStats.rejectCount;
      this.refusedCount = this.policyStats.refusedCount;
      this.policyError = null;
      this.policyForm = this.buildPolicyForm(this.policy);
    } catch (err) {
      if (this.disposed) return;
      this.policy = null;
      this.policyForm = null;
      this.policyError = err;
    } finally {
      if (this.disposed) return;
      this.policyLoading = false;
      // 未声明路由优先用后端 undeclaredRoutes 字段；只有该字段整体缺失（不是空数组）
      // 时才去 GET /web/rules 推导兜底，页面上会注明当前用的是哪种来源。
      if (this.policy && this.policyForm && this.policyStats && !this.policyStats.undeclaredField && !this.webRules && !this.webRulesError) {
        await this.refreshWebRules();
        if (this.disposed) return;
        this.policyStats = this.readPolicyStats(data);
        this.policyForm = this.buildPolicyForm(this.policy);
      }
      this.paintPolicy();
    }
  }

  // reloadPolicy 用于定时刷新：正在面板里编辑时跳过这一轮，避免把用户
  // 输了一半的值刷掉（页面每 15 秒自动刷新一次数据）。
  reloadPolicy() {
    const active = document.activeElement;
    const host = this.host('policyForm');
    if (active && host && host.contains(active)) return Promise.resolve();
    return this.loadPolicy();
  }

  // savePolicy 把四项策略写回 /waf/config；后端未返回的字段不写，避免覆盖。
  async savePolicy() {
    if (!this.config) { toast('配置尚未加载完成', 'warn'); return; }
    if (!this.policy || !this.policyForm) { toast('策略尚未加载完成', 'warn'); return; }
    const values = this.policyForm.read();
    const nextMode = String(values.enforcementMode || 'observe');
    const prevMode = this.policy.enforcementMode || 'observe';
    const nextDefault = String(values.defaultBodyPolicy || 'full');
    const nextBytes = numOf(values.peekBytes, POLICY_DEFAULTS.peekBytes);
    const nextTimeout = numOf(values.peekTimeoutMs, POLICY_DEFAULTS.peekTimeoutMs);
    const byteLimit = POLICY_LIMITS.peekBytes;
    const timeLimit = POLICY_LIMITS.peekTimeoutMs;
    const ratioLimit = POLICY_LIMITS.notifyBodyRatio;
    if (nextBytes < byteLimit.min || nextBytes > byteLimit.max) {
      this.policyForm.fieldError('peekBytes', 'PeekBytes 必须在 ' + byteLimit.min + ' – ' + fmtBytes(byteLimit.max) + ' 之间（后端校验会拒绝超范围的值）');
      toast('PeekBytes 必须在 ' + byteLimit.min + ' – ' + fmtBytes(byteLimit.max) + ' 之间', 'warn');
      return;
    }
    if (nextTimeout < timeLimit.min || nextTimeout > timeLimit.max) {
      this.policyForm.fieldError('peekTimeoutMs', 'PeekTimeoutMS 必须在 ' + timeLimit.min + ' – ' + timeLimit.max + ' 毫秒之间');
      toast('PeekTimeoutMS 必须在 ' + timeLimit.min + ' – ' + timeLimit.max + ' 毫秒之间', 'warn');
      return;
    }
    this.policyForm.fieldError('peekTimeoutMs', '');
    // 阈值先在前端拦一次：非法值给字段级红字并直接返回，不提交（后端也会拒绝越界值）。
    const rawRatio = String(values.notifyBodyRatio === undefined || values.notifyBodyRatio === null ? '' : values.notifyBodyRatio).trim();
    const ratioValue = rawRatio === '' ? POLICY_DEFAULTS.notifyBodyRatio : Number(rawRatio);
    if (rawRatio !== '' && (!isFinite(ratioValue) || ratioValue < ratioLimit.min || ratioValue > ratioLimit.max)) {
      this.policyForm.fieldError('notifyBodyRatio', '取值必须是 ' + ratioLimit.min + ' – ' + ratioLimit.max + ' 之间的数字（0 表示关闭），当前输入非法，未提交。');
      toast('非 full 占比告警阈值必须在 ' + ratioLimit.min + ' – ' + ratioLimit.max + ' 之间（0 表示关闭），非法值未提交', 'warn');
      return;
    }
    if (nextBytes > 0 && nextBytes < byteLimit.low) {
      toast('PeekBytes 只有 ' + nextBytes + ' 字节，检查覆盖会很小；确认无误再保存', 'warn');
    }
    if (nextMode !== prevMode) {
      const ok = await confirmDialog(nextMode === 'enforce'
        ? '切换到强制模式（enforce）后，形态上无法完整检查的请求会被真的拒绝（例如 Content-Length 未知的请求返回 411）。确认已补齐所有路由的 bodyPolicy 声明？'
        : '切回观察模式（observe）：只记录「本应拒绝」，不真的拒绝任何请求。');
      if (!ok) { this.paintPolicy(); return; }
    }
    const payload = Object.assign({}, this.config);
    const fallback = this.fallback || {};
    if (!fallback.mode) payload.enforcementMode = nextMode;
    if (!fallback.policy) payload.defaultBodyPolicy = nextDefault;
    if (!fallback.peekBytes) payload.peekBytes = nextBytes;
    if (!fallback.peekTimeoutMs) payload.peekTimeoutMs = nextTimeout;
    // notifyBodyRatio 的零值带 omitempty（后端在 0 时不会回传该字段），所以这里
    // 始终提交当前输入值：否则「0 → 非 0」的开启动作永远写不进配置。
    payload.notifyBodyRatio = ratioValue;
    this.savingPolicy = true;
    try {
      await this.ctx.api.put('/api/v1/waf/config', payload);
      if (this.disposed) return;
      toast(ratioValue > 0
        ? '请求体检查策略已保存：非 full 占比超过 ' + Math.round(ratioValue * 1000) / 10 + '% 时告警'
        : '请求体检查策略已保存（非 full 占比告警已关闭）', 'ok');
      await this.loadConfig();
      await this.loadPolicy();
    } catch (err) {
      if (this.disposed) return;
      toast('保存失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.savingPolicy = false;
    }
  }

  // goToRule 跳转到 Web 规则页并聚焦该规则（#/web?rule=<id>）。
  goToRule(id) {
    if (!id) return;
    if (this.ctx && typeof this.ctx.navigate === 'function') this.ctx.navigate('web', { rule: id });
    else { location.hash = '#/web?rule=' + encodeURIComponent(id); }
  }

  /* ---------------------------------------------------------------- 渲染 */

  render() {
    return html`
      <section class="card">
        <div class="card-header">
          <h2>WAF 配置</h2>
          <span class="sub">GET/PUT /api/v1/waf/config</span>
          <span class="spacer"></span>
          <sl-button size="small" ?loading=${this.configLoading} @click=${() => this.loadConfig()}>重新加载</sl-button>
          <sl-button size="small" variant="primary" ?loading=${this.savingConfig} @click=${() => this.saveConfig()}>保存配置</sl-button>
        </div>
        <div class="card-body pwaf-panel"><div data-host="config"></div></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>请求体检查策略</h2>
          <span class="sub">GET/PUT /api/v1/waf/config ｜ 每 15 秒自动刷新</span>
          <span class="spacer"></span>
          <sl-button size="small" @click=${() => this.refreshWebRules().then(() => this.loadPolicy())}>刷新数据</sl-button>
          <sl-button size="small" variant="primary" ?loading=${this.savingPolicy} @click=${() => this.savePolicy()}>保存策略</sl-button>
        </div>
        <div class="card-body pwaf-panel">
          <div data-host="policyForm"></div>
          <div data-host="policyWarn"></div>
          <div data-host="policyStates"></div>
          <div data-host="policyCounters"></div>
          <div data-host="policyGrpc"></div>
          <div data-host="policyRejects"></div>
          <div data-host="policyUndeclared"></div>
          <div data-host="policySource"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>规则文件 / 规则组</h2>
          <span class="spacer"></span>
          <sl-button size="small" ?loading=${this.rulesLoading} @click=${() => this.loadRules()}>刷新</sl-button>
        </div>
        <div class="card-body">
          <div class="pwaf-tools">
            <sl-input class="pwaf-search" size="small" label="搜索规则文件" placeholder="搜索规则文件…"
              @sl-input=${(event) => this.onRuleSearch(event)}></sl-input>
          </div>
          <div data-host="rules"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>请求测试</h2>
          <span class="sub">POST /api/v1/waf/test（不会真的发出请求）</span>
          <span class="spacer"></span>
          <sl-button size="small" variant="primary" ?loading=${this.testBusy} @click=${() => this.runTest()}>测试</sl-button>
        </div>
        <div class="card-body">
          <div data-host="testForm"></div>
          <div data-host="testResult"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>拦截日志</h2>
          <span class="sub">GET /api/v1/waf/logs?limit=200 ｜ 每 10 秒自动刷新</span>
          <span class="spacer"></span>
          <sl-button size="small" ?loading=${this.logsLoading} @click=${() => this.loadLogs()}>刷新</sl-button>
        </div>
        <div class="card-body"><div data-host="logs"></div></div>
      </section>`;
  }
}

define('nunt-page-waf', WafPage);

export default {
  id: 'waf',
  title: 'WAF 防护',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l1.8 1.8L15 9.5"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-waf');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
