// nunt 前端页面模块：ddns.js
//
// 阶段 2 批次 C：渲染层迁移到 kit（组件层），数据流与接口一字未改。
//   * 规则表 / 运行状态表换成 nunt-table：操作列走 actions（右对齐、不换行），
//     配合列标题全部有文字，消掉迁移前的 empty-table-header；
//   * 新建 / 编辑走 openDialog + formGrid；卡片标题一律 h2（heading-order 消失）；
//   * 删除确认走 confirmDialog，提示走 toast，空 / 加载 / 错误态走
//     nunt-empty / nunt-loading / nunt-error；
//   * 页面私有样式一律 pddns- 前缀，随 mount 的清理函数移除。
//
// 接口与提交体形状与迁移前逐条一致：
//   GET/POST/PUT/DELETE /api/v1/ddns/rules[/{id}]
//   POST /api/v1/ddns/rules/{id}/toggle（失败退回 PUT 全量更新，与迁移前一致）
//   POST /api/v1/ddns/rules/{id}/run（返回的 IP 或错误用 toast 呈现）
//   GET  /api/v1/ddns/providers（凭据表单完全由它的元数据动态生成）
//   GET  /api/v1/ddns/status
// 提交体：name/enable/provider/creds/domain/subDomains/recordType/ttl/intervalSec/cron/
//         ipv4{enable,mode,value,iface,regex}/ipv6{同左}/callback{enable,url,method,headers,
//         body,basicUser,basicPass,contentType,successCode}/remark。
// 组件按需加载：只引本页用到的入口（kit 不再注册任何 sl-* 组件，见 lib/components/core.js）。
import '../lib/components/feedback.js';
import '../lib/components/form.js';
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
} from '../lib/kit.js';

const EOL = String.fromCharCode(10);

const RECORD_OPTIONS = [
  { value: 'A', label: 'A（IPv4）' },
  { value: 'AAAA', label: 'AAAA（IPv6）' },
  { value: 'A_AND_AAAA', label: 'A + AAAA（同时更新）' },
];

const MODE_OPTIONS = [
  { value: 'interface', label: '网卡地址（本机接口）' },
  { value: 'url', label: '通过 URL 获取公网 IP' },
  { value: 'static', label: '静态地址（不自动更新）' },
];

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pddns-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
  '.pddns-tools .pddns-search{width:240px}',
  '.pddns-name{font-weight:600;word-break:break-word}',
  '.pddns-sub{font-size:11px;color:var(--text-faint);word-break:break-word}',
  '.pddns-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}',
  '.pddns-ip{font-family:var(--sl-font-mono);font-size:12.5px;word-break:break-all}',
  '.pddns-logtext{word-break:break-word;overflow-wrap:anywhere}',
  '.pddns-switch{font-size:12px}',
  '.pddns-note{margin:0 0 10px;font-size:12.5px;color:var(--text-dim)}',
  '.pddns-creds{margin-bottom:4px}',
  '.pddns-block{border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:12px}',
  '.pddns-legend{font-size:12px;font-weight:600;color:var(--text-dim);margin:6px 0 8px}',
  '.pddns-legend:first-child{margin-top:0}',
].join(EOL);

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（语义与迁移前一致） */

function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

// splitLines：换行或逗号分隔（迁移前是 split(/[\n,]/)，这里用 EOL 拼出同样的语义，避免正则转义）。
function splitLines(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(EOL).join(',')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// firstNumber：按顺序取第一个存在的计数（迁移前的字段名回退链 + 后端实际返回的名字）。
function firstNumber(source, keys) {
  const src = source || {};
  for (const key of keys) {
    const value = src[key];
    if (value !== undefined && value !== null && value !== '') return Number(value) || 0;
  }
  return 0;
}

function successCount(s) { return firstNumber(s, ['success', 'successCount']); }
// 后端 /api/v1/ddns/status 的真实字段是 failures；旧页面读的是 fail / failCount，
// 于是「失败」永远显示 0（阶段 2C 记录的缺陷）。阶段 3 把真实字段提到回退链最前，
// 旧字段只作为老后端 / 老数据形状的兜底。
function failCount(s) { return firstNumber(s, ['failures', 'fail', 'failCount']); }

// statusOf：/ddns/status 可能是数组（[{id,...}]）或按 id 的映射表（迁移前同款兼容）。
function statusOf(map, id) {
  if (!map) return null;
  if (Array.isArray(map)) return map.filter((x) => x && (x.id === id || x.ruleId === id))[0] || null;
  return map[id] || null;
}

function statusIP(s) {
  const st = s || {};
  const v4 = st.ip || st.currentIp || st.ipv4 || '';
  const v6 = st.ipv6 || '';
  const both = [v4, v6].filter((x) => x).join(' / ');
  return both || '-';
}

function statusRow(s, key, fallbackName) {
  const st = s || {};
  return {
    key,
    name: st.name || fallbackName || st.id || st.ruleId || key,
    ip: statusIP(st),
    lastUpdate: st.lastUpdate || st.updatedAt || st.lastRun || st.lastSuccess || null,
    nextRun: st.nextRun || st.next || null,
    success: successCount(st),
    fail: failCount(st),
    message: st.message || st.lastError || st.error || '-',
    raw: st,
  };
}

// statusLogs：后端把执行日志放在 logs / history / records 里的形状都见过，
// 条目也可能是字符串或 {time,ok,message} 对象，这里统一成 {key,time,ok,text}。
function statusLogs(st) {
  const s = st || {};
  const list = s.logs || s.history || s.records || [];
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => {
    if (typeof item === 'string') return { key: 'log-' + index, time: '', ok: null, text: item };
    const it = item || {};
    const bad = it.ok === false || it.success === false || !!it.error;
    const good = it.ok === true || it.success === true;
    return {
      key: 'log-' + index,
      time: it.time || it.ts || it.at || '',
      ok: bad ? false : (good ? true : null),
      text: String(it.message || it.error || it.ip || JSON.stringify(it)),
    };
  });
}

function statusPairs(s) {
  const st = s || {};
  return [
    { key: 'ip', label: '当前 IP', value: statusIP(st), mono: true },
    { key: 'last', label: '上次更新', value: fmtTime(st.lastUpdate || st.updatedAt || st.lastRun) },
    { key: 'next', label: '下次执行', value: fmtTime(st.nextRun || st.next) },
    { key: 'counts', label: '成功 / 失败', value: String(successCount(st)) + ' / ' + String(failCount(st)) },
    { key: 'message', label: '消息', value: st.message || st.lastError || st.error || '-' },
  ];
}

// --- DNS 提供商元数据 -------------------------------------------------------

// fallbackProviderFields：/api/v1/ddns/providers 不可用时仍然给出已知提供商的凭据输入。
function fallbackProviderFields(id) {
  const map = {
    cloudflare: [{ key: 'token', label: 'API Token', secret: true, required: true, placeholder: 'Zone.DNS 编辑权限的 API Token' }],
    alidns: [{ key: 'accessKeyId', label: 'AccessKey ID', required: true }, { key: 'accessKeySecret', label: 'AccessKey Secret', secret: true, required: true }],
    dnspod: [{ key: 'id', label: 'SecretId', required: true }, { key: 'token', label: 'SecretKey', secret: true, required: true }],
    godaddy: [{ key: 'key', label: 'API Key', required: true }, { key: 'secret', label: 'API Secret', secret: true, required: true }],
    porkbun: [{ key: 'apiKey', label: 'API Key', required: true }, { key: 'secretKey', label: 'Secret Key', secret: true, required: true }],
    huawei: [{ key: 'accessKeyId', label: 'AccessKey ID', required: true }, { key: 'secretAccessKey', label: 'Secret Access Key', secret: true, required: true }],
    callback: [{ key: 'url', label: '回调地址', required: true, placeholder: 'https://example.com/ddns?ip={ip}' }],
  };
  return map[id] || null;
}

function normalizeProviders(data) {
  return unwrap(data, ['providers', 'items']).map((p) => ({
    id: p.id || p.name || p.provider,
    title: p.title || p.label || p.name || p.id || p.provider,
    fields: (p.fields || []).map((f) => ({
      key: f.key,
      label: f.label || f.key,
      secret: !!f.secret,
      required: !!f.required,
      placeholder: f.placeholder || '',
      help: f.help || '',
    })),
    authNote: p.authNote || p.note || '',
  })).filter((p) => p.id);
}

let providerCache = null;
let providerFinal = false;
let providerInflight = null;

// loadDNSProviders 带缓存：404 视为该接口不存在并记住，其它失败下次重试（迁移前同款）。
async function loadDNSProviders(api) {
  if (providerCache && providerCache.length) return providerCache;
  if (providerFinal) return providerCache || [];
  if (providerInflight) return providerInflight;
  providerInflight = (async () => {
    try {
      const data = await api.get('/api/v1/ddns/providers');
      const list = normalizeProviders(data);
      providerCache = list;
      providerFinal = true;
      return list;
    } catch (err) {
      if (err && (err.notFound === true || err.status === 404)) {
        providerFinal = true;
        providerCache = [];
        return [];
      }
      return [];
    } finally {
      providerInflight = null;
    }
  })();
  return providerInflight;
}

/* ------------------------------------------------------------------ 表单构件 */

// legendField：把迁移前 fieldSet 的小标题塞进 formGrid（用 div，避免 h3 触发 heading-order）。
function legendField(name, text) {
  const node = document.createElement('div');
  node.className = 'pddns-legend';
  node.textContent = text;
  return { name, label: false, type: 'custom', wide: true, node };
}

// ipBlock：IPv4 / IPv6 一组。interface / url / static 三态联动显隐（迁移前同款联动）。
// 字段名带 prefix（ipv4Iface / ipv6Url…）：这一组是嵌在主表单里的独立 nunt-form，
// 加前缀后与「自定义回调」里的 enable / url / body 之类不会重名，调试与自动化选择器都无歧义。
function ipBlock(prefix, legend, group) {
  const g = group || {};
  const initialMode = g.mode || 'url';
  const host = document.createElement('div');
  host.className = 'pddns-block';
  const title = document.createElement('div');
  title.className = 'pddns-legend';
  title.textContent = legend;
  host.appendChild(title);

  let form = null;
  function apply(mode) {
    if (!form) return;
    const m = mode || 'url';
    form.toggle(prefix + 'Iface', m === 'interface');
    form.toggle(prefix + 'Url', m === 'url');
    form.toggle(prefix + 'Regex', m === 'url');
    form.toggle(prefix + 'Static', m === 'static');
  }

  form = formGrid([
    { name: prefix + 'Enable', label: '状态', type: 'switch', value: !!g.enable, text: '启用 ' + legend },
    {
      name: prefix + 'Mode',
      label: '获取方式',
      type: 'select',
      value: initialMode,
      options: MODE_OPTIONS,
      onChange: (value) => apply(String(value || 'url')),
    },
    { name: prefix + 'Iface', label: '网卡名称', value: g.iface || '', placeholder: 'eth0 / en0 / 以太网', hint: '留空自动选择默认网卡' },
    { name: prefix + 'Url', label: '获取地址', value: initialMode === 'url' ? (g.value || '') : '', placeholder: 'https://api.ipify.org', hint: '返回纯文本 IP 的接口' },
    { name: prefix + 'Regex', label: '提取正则', value: g.regex || '', placeholder: '可选：从响应中提取 IP 的正则', hint: '留空则直接使用响应内容' },
    { name: prefix + 'Static', label: '静态地址', value: initialMode === 'static' ? (g.value || '') : '', placeholder: '1.2.3.4 或 2001:db8::1' },
  ]);
  apply(initialMode);
  host.appendChild(form.node);

  return {
    node: host,
    collect: () => {
      const values = form.read();
      const mode = String(values[prefix + 'Mode'] || 'url');
      return {
        enable: !!values[prefix + 'Enable'],
        mode,
        value: mode === 'url' ? String(values[prefix + 'Url'] || '').trim() : (mode === 'static' ? String(values[prefix + 'Static'] || '').trim() : ''),
        iface: mode === 'interface' ? String(values[prefix + 'Iface'] || '').trim() : '',
        regex: mode === 'url' ? String(values[prefix + 'Regex'] || '').trim() : '',
      };
    },
  };
}

/* ------------------------------------------------------------------ 页面 */

class DdnsPage extends NuntElement {
  static properties = {
    rules: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    status: { attribute: false },
    statusLoading: { type: Boolean },
    statusError: { attribute: false },
    query: { type: String },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.rules = [];
    this.loading = true;
    this.error = null;
    this.status = null;
    this.statusLoading = true;
    this.statusError = null;
    this.query = '';
    this.busyId = '';
    this.providers = [];
    this.searchTimer = null;
    this.dialogHosts = new Set();
    this.dialogs = new Set();
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadProviders();
    this.load();
    this.loadStatus();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：清防抖定时器、关掉本页打开的对话框、移除元素。 */
  dispose() {
    this.disposed = true;
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
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

  openPageDialog(options) {
    const api = openDialog(options);
    this.dialogs.add(api);
    if (api.dialog) api.dialog.addEventListener('sl-after-hide', () => this.dialogs.delete(api));
    return api;
  }

  /* ---------------------------------------------------------------- 取数 */

  async loadProviders() {
    try {
      const list = await loadDNSProviders(this.ctx.api);
      if (this.disposed) return;
      this.providers = list;
    } catch (err) {
      // 提供商列表拿不到时表单退回 fallbackProviderFields，页面本身不受影响。
    }
  }

  async load() {
    this.loading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/ddns/rules');
      if (this.disposed) return;
      this.rules = unwrap(data, ['rules', 'items']);
      this.error = null;
    } catch (err) {
      if (this.disposed) return;
      this.rules = [];
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  async loadStatus() {
    this.statusLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/ddns/status');
      if (this.disposed) return;
      this.status = data && (data.rules || data.status) ? (data.rules || data.status) : data;
      this.statusError = null;
    } catch (err) {
      if (this.disposed) return;
      this.status = null;
      this.statusError = err;
    } finally {
      if (!this.disposed) this.statusLoading = false;
    }
  }

  // loadStatusFor：单个规则的运行状态（迁移前的多形状读取原样保留）。
  async loadStatusFor(id) {
    const data = await this.ctx.api.get('/api/v1/ddns/status');
    const st = statusOf(data && (data.rules || data.status || data), id) || (data && data[id]);
    if (!st && data && typeof data === 'object' && !Array.isArray(data)) {
      const inner = data.status || data.rules || data;
      return statusOf(inner, id) || {};
    }
    return st || {};
  }

  filtered() {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.rules;
    return this.rules.filter((r) => [r.name, r.domain, r.provider, (r.subDomains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0);
  }

  statusRows() {
    const st = this.status;
    if (Array.isArray(st)) {
      return st.map((s, index) => statusRow(s || {}, String((s && (s.id || s.ruleId)) || ('status-' + index))));
    }
    if (st && typeof st === 'object') {
      return Object.keys(st).map((key) => statusRow(st[key] || {}, key, key));
    }
    return [];
  }

  onSearchInput(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (!this.disposed) this.query = value;
    }, 200);
  }

  /* ---------------------------------------------------------------- 动作 */

  async toggle(rule, next) {
    const want = (next === undefined) ? !rule.enable : !!next;
    this.busyId = String(rule.id || '');
    try {
      try {
        await this.ctx.api.post('/api/v1/ddns/rules/' + encodeURIComponent(rule.id) + '/toggle');
      } catch (err) {
        // 兼容没有 toggle 路由的旧后端：退回整条规则的更新（与迁移前一致）。
        await this.ctx.api.put('/api/v1/ddns/rules/' + encodeURIComponent(rule.id), Object.assign({}, rule, { enable: want }));
      }
      if (this.disposed) return;
      toast(want ? '已启用' : '已停用', 'ok');
      await this.load();
      await this.loadStatus();
    } catch (err) {
      if (this.disposed) return;
      toast('切换失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  async removeRule(rule) {
    const ok = await confirmDialog('确定删除 DDNS 规则「' + (rule.name || rule.id) + '」吗？', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/ddns/rules/' + encodeURIComponent(rule.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.load();
      await this.loadStatus();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  // runNow：POST /rules/{id}/run，把返回的 IP 或错误用 toast 呈现（迁移前同款回退链）。
  //
  // 未启用的规则后端是静默 no-op（runRule 开头 `if rule == nil || !rule.Enable { return }`），
  // 但 /run 仍然返回 ok:true —— 迁移前后界面都会因此提示「执行成功」，属于假成功。
  // 这里在点击时就按规则的启用状态给出真实结论，不再发这次无意义的请求。
  async runNow(rule) {
    if (rule && rule.enable === false) {
      toast('该规则未启用，已跳过', 'warn');
      return;
    }
    this.busyId = String(rule.id || '');
    toast('正在执行「' + (rule.name || rule.id) + '」…', 'info');
    try {
      const res = await this.ctx.api.post('/api/v1/ddns/rules/' + encodeURIComponent(rule.id) + '/run');
      if (this.disposed) return;
      const data = res || {};
      const ip = data.ip || data.currentIp || data.addr || (data.ipv4 ? data.ipv4 + (data.ipv6 ? ' / ' + data.ipv6 : '') : '');
      if (data.ok === false || data.success === false || data.error) {
        toast('执行失败：' + (data.error || data.message || '未知错误'), 'err');
      } else {
        toast('执行成功' + (ip ? '：当前 IP ' + ip : ''), 'ok');
      }
    } catch (err) {
      if (this.disposed) return;
      toast('执行失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
    if (this.disposed) return;
    await this.load();
    await this.loadStatus();
  }

  /* ---------------------------------------------------------------- 表单 */

  openRuleForm(rule) {
    const base = rule || {};
    const editing = !!base.id;
    const providers = Array.isArray(this.providers) ? this.providers : [];
    const creds = Object.assign({}, base.creds || {});
    const callback = base.callback || {};
    const initialProvider = base.provider || (providers[0] && providers[0].id) || '';

    // 凭据区：字段完全由 /api/v1/ddns/providers 的元数据决定，切换提供商时整块重建
    // （custom 字段的 DOM 由页面自己管，不往 nunt-form 的字段里后插节点）。
    const credsHost = document.createElement('div');
    credsHost.className = 'pddns-creds';
    let credForm = null;
    let credFields = [];

    const paintCreds = (providerId) => {
      const meta = providers.filter((p) => p.id === providerId)[0] || null;
      const fields = (meta && meta.fields.length) ? meta.fields : (fallbackProviderFields(providerId) || []);
      credForm = null;
      credFields = fields;
      while (credsHost.firstChild) credsHost.removeChild(credsHost.firstChild);
      if (!fields.length) {
        const note = document.createElement('p');
        note.className = 'pddns-note';
        note.textContent = '未获取到该提供商的凭据说明（/ddns/providers 可能不可用）。可先在“设置”里确认 DNS 提供商是否已注册。';
        credsHost.appendChild(note);
        return;
      }
      credForm = formGrid(fields.map((f) => ({
        name: 'cred_' + f.key,
        label: f.label + (f.required ? ' *' : ''),
        type: f.secret ? 'password' : 'text',
        value: creds[f.key] || '',
        placeholder: f.placeholder || (editing ? '留空表示不修改' : ''),
        autocomplete: 'new-password',
        hint: f.help || (f.secret ? '密钥不会明文回显，留空表示不修改' : ''),
      })));
      credsHost.appendChild(credForm.node);
      if (meta && meta.authNote) {
        const note = document.createElement('p');
        note.className = 'pddns-note';
        note.textContent = meta.authNote;
        credsHost.appendChild(note);
      }
    };
    paintCreds(initialProvider);

    // 自定义回调（自定义域名商）：只勾选时提交，字段与迁移前一致。
    const cbForm = formGrid([
      { name: 'enable', label: '自定义回调', type: 'switch', value: !!callback.enable, text: '使用自定义回调（自定义域名商）', onChange: (value) => paintCallback(!!value) },
      { name: 'url', label: '回调地址', value: callback.url || '', placeholder: 'https://example.com/update', wide: true },
      { name: 'method', label: '方法', type: 'select', value: (callback.method || 'GET').toUpperCase(), options: [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }] },
      { name: 'headers', label: '请求头', type: 'kv', value: callback.headers || {}, wide: true, hint: '键值对，提交时是同一个 headers 对象' },
      { name: 'body', label: '请求体', type: 'textarea', rows: 2, value: callback.body || '', placeholder: '请求体模板（POST 时使用）', wide: true },
      { name: 'basicUser', label: '用户名', value: callback.basicUser || '', placeholder: 'BasicAuth 用户名（可选）' },
      { name: 'basicPass', label: '密码', type: 'password', value: '', autocomplete: 'new-password', placeholder: '留空表示不修改', hint: '密钥不会明文回显，留空表示不修改' },
    ]);
    function paintCallback(on) {
      for (const name of ['url', 'method', 'headers', 'body', 'basicUser', 'basicPass']) cbForm.toggle(name, !!on);
    }
    paintCallback(!!callback.enable);

    const v4 = ipBlock('ipv4', 'IPv4（A 记录）', base.ipv4);
    const v6 = ipBlock('ipv6', 'IPv6（AAAA 记录）', base.ipv6);

    const form = formGrid([
      legendField('legendBasic', '基本信息'),
      { name: 'name', label: '名称', value: base.name || '', placeholder: '例如 家里宽带' },
      {
        name: 'provider',
        label: '提供商',
        type: 'select',
        value: initialProvider,
        options: providers.length
          ? providers.map((p) => ({ value: p.id, label: p.title }))
          : [{ value: base.provider || '', label: base.provider || '（未获取到提供商列表）' }],
        hint: providers.length ? '' : '未能获取提供商列表，已回退为手工输入',
        onChange: (value) => paintCreds(String(value || '')),
      },
      { name: 'enable', label: '启用', type: 'switch', value: base.enable !== false, text: '启用该规则' },

      legendField('legendCreds', '提供商凭据'),
      { name: 'creds', label: false, type: 'custom', wide: true, node: credsHost },

      legendField('legendCallback', '自定义回调'),
      { name: 'callback', label: false, type: 'custom', wide: true, node: cbForm.node },

      legendField('legendRecord', '记录'),
      { name: 'domain', label: '主域名', value: base.domain || '', placeholder: 'example.com', hint: '例如 example.com' },
      { name: 'subDomains', label: '子域名', type: 'textarea', rows: 3, wide: true, value: (base.subDomains || []).join(EOL), placeholder: '每行一个子域名，主域名用 @：' + EOL + '@' + EOL + 'www' + EOL + '*', hint: '每行一个，@ 表示主域名' },
      { name: 'recordType', label: '记录类型', type: 'select', value: base.recordType || 'A', options: RECORD_OPTIONS },
      { name: 'ttl', label: 'TTL（秒）', type: 'number', min: 0, value: String(base.ttl || 0), placeholder: '0 表示默认' },
      { name: 'intervalSec', label: '检查间隔（秒）', type: 'number', min: 0, value: String(base.intervalSec || 0), placeholder: '例如 300' },
      { name: 'cron', label: 'Cron 表达式', value: base.cron || '', placeholder: '例如 */5 * * * *（与间隔二选一）', hint: '填写后优先使用 cron' },
      { name: 'remark', label: '备注', value: base.remark || '', placeholder: '备注（可选）', wide: true },

      { name: 'ipv4', label: false, type: 'custom', wide: true, node: v4.node },
      { name: 'ipv6', label: false, type: 'custom', wide: true, node: v6.node },
    ]);

    this.openPageDialog({
      title: editing ? '编辑 DDNS 规则' : '新建 DDNS 规则',
      body: form.node,
      wide: true,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            const name = String(values.name || '').trim();
            const provider = String(values.provider || '').trim();
            const domain = String(values.domain || '').trim();
            if (!name) { form.fieldError('name', '请填写规则名称'); return; }
            if (!provider) { form.fieldError('provider', '请选择 DNS 提供商'); return; }
            if (!domain) { form.fieldError('domain', '请填写主域名'); return; }

            // 掩码字段沿用旧值：只覆盖用户真正填了内容的凭据（后端把空串 / 掩码视为不修改）。
            const outCreds = Object.assign({}, creds);
            if (credForm) {
              const credValues = credForm.read();
              for (const field of credFields) {
                const value = String(credValues['cred_' + field.key] || '').trim();
                if (value) outCreds[field.key] = value;
              }
            }
            const cbValues = cbForm.read();
            const payload = {
              name,
              enable: !!values.enable,
              provider,
              creds: outCreds,
              domain,
              subDomains: splitLines(values.subDomains),
              recordType: values.recordType || 'A',
              ttl: Number(values.ttl) || 0,
              intervalSec: Number(values.intervalSec) || 0,
              cron: String(values.cron || '').trim(),
              ipv4: v4.collect(),
              ipv6: v6.collect(),
              callback: cbValues.enable ? {
                enable: true,
                url: String(cbValues.url || '').trim(),
                method: String(cbValues.method || 'GET') || 'GET',
                headers: cbValues.headers || {},
                body: String(cbValues.body || ''),
                basicUser: String(cbValues.basicUser || '').trim(),
                basicPass: String(cbValues.basicPass || ''),
                contentType: '',
                successCode: (base.callback && base.callback.successCode) || [],
              } : null,
              remark: String(values.remark || '').trim(),
            };
            dlg.setBusy(true, button);
            try {
              if (editing) await this.ctx.api.put('/api/v1/ddns/rules/' + encodeURIComponent(base.id), payload);
              else await this.ctx.api.post('/api/v1/ddns/rules', payload);
              if (this.disposed) return;
              toast('保存成功', 'ok');
              dlg.close();
              await this.load();
              await this.loadStatus();
            } catch (err) {
              form.error(errorMessage(err, '保存失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  }

  /* ---------------------------------------------------------------- 运行状态与日志 */

  // openStatusDialog：状态摘要 + 最近日志。status 为空时自己去 /ddns/status 取（迁移前同款）。
  openStatusDialog(rule, status) {
    const name = (rule && (rule.name || rule.id)) || '';
    const state = { data: status || null, loading: !status, error: null };
    const host = document.createElement('div');
    this.dialogHosts.add(host);

    const paint = () => {
      const pairs = statusPairs(state.data);
      const logs = statusLogs(state.data);
      renderInto(host, html`
      ${state.error
        ? html`<nunt-error .error=${state.error} heading="无法读取运行状态" .onRetry=${() => fetchIt()}></nunt-error>`
        : state.loading || !state.data
          ? html`<nunt-loading text="正在加载状态…"></nunt-loading>`
          : html`
            <nunt-table caption="状态摘要" .columns=${this.pairColumns()} .rows=${pairs} .rowKey=${(row) => row.key}></nunt-table>
            <div class="pddns-legend">最近日志</div>
            ${logs.length
              ? html`<nunt-table caption="最近日志" .columns=${this.logColumns()} .rows=${logs} .rowKey=${(row) => row.key}></nunt-table>`
              : html`<nunt-empty text="暂无最近日志" compact></nunt-empty>`}`}
    `);
    };

    const fetchIt = async () => {
      state.loading = true;
      state.error = null;
      paint();
      try {
        const data = await this.loadStatusFor(rule && rule.id);
        if (this.disposed) return;
        state.data = data;
        state.error = null;
      } catch (err) {
        if (this.disposed) return;
        state.error = err;
      } finally {
        if (!this.disposed) { state.loading = false; paint(); }
      }
    };

    const api = this.openPageDialog({
      title: '运行状态 - ' + name,
      body: host,
      wide: true,
      actions: [{ label: '关闭' }],
      onClose: () => { this.dialogHosts.delete(host); this.dialogs.delete(api); },
    });
    paint();
    if (!status) fetchIt();
  }

  pairColumns() {
    return [
      { key: 'label', title: '项目', width: 140, render: (row) => html`<span class="muted">${row.label}</span>` },
      { key: 'value', title: '值', render: (row) => (row.mono ? html`<span class="pddns-ip">${row.value}</span>` : html`<span>${row.value}</span>`) },
    ];
  }

  logColumns() {
    return [
      { key: 'time', title: '时间', width: 180, render: (row) => html`<span class="muted">${row.time ? fmtTime(row.time) : '-'}</span>` },
      {
        key: 'ok',
        title: '结果',
        width: 90,
        render: (row) => (row.ok === null
          ? html`<span class="muted">-</span>`
          : html`<sl-badge pill variant=${row.ok ? 'success' : 'danger'}>${row.ok ? '成功' : '失败'}</sl-badge>`),
      },
      { key: 'text', title: '内容', render: (row) => html`<span class="pddns-logtext">${row.text}</span>` },
    ];
  }

  /* ---------------------------------------------------------------- 渲染 */

  ruleColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => String((row && (row.name || row.id)) || ''),
        render: (row) => html`<div>
          <div class="pddns-name">${String(row.name || row.id || '')}</div>
          ${row.remark ? html`<div class="pddns-sub">${String(row.remark)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'domain',
        title: '域名',
        sort: (row) => String((row && row.domain) || ''),
        render: (row) => html`<div>
          <div class="mono">${String(row.domain || '-')}</div>
          ${(row.subDomains || []).length
            ? html`<div class="pddns-chips">${(row.subDomains || []).map((sub) => html`<sl-tag size="small">${String(sub)}</sl-tag>`)}</div>`
            : nothing}
        </div>`,
      },
      {
        key: 'provider',
        title: '提供商',
        width: 140,
        sort: (row) => String((row && row.provider) || ''),
        render: (row) => html`<sl-badge pill variant="neutral">${String(row.provider || '-')}</sl-badge>`,
      },
      {
        key: 'recordType',
        title: '记录类型',
        width: 120,
        sort: (row) => String((row && row.recordType) || 'A'),
        render: (row) => html`<sl-badge pill variant="neutral">${String(row.recordType || 'A')}</sl-badge>`,
      },
      {
        key: 'ip',
        title: '当前 IP',
        width: 170,
        render: (row) => {
          const st = statusOf(this.status, row.id);
          const ip = st && (st.ip || st.currentIp || st.ipv4);
          return html`<span class="pddns-ip">${ip || '-'}</span>`;
        },
      },
      {
        key: 'enable',
        title: '状态',
        width: 130,
        sort: (row) => (row && row.enable ? 1 : 0),
        // 状态文字必须放进 sl-switch 的可见标签（原因见 forward.js 同名列的说明）。
        render: (row) => html`<sl-switch size="small" class="pddns-switch"
          ?checked=${!!row.enable} ?disabled=${this.busyId === String(row.id || '')}
          title=${row.enable ? '点击停用' : '点击启用'}
          @sl-change=${(event) => this.toggle(row, !!event.target.checked)}>${row.enable ? '已启用' : '已停用'}</sl-switch>`,
      },
      {
        title: '操作',
        actions: true,
        width: 190,
        render: (row) => html`
          <sl-button size="small" title="立即执行" ?loading=${this.busyId === String(row.id || '')}
            @click=${() => this.runNow(row)}>
            <sl-icon name="play-fill" label="立即执行"></sl-icon>
          </sl-button>
          <sl-button size="small" title="状态与日志" @click=${() => this.openStatusDialog(row, statusOf(this.status, row.id))}>
            <sl-icon name="journal-text" label="状态与日志"></sl-icon>
          </sl-button>
          <sl-button size="small" title="编辑" @click=${() => this.openRuleForm(row)}>
            <sl-icon name="pencil-square" label="编辑"></sl-icon>
          </sl-button>
          <sl-button size="small" variant="danger" outline title="删除" @click=${() => this.removeRule(row)}>
            <sl-icon name="trash" label="删除"></sl-icon>
          </sl-button>`,
      },
    ];
  }

  statusColumns() {
    return [
      {
        key: 'name',
        title: '规则',
        sort: (row) => String(row.name || ''),
        render: (row) => html`<span class="pddns-name">${row.name}</span>`,
      },
      { key: 'ip', title: '当前 IP', width: 180, render: (row) => html`<span class="pddns-ip">${row.ip}</span>` },
      {
        key: 'lastUpdate',
        title: '上次更新',
        width: 180,
        sort: (row) => {
          const time = row.lastUpdate ? new Date(String(row.lastUpdate)).getTime() : 0;
          return isNaN(time) ? 0 : time;
        },
        render: (row) => html`<span>${fmtTime(row.lastUpdate)}</span>`,
      },
      {
        key: 'counts',
        title: '成功 / 失败',
        width: 150,
        sort: (row) => row.success + row.fail,
        render: (row) => html`<span>
          <sl-badge pill variant="success">${row.success}</sl-badge>
          <sl-badge pill variant=${row.fail ? 'danger' : 'neutral'}>${row.fail}</sl-badge>
        </span>`,
      },
      { key: 'message', title: '消息', render: (row) => html`<span class="muted pddns-logtext">${row.message}</span>` },
      {
        title: '操作',
        actions: true,
        width: 130,
        render: (row) => html`<sl-button size="small" title="最近日志"
          @click=${() => this.openStatusDialog({ id: row.raw.id || row.key, name: row.name }, row.raw)}>
          <sl-icon name="journal-text" label="最近日志"></sl-icon>
        </sl-button>`,
      },
    ];
  }

  render() {
    const rows = this.filtered();
    return html`<section class="card">
      <div class="card-header">
        <h2>DDNS 规则</h2>
        <span class="sub">${this.rules.length ? '共 ' + this.rules.length + ' 条规则' : ''}</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.loading} @click=${() => this.load()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openRuleForm(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建规则
        </sl-button>
      </div>
      <div class="card-body tight">
        <div class="pddns-tools">
          <sl-input class="pddns-search" size="small" label="搜索规则" placeholder="搜索名称/域名/提供商"
            @sl-input=${(event) => this.onSearchInput(event)}></sl-input>
        </div>
        <nunt-table caption="DDNS 规则"
          .columns=${this.ruleColumns()} .rows=${rows} .loading=${this.loading}
          .error=${this.error} .onRetry=${() => this.load()}
          .rowKey=${(row) => (row && row.id) || ''}
          empty=${this.rules.length ? '没有符合条件的规则' : '还没有 DDNS 规则'}
          emptyHint=${this.rules.length ? '换个关键字试试。' : '点右上角「新建规则」把域名指向当前公网 IP。'}></nunt-table>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2>运行状态</h2>
        <span class="sub">来自 /api/v1/ddns/status</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.statusLoading} @click=${() => this.loadStatus()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新状态
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="DDNS 运行状态"
          .columns=${this.statusColumns()} .rows=${this.statusRows()} .loading=${this.statusLoading}
          .error=${this.statusError} .onRetry=${() => this.loadStatus()}
          .rowKey=${(row) => row.key}
          empty="暂无状态信息"
          emptyHint="规则执行一次后，这里会显示当前 IP、更新时间、成功失败计数与最近日志。"></nunt-table>
      </div>
    </section>`;
  }
}

define('nunt-page-ddns', DdnsPage);

export default {
  id: 'ddns',
  title: '动态域名',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M3 21l4-4M3 21h5v-5"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-ddns');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
