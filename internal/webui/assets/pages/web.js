// Web 服务：反向代理 / 重定向 / 静态托管 / 文件管理 / WebDAV。
//
// 阶段 2 迁移（批次 D）：规则表格换成 kit 的 nunt-table（操作列走 actions —— 右对齐、
// 不换行，不再有 axe 的 empty-table-header），类型筛选换成 sl-tab-group，关键字搜索保留；
// 新建 / 编辑走 openDialog + formGrid，按类型（proxy / redirect / static / filebrowser /
// webdav）显隐字段；访问日志用独立对话框展示（5 秒轮询，关闭对话框或离开页面都会真的
// 停掉）。卡片标题一律 h2，页面私有样式用 pweb- 前缀并随 mount 的清理函数移除。
//
// 数据流与迁移前一致：GET/POST/PUT/DELETE /api/v1/web/rules[/{id}]、
// POST /api/v1/web/rules/{id}/toggle（失败退回 PUT 全量更新）、
// GET /api/v1/web/logs?rule=&limit=200，以及提交体里那组字段名。
// #/web?rule=<id> 深链（WAF 页跳转过来）：自动过滤 + 高亮目标行 + 顶部提示条。
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
} from '../lib/kit.js';

const EOL = String.fromCharCode(10);
const LOG_POLL_MS = 5000;

const TYPES = [
  { id: 'proxy', label: '反向代理' },
  { id: 'redirect', label: '重定向' },
  { id: 'static', label: '静态托管' },
  { id: 'filebrowser', label: '文件管理' },
  { id: 'webdav', label: 'WebDAV' },
];
const TABS = [{ id: 'all', label: '全部' }].concat(TYPES);
const TYPE_LABEL = { proxy: '反向代理', redirect: '重定向', static: '静态托管', filebrowser: '文件管理', webdav: 'WebDAV' };
const TLS_LABEL = { off: '关闭', auto: '自动证书', custom: '指定证书' };
// 负载均衡：后端 newBalancer 只认 "" | roundrobin | random | iphash，迁移前页面给的是
// round_robin / ip_hash / least_conn，三个值全部会被后端以 unsupported balance strategy 拒绝
// （新建反代规则默认就是 round_robin，所以那条路径根本存不下来）。这里对齐后端的取值，
// 同时保留旧写法的显示标签，读回历史值时按别名归一（见 balanceValue）。
const BALANCE_OPTIONS = [
  { value: 'roundrobin', label: '轮询' },
  { value: 'random', label: '随机' },
  { value: 'iphash', label: 'IP 哈希' },
];
const BALANCE_LABEL = {
  roundrobin: '轮询', random: '随机', iphash: 'IP 哈希',
  round_robin: '轮询', ip_hash: 'IP 哈希', least_conn: '最少连接',
};
const BALANCE_ALIASES = { round_robin: 'roundrobin', ip_hash: 'iphash', least_conn: 'roundrobin' };

function balanceValue(v) {
  const key = String(v === undefined || v === null ? '' : v).trim();
  if (BALANCE_OPTIONS.filter((o) => o.value === key).length) return key;
  if (BALANCE_ALIASES[key]) return BALANCE_ALIASES[key];
  return 'roundrobin';
}

// ---------------------------------------------------------------------------
// 请求体检查策略（与后端 model.WebRule.bodyPolicy 一一对应）
//
// 空串 = 继承全局默认策略；其余取值由 CONTRACT.md 第 8 节冻结。
// 说明文案里必须保留「gRPC 流式只查首消息」这一能力边界，避免运维误以为
// 流式路由的每一条消息都被检查过。
// ---------------------------------------------------------------------------
const BODY_POLICY_OPTIONS = [
  { value: '', label: '继承全局默认' },
  { value: 'full', label: '全量（full，fail-closed）' },
  { value: 'peek', label: '偷看（peek，只检查前 N 字节）' },
  { value: 'skip', label: '跳过（skip，只查 URI / 请求头）' },
  { value: 'grpc-unary', label: 'gRPC 单消息（grpc-unary）' },
  { value: 'grpc-stream', label: 'gRPC 流式（grpc-stream，只查首消息）' },
];

const BODY_POLICY_HINT = {
  '': '跟随 WAF 页的「默认策略」；改全局默认会同时影响所有未声明的路由。',
  full: '请求体必须先完整到达才转发；Content-Length 未知（chunked / 流式）时，enforce 模式下返回 411 并给出可操作文案。',
  peek: '读满 peekBytes 或空闲 peekTimeoutMs 就先检查已到达的部分，其余字节流式透传；只对前若干字节负责。',
  skip: '只检查 URI 与请求头，请求体原样透传；计为 skipped:declared，是显式声明的检查缺口。',
  'grpc-unary': '先读第一条 gRPC 消息，读到 EOF 判定为 unary / 服务端流式并做请求级判定；若随后又出现第二帧，按执行模式拒绝或记录（防止把 unary 路由伪装成流式降级）。',
  'grpc-stream': '首消息先判定一次，通过后连同 scanner 交给上游；后续帧只做帧校验（compressed flag、长度上限、截断）——不会逐消息做 CRS 检查。',
};

// 表格 WAF 列的策略短标签（迁移前是一整列「请求体策略」，本批按验收要求把信息并进 WAF 列）。
const BODY_POLICY_SHORT = {
  full: '全量',
  peek: '偷看',
  skip: '跳过',
  'grpc-unary': 'gRPC 单消息',
  'grpc-stream': 'gRPC 流式',
};

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pweb-sum{font-size:12px}',
  '.pweb-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
  '.pweb-tools .pweb-search{width:240px}',
  '.pweb-name{font-weight:600;word-break:break-word}',
  '.pweb-path{font-size:11px;color:var(--text-faint);word-break:break-all}',
  '.pweb-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
  '.pweb-chips-more{font-size:11px;color:var(--text-faint)}',
  '.pweb-waf{display:flex;flex-direction:column;gap:3px;align-items:flex-start}',
  '.pweb-switch{font-size:12px}',
  '.pweb-target{word-break:break-all}',
  '.pweb-focus-title{font-weight:600}',
  '.pweb-focus-actions{margin-top:8px}',
  '.pweb-marker{display:none}',
  '.pweb-hit>td{background:color-mix(in srgb,var(--brand) 10%,transparent)}',
  '.pweb-log{max-height:52vh;overflow:auto;padding:10px 12px;background:#080b10;border-radius:var(--radius-sm);font-family:var(--sl-font-mono);font-size:12.5px;line-height:1.6}',
  '.pweb-log-line{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d1de;text-indent:-2em;padding-left:2em}',
  '.pweb-log-line .src{color:#8b96a8}',
  '.pweb-tabs::part(tabs){border-bottom:1px solid var(--line)}',
  '.pweb-legend{font-size:12px;font-weight:600;color:var(--text-dim);margin:6px 0 2px}',
  '.pweb-legend:first-child{margin-top:0}',
  '.pweb-auth-list{display:flex;flex-direction:column;gap:8px;margin-bottom:8px}',
  '.pweb-auth-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}',
  '.pweb-auth-empty{font-size:12px;color:var(--text-faint);margin:0 0 8px}',
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

// splitLines：换行或逗号分隔（迁移前是 split(/[\n,]/)，这里用 EOL 拼出同样的语义）。
function splitLines(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(EOL).join(',')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function numVal(v, dflt) {
  const text = String(v === undefined || v === null ? '' : v).trim();
  if (text === '') return dflt === undefined ? 0 : dflt;
  const n = Number(text);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}

function tlsLabel(r) {
  const mode = (r && r.tls && r.tls.mode) || 'off';
  return TLS_LABEL[mode] || '关闭';
}

// targetText：列表里那一列「目标摘要」，逐字沿用迁移前的口径。
function targetText(r) {
  if (!r) return '-';
  if (r.type === 'proxy') {
    const t = r.proxy || {};
    const list = (t.targets || []);
    if (!list.length) return '-';
    const extra = list.length > 1 ? '（' + (BALANCE_LABEL[t.balance] || t.balance || '轮询') + '，共 ' + list.length + ' 个）' : '';
    return list[0] + extra;
  }
  if (r.type === 'redirect') {
    const t = r.redirect || {};
    return (t.to || '-') + ' [' + (t.status || 302) + ']';
  }
  if (r.type === 'static') {
    const t = r.static || {};
    return t.mountId ? '挂载: ' + t.mountId : (t.root || '-');
  }
  const f = r.files || {};
  return f.mountId ? '挂载: ' + f.mountId + (f.root ? ' ' + f.root : '') : (f.root || '-');
}

function bodyPolicyHintOf(value) {
  const key = String(value || '');
  return BODY_POLICY_HINT[key] === undefined ? BODY_POLICY_HINT[''] : BODY_POLICY_HINT[key];
}

/** chipList：监听 / 域名这种多值列的标签渲染（超出 max 的折叠成 +N）。 */
function chipList(list, max) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => x !== null && x !== undefined && String(x) !== '');
  if (!arr.length) return html`<span class="muted">-</span>`;
  const limit = max || 3;
  return html`<div class="pweb-chips">
    ${arr.slice(0, limit).map((item) => html`<sl-tag size="small">${String(item)}</sl-tag>`)}
    ${arr.length > limit ? html`<span class="pweb-chips-more">+${arr.length - limit}</span>` : nothing}
  </div>`;
}

/** legendField：把迁移前 fieldSet 的小标题塞进 formGrid（用 div，避免 h3 触发 heading-order）。 */
function legendField(name, text) {
  const node = document.createElement('div');
  node.className = 'pweb-legend';
  node.textContent = text;
  return { name, label: false, type: 'custom', wide: true, node };
}

/** certOptions / mountOptions：证书与存储挂载下拉的选项（失败一律退回空列表）。 */
async function certOptions(api) {
  try {
    const data = await api.get('/api/v1/acme/certificates');
    return unwrap(data, ['certificates', 'items']).map((c) => {
      const domains = c.domains || (c.domain ? [c.domain] : []);
      const label = domains.join(', ') || c.name || c.id;
      return { value: c.id || c.name || label, label };
    });
  } catch (err) {
    return [];
  }
}

async function mountOptions(api) {
  try {
    const data = await api.get('/api/v1/storage/mounts');
    return unwrap(data, ['mounts', 'items']).filter((m) => m.enable !== false).map((m) => ({
      value: m.id,
      label: (m.name || m.id) + (m.type === 'webdav' ? '（WebDAV）' : '（本地）'),
    }));
  } catch (err) {
    return [];
  }
}

const NO_MOUNT = { value: '', label: '（不使用挂载，直接用本地目录）' };

/* ------------------------------------------------------------------ BasicAuth 账号编辑器 */

/**
 * authEditor：BasicAuth 的账号列表（多用户）。
 *
 * 为什么不用迁移前那套「主账号 + 其他账号文本框」：后端 hashAuthUsers 的规则是
 * 「用户名在旧规则里存在 + 密码留空 = 保留原哈希」，而迁移前的前端在密码留空时
 * 会把 users 从提交体里删掉，后端于是拿到 enable=true、users 为空，直接以
 * 「basic authentication is enabled without users」拒绝保存。这里按后端真正支持的
 * 语义做：每个账号一行，密码留空表示不修改；新加的账号必须填密码。
 * 列表接口返回的是 argon2 哈希，界面不回显，占位符写明「留空表示不修改」。
 */
function authEditor(users, existingNames) {
  const host = document.createElement('div');
  host.className = 'pweb-auth-users';
  const list = document.createElement('div');
  list.className = 'pweb-auth-list';
  const empty = document.createElement('p');
  empty.className = 'pweb-auth-empty';
  empty.textContent = '还没有账号。至少添加一个账号，BasicAuth 才能生效。';
  const rows = [];

  const addButton = document.createElement('sl-button');
  addButton.setAttribute('size', 'small');
  addButton.textContent = '添加账号';

  function syncEmpty() {
    if (rows.length) { if (empty.parentNode) empty.parentNode.removeChild(empty); }
    else if (!empty.parentNode) host.insertBefore(empty, addButton);
  }

  function addRow(user) {
    const name = String((user && user.username) || '');
    const row = document.createElement('div');
    row.className = 'pweb-auth-row';

    const userInput = document.createElement('sl-input');
    userInput.setAttribute('size', 'small');
    userInput.setAttribute('label', '用户名');
    userInput.setAttribute('placeholder', '用户名');
    userInput.setAttribute('autocomplete', 'off');
    userInput.value = name;

    const passInput = document.createElement('sl-input');
    passInput.setAttribute('size', 'small');
    passInput.setAttribute('type', 'password');
    passInput.setAttribute('label', '密码');
    passInput.setAttribute('password-toggle', '');
    passInput.setAttribute('autocomplete', 'new-password');
    passInput.setAttribute('placeholder', existingNames.indexOf(name) >= 0 ? '留空表示不修改' : '密码');

    const del = document.createElement('sl-icon-button');
    del.setAttribute('name', 'x-lg');
    del.setAttribute('label', '删除该账号');
    del.addEventListener('click', () => {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
      if (row.parentNode) row.parentNode.removeChild(row);
      syncEmpty();
    });

    row.appendChild(userInput);
    row.appendChild(passInput);
    row.appendChild(del);
    list.appendChild(row);
    rows.push(row);
    syncEmpty();
    return { row, userInput, passInput };
  }

  addButton.addEventListener('click', () => {
    const entry = addRow({ username: '' });
    if (typeof entry.userInput.focus === 'function') { try { entry.userInput.focus(); } catch (err) { /* 忽略 */ } }
  });

  host.appendChild(empty);
  host.appendChild(list);
  host.appendChild(addButton);
  for (const user of (Array.isArray(users) ? users : [])) addRow(user);
  syncEmpty();

  return {
    node: host,
    addRow,
    read() {
      return rows.map((row) => {
        const inputs = row.querySelectorAll('sl-input');
        return {
          username: String((inputs[0] && inputs[0].value) || '').trim(),
          password: String((inputs[1] && inputs[1].value) || ''),
        };
      }).filter((user) => user.username || user.password);
    },
  };
}

/* ------------------------------------------------------------------ 页面 */

class WebPage extends NuntElement {
  static properties = {
    rules: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    typeTab: { type: String },
    focusId: { type: String },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.rules = [];
    this.loading = true;
    this.error = null;
    this.typeTab = 'all';
    this.focusId = '';
    this.busyId = '';
    this.query = '';
    this.searchTimer = null;
    this.logPollers = new Set();
    this.dialogHosts = new Set();
    this.dialogs = new Set();
    this.disposed = false;
    this.focusWarned = false;
    this.highlightToken = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：停掉日志轮询、关掉对话框、移除元素。 */
  dispose() {
    this.disposed = true;
    this.highlightToken += 1;
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    for (const stop of Array.from(this.logPollers)) {
      try { stop(); } catch (err) { /* 忽略 */ }
    }
    this.logPollers.clear();
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

  async load() {
    this.loading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/web/rules');
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

  filtered() {
    const q = String(this.query || '').trim().toLowerCase();
    return this.rules.filter((rule) => {
      if (this.typeTab !== 'all' && rule.type !== this.typeTab) return false;
      if (!q) return true;
      const hay = [rule.name, rule.id, (rule.listen || []).join(' '), (rule.domains || []).join(' '), rule.path, rule.type]
        .join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  setType(id) {
    const next = TABS.filter((tab) => tab.id === id).length ? id : 'all';
    if (next === this.typeTab) return;
    this.typeTab = next;
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
        await this.ctx.api.post('/api/v1/web/rules/' + encodeURIComponent(rule.id) + '/toggle');
      } catch (err) {
        // 兼容没有 toggle 路由的旧后端：退回整条规则的更新（与迁移前一致）。
        await this.ctx.api.put('/api/v1/web/rules/' + encodeURIComponent(rule.id), Object.assign({}, rule, { enable: want }));
      }
      if (this.disposed) return;
      toast(want ? '已启用' : '已停用', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('切换失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  async removeRule(rule) {
    const ok = await confirmDialog('确定删除规则「' + (rule.name || rule.id) + '」吗？该操作不可撤销。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/web/rules/' + encodeURIComponent(rule.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  /* ---------------------------------------------------------------- 表单 */

  async openRuleForm(rule) {
    const base = rule || {};
    const editing = !!base.id;
    // 证书与挂载下拉的选项来自接口；拿不到就退回手工输入（与迁移前一致）。
    const [mounts, certs] = await Promise.all([mountOptions(this.ctx.api), certOptions(this.ctx.api)]);
    if (this.disposed) return;

    const tls = base.tls || {};
    const access = base.access || {};
    const auth = base.basicAuth || {};
    const authUsers = Array.isArray(auth.users) ? auth.users : [];
    const existingNames = authUsers.map((u) => String(u.username || ''));
    const proxy = base.proxy || {};
    const redirect = base.redirect || {};
    const stat = base.static || {};
    const files = base.files || {};

    const mountChoices = [NO_MOUNT].concat(mounts);
    const authField = authEditor(authUsers.map((u) => ({ username: u.username })), existingNames);

    const targetLegend = document.createElement('div');
    targetLegend.className = 'pweb-legend';
    targetLegend.textContent = '反向代理（proxy）';

    const bodyHint = document.createElement('div');
    bodyHint.className = 'pweb-legend';
    bodyHint.textContent = bodyPolicyHintOf(base.bodyPolicy);

    const form = formGrid([
      legendField('legendBasic', '基本信息'),
      { name: 'name', label: '名称', value: base.name || '', placeholder: '例如 博客首页' },
      {
        name: 'type',
        label: '类型',
        type: 'select',
        value: base.type || 'proxy',
        options: TYPES.map((t) => ({ value: t.id, label: t.label })),
        hint: '不同类型显示不同的目标配置',
      },
      { name: 'enable', label: '启用', type: 'switch', value: base.enable !== false, text: '启用该规则' },
      {
        name: 'listen',
        label: '监听地址',
        type: 'textarea',
        rows: 3,
        wide: true,
        value: (base.listen || []).join(EOL),
        placeholder: '每行一个监听地址，例如：' + EOL + ':443' + EOL + '0.0.0.0:8080',
        hint: '每行一个；可写 :443、0.0.0.0:8080、[::]:443 等',
      },
      {
        name: 'domains',
        label: '域名',
        type: 'textarea',
        rows: 3,
        wide: true,
        value: (base.domains || []).join(EOL),
        placeholder: '每行一个域名，支持通配：' + EOL + 'example.com' + EOL + '*.example.com',
        hint: '支持 *.example.com；留空则匹配任意 Host',
      },
      { name: 'path', label: '路径', value: base.path || '/', placeholder: '/', hint: '前缀匹配' },
      { name: 'priority', label: '优先级', type: 'number', value: Number(base.priority) || 0, hint: '数字越小越优先' },

      legendField('legendTLS', 'TLS'),
      {
        name: 'tlsMode',
        label: 'TLS 模式',
        type: 'select',
        value: tls.mode || 'off',
        options: [
          { value: 'off', label: '关闭（仅 HTTP）' },
          { value: 'auto', label: '自动证书（ACME 自动申请）' },
          { value: 'custom', label: '指定证书' },
        ],
      },
      certs.length
        ? { name: 'tlsCertId', label: '证书', type: 'select', value: tls.certId || '', options: certs, placeholder: '选择证书' }
        : {
          name: 'tlsCertId',
          label: '证书 ID',
          value: tls.certId || '',
          placeholder: '证书 ID（暂无证书，请先在“证书”页面申请）',
          hint: '未能获取证书列表，可直接填写证书 ID',
        },
      { name: 'tlsHsts', label: 'HSTS', type: 'switch', value: !!tls.hsts, text: '启用 HSTS（强制浏览器使用 HTTPS）' },

      { name: 'legendTarget', label: false, type: 'custom', wide: true, node: targetLegend },

      // --- 反向代理 ---
      {
        name: 'proxyTargets',
        label: '上游列表',
        type: 'textarea',
        rows: 4,
        wide: true,
        value: (proxy.targets || []).join(EOL),
        placeholder: '每行一个上游地址：' + EOL + 'http://127.0.0.1:8080' + EOL + 'http://10.0.0.5:80',
        hint: '每行一个上游地址（支持 http/https，可带端口）',
      },
      {
        name: 'proxyBalance',
        label: '负载均衡方式',
        type: 'select',
        value: balanceValue(proxy.balance),
        options: BALANCE_OPTIONS,
      },
      { name: 'proxyHostHeader', label: 'Host 头', value: proxy.hostHeader || '', placeholder: '留空透传客户端 Host' },
      { name: 'proxyTimeout', label: '超时（秒）', type: 'number', value: Number(proxy.timeoutSec) || 0, min: 0, placeholder: '0 表示默认' },
      { name: 'proxyInsecure', label: '上游证书', type: 'switch', value: !!proxy.insecureTls, text: '跳过上游证书校验' },
      { name: 'proxyNoCompress', label: '压缩', type: 'switch', value: !!(proxy.disableCompression || proxy.disableCompres), text: '禁用压缩' },
      { name: 'proxyH2C', label: '上游协议', type: 'switch', value: !!proxy.h2c, text: 'h2c（明文 HTTP/2 上游，原生 gRPC 常用）' },
      {
        name: 'proxyHeaders',
        label: '请求头',
        type: 'kv',
        wide: true,
        value: proxy.headers || {},
        hint: '每行一条 key: value，例如 X-Real-IP: $remote_addr',
      },
      { name: 'proxyRespHeaders', label: '响应头', type: 'kv', wide: true, value: proxy.respHeaders || {} },
      { name: 'proxyPathPrefix', label: '路径重写前缀', value: proxy.pathPrefix || '', placeholder: '例如 /api' },
      { name: 'proxyPathReplace', label: '路径替换为', value: proxy.pathReplace || '', placeholder: '例如 /' },

      // --- 重定向 ---
      {
        name: 'redirectTo',
        label: '目标地址',
        wide: true,
        value: redirect.to || '',
        placeholder: 'https://example.com/new',
        hint: '可以包含 https:// 前缀',
      },
      {
        name: 'redirectStatus',
        label: '状态码',
        type: 'select',
        value: String(redirect.status || 302),
        options: [
          { value: '301', label: '301 永久重定向' },
          { value: '302', label: '302 临时重定向' },
          { value: '307', label: '307 保持方法' },
          { value: '308', label: '308 永久且保持方法' },
        ],
      },
      { name: 'redirectKeep', label: '路径处理', type: 'switch', value: !!redirect.keepPath, text: '保留原始路径（拼接在目标之后）' },

      // --- 静态托管 ---
      { name: 'staticMount', label: '存储挂载', type: 'select', value: stat.mountId || '', options: mountChoices, hint: '来自“存储挂载”页面' },
      { name: 'staticRoot', label: '本地目录', value: stat.root || '', placeholder: '例如 /var/www/site 或 /srv/nunt/www', hint: '未选择挂载时使用' },
      { name: 'staticIndex', label: '索引文件', value: (stat.index || ['index.html']).join(' '), placeholder: 'index.html index.htm', hint: '空格分隔' },
      { name: 'staticCache', label: '缓存秒数', type: 'number', value: Number(stat.cacheSeconds) || 0, min: 0, placeholder: '0 表示不缓存' },
      { name: 'staticListing', label: '目录', type: 'switch', value: !!stat.listing, text: '允许目录列表' },
      { name: 'staticSPA', label: '单页应用', type: 'switch', value: !!stat.spa, text: '单页应用模式（找不到文件时回退 index.html）' },

      // --- 文件管理 / WebDAV ---
      { name: 'filesMount', label: '存储挂载', type: 'select', value: files.mountId || '', options: mountChoices, hint: '来自“存储挂载”页面' },
      { name: 'filesRoot', label: '根目录', value: files.root || '/', placeholder: '/' },
      { name: 'filesTitle', label: '标题', value: files.title || '', placeholder: '页面标题，留空使用规则名称' },
      { name: 'filesReadOnly', label: '只读', type: 'switch', value: !!files.readOnly, text: '只读（禁止所有写操作）' },
      { name: 'filesUpload', label: '上传', type: 'switch', value: !!files.allowUpload, text: '允许上传' },
      { name: 'filesDelete', label: '删除', type: 'switch', value: !!files.allowDelete, text: '允许删除' },
      { name: 'filesMkdir', label: '新建目录', type: 'switch', value: !!files.allowMkdir, text: '允许新建目录' },
      { name: 'filesRename', label: '重命名', type: 'switch', value: !!files.allowRename, text: '允许重命名' },
      { name: 'filesHidden', label: '显示', type: 'switch', value: !!files.showHidden, text: '显示隐藏文件' },
      { name: 'filesShare', label: '分享链接', type: 'switch', value: !!files.shareLinks, text: '启用分享链接' },
      { name: 'filesShareTTL', label: '分享有效期（分钟）', type: 'number', value: Number(files.shareTtlMinutes) || 0, min: 0, placeholder: '0 表示永久' },

      // --- 访问控制 ---
      legendField('legendAccess', '访问控制'),
      {
        name: 'accessMode',
        label: 'IP 策略',
        type: 'select',
        value: access.mode || 'off',
        options: [
          { value: 'off', label: '关闭' },
          { value: 'allow', label: '白名单（仅允许以下 IP）' },
          { value: 'deny', label: '黑名单（拒绝以下 IP）' },
        ],
      },
      {
        name: 'accessIPs',
        label: 'IP 列表',
        type: 'textarea',
        rows: 3,
        wide: true,
        value: (access.ips || []).join(EOL),
        placeholder: '每行一条，支持 CIDR：' + EOL + '192.168.1.0/24' + EOL + '10.0.0.8',
        hint: '每行一条，支持 CIDR；留空表示不限制',
      },
      {
        name: 'uaMode',
        label: 'UA 策略',
        type: 'select',
        value: access.uaMode || 'off',
        options: [
          { value: 'off', label: '关闭' },
          { value: 'allow', label: '白名单（仅允许匹配 UA）' },
          { value: 'deny', label: '黑名单（拒绝匹配 UA）' },
        ],
      },
      {
        name: 'uaList',
        label: 'UA 列表',
        type: 'textarea',
        rows: 3,
        wide: true,
        value: (access.uas || []).join(EOL),
        placeholder: '每行一条，支持 * 通配：' + EOL + '*bot*' + EOL + 'curl*',
        hint: '每行一条，支持 * 通配',
      },

      // --- BasicAuth ---
      legendField('legendAuth', 'BasicAuth'),
      { name: 'authEnable', label: '启用', type: 'switch', value: !!auth.enable, text: '启用 BasicAuth 保护' },
      { name: 'authUsers', label: false, type: 'custom', wide: true, node: authField.node },

      // --- WAF 与请求体策略 ---
      legendField('legendWaf', 'WAF 与请求体检查策略'),
      { name: 'waf', label: 'WAF 开关', type: 'switch', value: !!base.waf, text: '启用 WAF 检查', hint: '关闭后该路由完全不经过 WAF（含请求体检查）' },
      { name: 'bodyPolicy', label: '请求体策略', type: 'select', value: String(base.bodyPolicy || ''), options: BODY_POLICY_OPTIONS },
      { name: 'bodyPolicyHint', label: false, type: 'custom', wide: true, node: bodyHint },
    ]);

    const FILES_FIELDS = ['filesMount', 'filesRoot', 'filesTitle', 'filesReadOnly', 'filesUpload', 'filesDelete', 'filesMkdir', 'filesRename', 'filesHidden', 'filesShare', 'filesShareTTL'];
    const targetFields = {
      proxy: ['proxyTargets', 'proxyBalance', 'proxyHostHeader', 'proxyTimeout', 'proxyInsecure', 'proxyNoCompress', 'proxyH2C', 'proxyHeaders', 'proxyRespHeaders', 'proxyPathPrefix', 'proxyPathReplace'],
      redirect: ['redirectTo', 'redirectStatus', 'redirectKeep'],
      static: ['staticMount', 'staticRoot', 'staticIndex', 'staticCache', 'staticListing', 'staticSPA'],
      filebrowser: FILES_FIELDS,
      webdav: FILES_FIELDS,
    };
    const allTargetNames = Object.keys(targetFields).reduce((out, key) => out.concat(targetFields[key]), []);

    // 注意：filebrowser 与 webdav 共用同一组字段，所以不能「按类型逐个覆盖」——
    // 后一个类型会把前一个刚打开的字段又关掉。这里统一按「当前类型允许的字段集合」收敛。
    const syncTarget = (kind) => {
      const type = TYPES.filter((t) => t.id === kind).length ? kind : 'proxy';
      const active = {};
      for (const name of targetFields[type]) active[name] = true;
      for (const name of allTargetNames) form.toggle(name, !!active[name]);
      targetLegend.textContent = TYPE_LABEL[type] + '（' + type + '）';
    };
    syncTarget(base.type || 'proxy');
    form.toggle('tlsCertId', (tls.mode || 'off') === 'custom');
    form.toggle('authUsers', !!auth.enable);

    form.node.onFieldChange = (name, value) => {
      if (name === 'type') syncTarget(String(value || 'proxy'));
      else if (name === 'tlsMode') form.toggle('tlsCertId', String(value || 'off') === 'custom');
      else if (name === 'bodyPolicy') bodyHint.textContent = bodyPolicyHintOf(value);
      else if (name === 'authEnable') form.toggle('authUsers', !!value);
    };

    this.openPageDialog({
      title: editing ? '编辑 Web 规则' : '新建 Web 规则',
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
            if (!name) { form.fieldError('name', '请填写规则名称'); return; }
            const listens = splitLines(values.listen);
            if (!listens.length) { form.fieldError('listen', '请至少填写一个监听地址，例如 :443'); return; }
            const kind = String(values.type || 'proxy');
            const users = authField.read();
            if (values.authEnable) {
              if (!users.length) { form.fieldError('authUsers', '启用 BasicAuth 后必须至少有一个账号'); return; }
              const unnamed = users.filter((u) => !u.username);
              if (unnamed.length) { form.fieldError('authUsers', '账号的用户名不能为空'); return; }
              const missing = users.filter((u) => !u.password && existingNames.indexOf(u.username) < 0);
              if (missing.length) { form.fieldError('authUsers', '账号「' + missing[0].username + '」还没有密码'); return; }
            }
            const targets = splitLines(values.proxyTargets);
            if (kind === 'proxy' && !targets.length) { form.fieldError('proxyTargets', '请至少填写一个上游地址'); return; }
            const redirectTo = String(values.redirectTo || '').trim();
            if (kind === 'redirect' && !redirectTo) { form.fieldError('redirectTo', '请填写重定向目标地址'); return; }

            const payload = {
              name,
              enable: !!values.enable,
              type: kind,
              listen: listens,
              domains: splitLines(values.domains),
              path: String(values.path || '').trim() || '/',
              priority: numVal(values.priority, 0),
              tls: {
                mode: String(values.tlsMode || 'off'),
                certId: String(values.tlsCertId || '') || String(tls.certId || ''),
                hsts: !!values.tlsHsts,
              },
              waf: !!values.waf,
              bodyPolicy: String(values.bodyPolicy || ''),
              access: {
                mode: String(values.accessMode || 'off'),
                ips: splitLines(values.accessIPs),
                uaMode: String(values.uaMode || 'off'),
                uas: splitLines(values.uaList),
              },
              basicAuth: { enable: !!values.authEnable, users: values.authEnable ? users : [] },
              proxy: null,
              redirect: null,
              static: null,
              files: null,
            };
            if (kind === 'proxy') {
              payload.proxy = {
                targets,
                balance: balanceValue(values.proxyBalance),
                hostHeader: String(values.proxyHostHeader || '').trim(),
                headers: values.proxyHeaders || {},
                respHeaders: values.proxyRespHeaders || {},
                pathPrefix: String(values.proxyPathPrefix || '').trim(),
                pathReplace: String(values.proxyPathReplace || '').trim(),
                timeoutSec: numVal(values.proxyTimeout, 0),
                insecureTls: !!values.proxyInsecure,
                // 迁移前写的是 disableCompres，而后端 model.ProxyTarget 的 JSON tag 是
                // disableCompression；rest.Decode 开了 DisallowUnknownFields，所以旧键不仅
                // 无效，还会让整条规则的保存直接 400（代理规则从来就存不下来）。
                // 这里改成后端认识的键名，勾选真正生效；h2c 是本批按验收要求补上的同族开关。
                disableCompression: !!values.proxyNoCompress,
                h2c: !!values.proxyH2C,
              };
            } else if (kind === 'redirect') {
              payload.redirect = { to: redirectTo, status: numVal(values.redirectStatus, 302), keepPath: !!values.redirectKeep };
            } else if (kind === 'static') {
              payload.static = {
                mountId: String(values.staticMount || ''),
                root: String(values.staticRoot || '').trim(),
                index: String(values.staticIndex || '').split(/\s+/).filter((s) => s.length > 0),
                cacheSeconds: numVal(values.staticCache, 0),
                listing: !!values.staticListing,
                spa: !!values.staticSPA,
              };
            } else {
              payload.files = {
                mountId: String(values.filesMount || ''),
                root: String(values.filesRoot || '').trim() || '/',
                title: String(values.filesTitle || '').trim(),
                readOnly: !!values.filesReadOnly,
                allowUpload: !!values.filesUpload,
                allowDelete: !!values.filesDelete,
                allowMkdir: !!values.filesMkdir,
                allowRename: !!values.filesRename,
                showHidden: !!values.filesHidden,
                shareLinks: !!values.filesShare,
                shareTtlMinutes: numVal(values.filesShareTTL, 0),
              };
            }
            dlg.setBusy(true, button);
            try {
              if (editing) await this.ctx.api.put('/api/v1/web/rules/' + encodeURIComponent(base.id), payload);
              else await this.ctx.api.post('/api/v1/web/rules', payload);
              if (this.disposed) return;
              toast('保存成功', 'ok');
              dlg.close();
              await this.load();
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

  /* ---------------------------------------------------------------- 访问日志 */

  // logLine 保持迁移前的显示口径：时间  客户端 方法 路径  状态  耗时。
  logLine(item) {
    if (typeof item === 'string') return html`<div class="pweb-log-line">${item}</div>`;
    const time = fmtTime(item.time || item.ts || item.at);
    const ip = item.ip || item.remoteIp || item.clientIp || '-';
    const method = item.method || '-';
    const path = item.path || item.url || item.uri || '-';
    const code = item.status || item.code || '-';
    const ms = (item.durationMs !== undefined ? item.durationMs : item.latencyMs);
    return html`<div class="pweb-log-line"><span class="src">${time}</span>  ${ip}  ${method} ${path}  ${code}${ms !== undefined ? '  ' + ms + 'ms' : ''}</div>`;
  }

  openRuleLogs(rule) {
    const state = { entries: [], loading: true, error: null };
    const box = document.createElement('div');
    this.dialogHosts.add(box);

    let stopped = false;
    let timer = null;

    const paint = () => {
      const list = Array.isArray(state.entries) ? state.entries.slice(-300) : [];
      if (state.error) {
        renderInto(box, html`<nunt-error .error=${state.error} heading="无法读取访问日志" .onRetry=${() => tick()}></nunt-error>`);
        return;
      }
      if (state.loading && !list.length) {
        renderInto(box, html`<nunt-loading text="正在加载访问日志…"></nunt-loading>`);
        return;
      }
      if (!list.length) {
        renderInto(box, html`<nunt-empty text="暂无访问日志（可能未开启访问日志记录）"
          hint="该规则收到请求后，这里会显示客户端、方法、状态与耗时。"></nunt-empty>`);
        return;
      }
      renderInto(box, html`<div class="pweb-log">${list.map((item) => this.logLine(item))}</div>`);
    };

    const stop = () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      this.logPollers.delete(stop);
    };

    const tick = async () => {
      if (this.disposed || stopped) return;
      try {
        const data = await this.ctx.api.get('/api/v1/web/logs', { rule: rule.id, limit: 200 });
        if (this.disposed || stopped) return;
        state.entries = unwrap(data, ['logs', 'items', 'entries']);
        state.error = null;
      } catch (err) {
        if (this.disposed || stopped) return;
        state.error = err;
      } finally {
        if (!this.disposed && !stopped) {
          state.loading = false;
          paint();
          timer = setTimeout(tick, LOG_POLL_MS);
        }
      }
    };

    const api = this.openPageDialog({
      title: '访问日志 - ' + (rule.name || rule.id),
      body: box,
      wide: true,
      actions: [{ label: '关闭' }],
      onClose: () => { stop(); this.dialogHosts.delete(box); this.dialogs.delete(api); },
    });
    this.logPollers.add(stop);
    paint();
    tick();
  }

  /* ---------------------------------------------------------------- 渲染 */

  ruleColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => String((row && (row.name || row.id)) || ''),
        render: (row) => html`<div>
          <span class="pweb-marker" data-web-rule=${String(row.id || '')}></span>
          <div class="pweb-name">${String(row.name || row.id || '')}</div>
          <div class="pweb-path">${String(row.path || '/')}</div>
        </div>`,
      },
      {
        key: 'type',
        title: '类型',
        width: 110,
        sort: (row) => TYPE_LABEL[row.type] || String((row && row.type) || ''),
        render: (row) => html`<sl-badge pill variant="neutral">${TYPE_LABEL[row.type] || row.type || '-'}</sl-badge>`,
      },
      { key: 'listen', title: '监听', width: 150, render: (row) => chipList(row.listen, 2) },
      { key: 'domains', title: '域名', width: 170, render: (row) => chipList(row.domains, 2) },
      { key: 'target', title: '目标', render: (row) => html`<span class="mono pweb-sum pweb-target">${targetText(row)}</span>` },
      {
        key: 'tls',
        title: 'TLS',
        width: 105,
        sort: (row) => tlsLabel(row),
        render: (row) => {
          const mode = (row.tls && row.tls.mode) || 'off';
          return html`<sl-badge pill variant=${mode === 'off' ? 'neutral' : 'success'}>${tlsLabel(row)}</sl-badge>`;
        },
      },
      {
        key: 'waf',
        title: 'WAF',
        width: 140,
        sort: (row) => (row && row.waf ? 1 : 0),
        // 迁移前这里有独立的「请求体策略」列；本批按验收的列清单把它并进 WAF 列，
        // 信息不丢：开启 WAF 时同时显示该路由显式声明的策略（没有则标「继承默认」）。
        render: (row) => {
          if (!row.waf) return html`<span class="muted">关闭</span>`;
          const policy = String(row.bodyPolicy || '');
          return html`<div class="pweb-waf">
            <sl-badge pill variant="success">已开启</sl-badge>
            <sl-badge pill variant="neutral" title=${policy ? '该路由显式声明的请求体策略' : '继承全局默认请求体策略'}>
              ${policy ? (BODY_POLICY_SHORT[policy] || policy) : '继承默认'}
            </sl-badge>
          </div>`;
        },
      },
      {
        key: 'enable',
        title: '状态',
        width: 130,
        sort: (row) => (row && row.enable ? 1 : 0),
        // 状态文字必须放进 sl-switch 的可见标签：只给 title、或把 aria-label 指到别处的文字，
        // 都会被 axe 判 label-title-only / serious（迁移前那个自绘开关的 <label> 里就有这段文字）。
        render: (row) => html`<sl-switch size="small" class="pweb-switch"
          ?checked=${!!row.enable} ?disabled=${this.busyId === String(row.id || '')}
          title=${row.enable ? '点击停用' : '点击启用'}
          @sl-change=${(event) => this.toggle(row, !!event.target.checked)}>${row.enable ? '已启用' : '已停用'}</sl-switch>`,
      },
      {
        title: '操作',
        actions: true,
        width: 150,
        render: (row) => html`
          <sl-button size="small" title="访问日志" @click=${() => this.openRuleLogs(row)}>
            <sl-icon name="journal-text" label="访问日志"></sl-icon>
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

  // renderFocus：顶部提示条。说明本次是从 WAF 页跳过来的（#/web?rule=<id>），
  // 并直接给出「设置请求体策略」的入口。
  renderFocus() {
    const id = String(this.focusId || '');
    if (!id) return nothing;
    const rule = this.rules.filter((r) => r.id === id)[0] || null;
    return html`<div class="notice pweb-focus">
      <div class="pweb-focus-title">${rule
        ? '来自 WAF 页：为路由「' + (rule.name || rule.id) + '」声明请求体策略'
        : '来自 WAF 页：找不到规则 ' + id}</div>
      <div>${rule
        ? '该路由尚未声明 bodyPolicy，当前继承全局默认策略；保存后按该路由自己的策略执行。'
        : '该规则可能已被删除，请刷新列表。'}</div>
      ${rule
        ? html`<div class="pweb-focus-actions">
            <sl-button size="small" variant="primary" @click=${() => this.openRuleForm(rule)}>设置请求体策略</sl-button>
          </div>`
        : nothing}
    </div>`;
  }

  renderList(rows) {
    return html`<nunt-table caption="Web 规则"
      .columns=${this.ruleColumns()} .rows=${rows} .loading=${this.loading}
      .error=${this.error} .onRetry=${() => this.load()}
      .rowKey=${(row) => (row && row.id) || ''}
      empty=${this.rules.length ? '没有符合条件的规则' : '还没有 Web 规则'}
      emptyHint=${this.rules.length ? '换个类型或关键字试试。' : '点右上角「新建规则」把本机服务发布到公网。'}></nunt-table>`;
  }

  render() {
    const rows = this.filtered();
    return html`<section class="card">
      <div class="card-header">
        <h2>Web 规则</h2>
        <span class="sub">${this.rules.length ? '共 ' + this.rules.length + ' 条规则' : ''}</span>
        <span class="spacer"></span>
        <span class="sub">点击规则行可查看最近访问日志</span>
        <sl-button size="small" ?loading=${this.loading} @click=${() => this.load()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openRuleForm(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建规则
        </sl-button>
      </div>
      <div class="card-body">
        ${this.renderFocus()}
        <div class="pweb-tools">
          <sl-input class="pweb-search" size="small" label="搜索规则" placeholder="搜索名称/域名/路径"
            value=${String(this.focusId || '')}
            @sl-input=${(event) => this.onSearchInput(event)}></sl-input>
        </div>
        <sl-tab-group class="pweb-tabs" @sl-tab-show=${(event) => this.setType(event.detail.name)}>
          ${TABS.map((tab) => html`<sl-tab slot="nav" panel=${tab.id} ?active=${this.typeTab === tab.id}>${tab.label}</sl-tab>`)}
          ${TABS.map((tab) => html`<sl-tab-panel name=${tab.id} ?active=${this.typeTab === tab.id}>
            ${this.typeTab === tab.id ? this.renderList(rows) : nothing}
          </sl-tab-panel>`)}
        </sl-tab-group>
      </div>
    </section>`;
  }

  /* ---------------------------------------------------------------- 深链高亮 */

  updated() {
    this.applyHighlight();
  }

  // applyHighlight：把 #/web?rule=<id> 对应的那一行标出来。
  // 行序可能被表头排序改变，所以按行内的隐藏标记定位，而不是按行号。
  async applyHighlight() {
    const token = ++this.highlightToken;
    await this.updateComplete;
    const table = this.querySelector('nunt-table');
    if (table && table.updateComplete) { try { await table.updateComplete; } catch (err) { /* 忽略 */ } }
    if (this.disposed || token !== this.highlightToken) return;
    for (const tr of Array.from(this.querySelectorAll('tr.pweb-hit'))) tr.classList.remove('pweb-hit');
    const id = String(this.focusId || '');
    if (!id) return;
    const marker = Array.from(this.querySelectorAll('[data-web-rule]'))
      .filter((node) => node.getAttribute('data-web-rule') === id)[0] || null;
    const row = marker ? marker.closest('tr') : null;
    if (row) { row.classList.add('pweb-hit'); return; }
    if (!this.focusWarned && !this.loading && !this.error) {
      this.focusWarned = true;
      toast('未在当前规则列表里找到 ' + id + '，可能已被删除', 'warn');
    }
  }
}

define('nunt-page-web', WebPage);

export default {
  id: 'web',
  title: 'Web 服务',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-web');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    // WAF 页的「未声明 bodyPolicy 的路由」通过 #/web?rule=<id> 跳到本页：
    // 自动过滤 + 高亮目标行 + 顶部提示条。
    const params = ctx && ctx.params;
    const focus = String((params && typeof params.get === 'function' ? params.get('rule') : '') || '').trim();
    page.focusId = focus;
    page.query = focus;
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
