// 端口转发：TCP / UDP 转发规则与访问日志。
//
// 阶段 2 迁移：规则表格换成 kit 的 nunt-table（操作列走 actions —— 右对齐、不换行，
// 不再有 axe 的 empty-table-header），协议筛选 / 关键字搜索 / 活跃与累计连接列 / 状态开关
// 逐条保留；新建与编辑走 openDialog + formGrid（源地址、目标地址、协议、超时、IP 黑白名单
// 多行）；该规则的访问日志用独立对话框展示（5 秒轮询）。卡片标题 h2。
//
// 数据流与迁移前一致：GET/POST/PUT/DELETE /api/v1/forward/rules[/{id}]、
// POST /api/v1/forward/rules/{id}/toggle（失败退回 PUT 全量更新）、
// GET /api/v1/forward/logs?rule=&limit=，以及提交体里那组字段名
// （name/enable/protocol/srcAddr/dstAddr/timeoutSec/remark/access{mode,ips,uaMode,uas}）。
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtBytes, fmtTime,
} from '../lib/kit.js';

const EOL = String.fromCharCode(10);
const PROTO_LABEL = { tcp: 'TCP', udp: 'UDP', both: 'TCP+UDP' };
const PROTO_OPTIONS = [
  { value: 'all', label: '全部协议' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'both', label: 'TCP + UDP' },
];
const ACCESS_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'allow', label: '白名单（仅允许以下 IP）' },
  { value: 'deny', label: '黑名单（拒绝以下 IP）' },
];
const LOG_POLL_MS = 5000;

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pforward-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
  '.pforward-tools .pforward-proto{width:170px}',
  '.pforward-tools .pforward-search{width:220px}',
  '.pforward-name{font-weight:600;word-break:break-word}',
  '.pforward-remark{font-size:11px;color:var(--text-faint);word-break:break-word}',
  '.pforward-addr{word-break:break-all}',
  '.pforward-num{font-variant-numeric:tabular-nums}',
  '.pforward-num-sub{font-size:11px;color:var(--text-faint)}',
  '.pforward-switch{font-size:12px}',
  '.pforward-log{max-height:52vh;overflow:auto;padding:10px 12px;background:#080b10;border-radius:var(--radius-sm);font-family:var(--sl-font-mono);font-size:12.5px;line-height:1.6}',
  '.pforward-log-line{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8d1de;text-indent:-2em;padding-left:2em}',
  '.pforward-log-line .src{color:#8b96a8}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（与迁移前一致） */

function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

// statOf：后端的连接计数有几个历史字段名，按顺序取第一个存在的（与迁移前一致）。
function statOf(rule, keys) {
  const st = rule.stat || rule.stats || rule.status || {};
  for (const key of keys) {
    if (st[key] !== undefined && st[key] !== null) return st[key];
  }
  return undefined;
}

function countOf(rule, keys) {
  const value = statOf(rule, keys);
  const num = Number(value);
  return isFinite(num) ? num : 0;
}

function accessOf(rule) {
  const a = (rule && rule.access) || {};
  return { mode: a.mode || 'off', ips: Array.isArray(a.ips) ? a.ips : [] };
}

function splitLines(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/* ------------------------------------------------------------------ 页面 */

class ForwardPage extends NuntElement {
  static properties = {
    rules: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    proto: { type: String },
    query: { type: String },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.rules = [];
    this.loading = true;
    this.error = null;
    this.proto = 'all';
    this.query = '';
    this.busyId = '';
    this.searchTimer = null;
    this.logPollers = new Set();
    this.dialogHosts = new Set();
    this.dialogs = new Set();
    this.disposed = false;
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
      const data = await this.ctx.api.get('/api/v1/forward/rules');
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
    const q = this.query.trim().toLowerCase();
    return this.rules.filter((rule) => {
      if (this.proto !== 'all' && rule.protocol !== this.proto) return false;
      if (!q) return true;
      return [rule.name, rule.srcAddr, rule.dstAddr, rule.protocol].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  /* ---------------------------------------------------------------- 动作 */

  async toggle(rule, next) {
    const want = next === undefined ? !rule.enable : !!next;
    this.busyId = String(rule.id || '');
    try {
      try {
        await this.ctx.api.post('/api/v1/forward/rules/' + encodeURIComponent(rule.id) + '/toggle');
      } catch (err) {
        // 兼容没有 toggle 路由的旧后端：退回整条规则的更新（与迁移前一致）。
        await this.ctx.api.put('/api/v1/forward/rules/' + encodeURIComponent(rule.id), Object.assign({}, rule, { enable: want }));
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
    const ok = await confirmDialog('确定删除转发规则「' + (rule.name || rule.id) + '」吗？', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/forward/rules/' + encodeURIComponent(rule.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  /* ---------------------------------------------------------------- 表单 */

  openRuleForm(rule) {
    const base = rule || {};
    const editing = !!base.id;
    const access = accessOf(base);
    const form = formGrid([
      { name: 'name', label: '名称', value: base.name || '', placeholder: '例如 远程桌面' },
      { name: 'enable', label: '启用', type: 'switch', value: base.enable !== false, text: '启用该规则' },
      {
        name: 'protocol',
        label: '协议',
        type: 'select',
        value: base.protocol || 'tcp',
        options: [
          { value: 'tcp', label: 'TCP' },
          { value: 'udp', label: 'UDP' },
          { value: 'both', label: 'TCP + UDP' },
        ],
      },
      { name: 'srcAddr', label: '源地址', value: base.srcAddr || '', placeholder: ':3389 或 0.0.0.0:3389', hint: '源地址是本地监听地址（可省略 IP，只写 :端口）' },
      { name: 'dstAddr', label: '目标地址', value: base.dstAddr || '', placeholder: '192.168.1.10:3389', hint: '流量要转发到的地址' },
      { name: 'timeoutSec', label: '超时（秒）', type: 'number', value: Number(base.timeoutSec) || 0, min: 0, hint: '0 表示不限制' },
      { name: 'accessMode', label: 'IP 策略', type: 'select', value: access.mode, options: ACCESS_OPTIONS },
      {
        name: 'accessIps',
        label: 'IP 列表',
        type: 'textarea',
        rows: 3,
        wide: true,
        value: access.ips.join(EOL),
        placeholder: '每行一条，支持 CIDR：' + EOL + '192.168.1.0/24',
        hint: '每行一条，支持 CIDR；留空表示不限制',
      },
      { name: 'remark', label: '备注', value: base.remark || '', placeholder: '备注（可选）', wide: true },
    ]);

    this.openPageDialog({
      title: editing ? '编辑转发规则' : '新建转发规则',
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
            const srcAddr = String(values.srcAddr || '').trim();
            const dstAddr = String(values.dstAddr || '').trim();
            if (!name) { form.fieldError('name', '请填写规则名称'); return; }
            if (!srcAddr) { form.fieldError('srcAddr', '请填写源地址，例如 :3389'); return; }
            if (!dstAddr) { form.fieldError('dstAddr', '请填写目标地址'); return; }
            const payload = {
              name,
              enable: !!values.enable,
              protocol: values.protocol || 'tcp',
              srcAddr,
              dstAddr,
              timeoutSec: Number(values.timeoutSec) || 0,
              remark: String(values.remark || '').trim(),
              access: {
                mode: values.accessMode || 'off',
                ips: splitLines(values.accessIps),
                uaMode: 'off',
                uas: [],
              },
            };
            dlg.setBusy(true, button);
            try {
              if (editing) await this.ctx.api.put('/api/v1/forward/rules/' + encodeURIComponent(base.id), payload);
              else await this.ctx.api.post('/api/v1/forward/rules', payload);
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

  // logLine 保持迁移前的显示口径：时间  来源 -> 目标  上行/下行字节。
  logLine(item, index) {
    if (typeof item === 'string') return html`<div class="pforward-log-line">${item}</div>`;
    const time = fmtTime(item.time || item.ts || item.at);
    const src = item.src || item.source || item.clientAddr || item.remoteAddr || '-';
    const dst = item.dst || item.target || item.dstAddr || '-';
    const bytes = (item.bytesIn !== undefined || item.bytesOut !== undefined)
      ? '  上行 ' + fmtBytes(item.bytesIn || 0) + ' / 下行 ' + fmtBytes(item.bytesOut || 0) : '';
    return html`<div class="pforward-log-line"><span class="src">${time}</span>  ${src} -> ${dst}${bytes}</div>`;
  }

  openRuleLogs(rule) {
    const state = { entries: [], loading: true, error: null };
    const box = document.createElement('div');
    this.dialogHosts.add(box);

    const paint = () => {
      const list = Array.isArray(state.entries) ? state.entries.slice(-300) : [];
      if (state.error) {
        renderInto(box, html`<nunt-error .error=${state.error || '加载失败'} heading="无法读取转发日志"
          .onRetry=${() => tick()}></nunt-error>`);
        return;
      }
      if (state.loading && !list.length) {
        renderInto(box, html`<nunt-loading text="正在加载转发日志…"></nunt-loading>`);
        return;
      }
      if (!list.length) {
        renderInto(box, html`<nunt-empty text="暂无转发日志"
          hint="该规则产生连接后，这里会显示来源、目标与流量。"></nunt-empty>`);
        return;
      }
      renderInto(box, html`<div class="pforward-log">
        ${list.map((item, index) => this.logLine(item, index))}
      </div>`);
    };

    let stopped = false;
    let timer = null;
    const stop = () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      this.logPollers.delete(stop);
    };

    const tick = async () => {
      if (this.disposed || stopped) return;
      try {
        const data = await this.ctx.api.get('/api/v1/forward/logs', { rule: rule.id, limit: 200 });
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
      title: '转发日志 - ' + (rule.name || rule.id),
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
        sort: (row) => (row ? String(row.name || row.id || '') : ''),
        render: (row) => html`<div>
          <div class="pforward-name">${String(row.name || row.id || '')}</div>
          ${row.remark ? html`<div class="pforward-remark">${String(row.remark)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'protocol',
        title: '协议',
        width: 110,
        sort: (row) => PROTO_LABEL[row.protocol] || String(row.protocol || ''),
        render: (row) => html`<sl-badge pill variant="neutral">${PROTO_LABEL[row.protocol] || row.protocol || '-'}</sl-badge>`,
      },
      {
        key: 'srcAddr',
        title: '源地址',
        render: (row) => html`<span class="mono pforward-addr">${String(row.srcAddr || '-')}</span>`,
      },
      {
        key: 'dstAddr',
        title: '目标地址',
        render: (row) => html`<span class="mono pforward-addr">${String(row.dstAddr || '-')}</span>`,
      },
      {
        key: 'activeConns',
        title: '活跃连接',
        width: 110,
        align: 'right',
        sort: (row) => countOf(row, ['active', 'activeConns', 'curConns', 'connections']),
        render: (row) => {
          const active = countOf(row, ['active', 'activeConns', 'curConns', 'connections']);
          const limit = Number(row.connLimit) || 0;
          return html`<span class="pforward-num">${active}${limit ? html`<span class="pforward-num-sub"> / ${limit}</span>` : nothing}</span>`;
        },
      },
      {
        key: 'totalConns',
        title: '累计连接',
        width: 110,
        align: 'right',
        sort: (row) => countOf(row, ['total', 'totalConns', 'accepted', 'conns']),
        render: (row) => html`<span class="pforward-num">${countOf(row, ['total', 'totalConns', 'accepted', 'conns'])}</span>`,
      },
      {
        key: 'enable',
        title: '状态',
        width: 130,
        sort: (row) => (row && row.enable ? 1 : 0),
                // 状态文字必须放进 sl-switch 的可见标签：只给 title、或把 aria-label 指到别处的文字，
        // 都会被 axe 判 label-title-only / serious（迁移前那个自绘开关的 <label> 里就有这段文字）。
        render: (row) => html`<sl-switch size="small" class="pforward-switch"
          ?checked=${!!row.enable} ?disabled=${this.busyId === String(row.id || '')}
          title=${row.enable ? '点击停用' : '点击启用'}
          @sl-change=${(event) => this.toggle(row, !!event.target.checked)}>${row.enable ? '已启用' : '已停用'}</sl-switch>`,
      },
      {
        title: '操作',
        actions: true,
        width: 150,
        render: (row) => html`
          <sl-button size="small" title="转发日志" @click=${() => this.openRuleLogs(row)}>
            <sl-icon name="journal-text" label="转发日志"></sl-icon>
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

  render() {
    const rows = this.filtered();
    return html`<section class="card">
      <div class="card-header">
        <h2>端口转发规则</h2>
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
        <div class="pforward-tools">
          <sl-select class="pforward-proto" size="small" label="协议筛选" .value=${this.proto}
            @sl-change=${(event) => { this.proto = event.target.value || 'all'; }}>
            ${PROTO_OPTIONS.map((item) => html`<sl-option value=${item.value}>${item.label}</sl-option>`)}
          </sl-select>
          <sl-input class="pforward-search" size="small" label="搜索规则" placeholder="搜索名称/地址"
            @sl-input=${(event) => this.onSearchInput(event)}></sl-input>
        </div>
        <nunt-table caption="端口转发规则"
          .columns=${this.ruleColumns()} .rows=${rows} .loading=${this.loading}
          .error=${this.error} .onRetry=${() => this.load()}
          .rowKey=${(row) => (row && row.id) || ''}
          empty=${this.rules.length ? '没有符合条件的规则' : '还没有转发规则'}
          emptyHint=${this.rules.length ? '换个协议或关键字试试。' : '点右上角「新建规则」把本机端口转发到内网服务。'}></nunt-table>
      </div>
    </section>`;
  }

  onSearchInput(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (!this.disposed) this.query = value;
    }, 200);
  }
}

define('nunt-page-forward', ForwardPage);

export default {
  id: 'forward',
  title: '端口转发',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-4-4M20 16H7l4 4"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-forward');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
