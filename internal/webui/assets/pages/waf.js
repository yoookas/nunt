// WAF 防护：引擎配置 + 规则文件列表 + 请求测试 + 拦截日志。
//
// 请求体交给 Coraza 自己处理（SecRequestBodyLimit + ProcessPartial），
// 不再有按路由声明的请求体策略，也没有控制台里的策略面板。
//
// 阶段 2 迁移（批次 D）：全部改用 kit —— 表格走 nunt-table（列标题全部有文字，
// 不再有 axe 的 empty-table-header），表单走 formGrid（控件与标签天然关联，8 条
// critical 的 label / select-name 一起消失），提示 / 对话框 / 三态走 toast /
// openDialog / nunt-error 等。卡片标题一律 h2（迁移前是 h3，触发 heading-order）。
// 页面私有样式用 pwaf- 前缀并随 mount 的清理函数移除。
//
// 数据流与迁移前一致：GET/PUT /api/v1/waf/config（提交时回传原配置对象再覆盖几项）、
// GET /api/v1/waf/rules、GET /api/v1/waf/logs?limit=200（每 10 秒自动刷新）、
// POST /api/v1/waf/test（{method,url,body,path}）。本页没有 SSE 订阅，
// 拦截日志的轮询定时器在 cleanup 里停掉。
// 组件按需加载：只引本页用到的入口（kit 不再注册任何 sl-* 组件，见 lib/components/core.js）。
import '../lib/components/feedback.js';
import '../lib/components/form.js';
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
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

/* ------------------------------------------------------------------ 页面 */

class WafPage extends NuntElement {
  static properties = {
    configLoading: { type: Boolean },
    savingConfig: { type: Boolean },
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


    this.testForm = null;
    this.testResult = null;
    this.testBusy = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadConfig();
    this.loadRules();
    this.loadLogs();
    this.pollerStops.add(makePoller(() => this.loadLogs(), 10000));
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
