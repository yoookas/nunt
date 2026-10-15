// 概览页：系统指标、主机指标、动态域名、模块开关、最近日志。
//
// 阶段 2 迁移：渲染层整体换成 lib/kit.js（h2 卡片标题、nunt-empty/nunt-loading/nunt-error
// 三态、sl-button/sl-badge、kit 的 infoVersionText），数据流与迁移前一致：
// 同一批接口、同一批字段名、同样的 5 秒轮询与 SSE 增量日志。
//
// Windows 上后端不采集主机指标（internal/sysinfo/host_other.go 返回 nil），迁移前那三张卡
// 永远显示「—」。现在改成明确的「该平台不支持」空态 + 页脚说明，不再留一排破折号。
import {
  NuntElement, html, nothing, define, confirmDialog, toast, errorMessage,
  fmtBytes, fmtTime, fmtDuration, infoVersionText,
} from '../lib/kit.js';

const REFRESH_MS = 5000;
const LOG_LIMIT = 10;
const LOG_BUFFER = 200;

/* ------------------------------------------------------------------ 局部样式
 *
 * 指标块/模块块只描边、不打底：块内的次级文案用 --text-faint，压在卡片背景
 * (--bg-elev) 上才满足对比度；用 --bg-soft 打底时 axe 会报 color-contrast/serious。
 */

const PAGE_CSS = [
  '.pdashboard-metrics{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}',
  '.pdashboard-metric{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius-sm)}',
  '.pdashboard-metric-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
  '.pdashboard-metric-label{font-size:12px;color:var(--text-dim)}',
  '.pdashboard-metric-value{font-size:21px;font-weight:650;letter-spacing:.3px}',
  '.pdashboard-metric-sub{font-size:12px;color:var(--text-faint)}',
  '.pdashboard-bar{height:6px;border-radius:999px;background:var(--bg);overflow:hidden}',
  '.pdashboard-bar>i{display:block;height:100%;border-radius:999px;background:var(--brand);transition:width .3s ease}',
  '.pdashboard-bar.is-warn>i{background:var(--warn)}',
  '.pdashboard-bar.is-err>i{background:var(--err)}',
  '.pdashboard-modules{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}',
  '.pdashboard-module{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--radius-sm)}',
  '.pdashboard-module-head{display:flex;align-items:center;gap:8px}',
  '.pdashboard-module-head .name{font-weight:600}',
  '.pdashboard-module-detail{font-size:12px;color:var(--text-faint);min-height:18px}',
  '.pdashboard-module-err{font-size:12px;color:var(--err);word-break:break-word}',
  '.pdashboard-module-actions{display:flex;gap:6px;flex-wrap:wrap}',
  '.pdashboard-log{max-height:320px;overflow:auto;padding:10px 12px;background:#080b10;border-radius:var(--radius-sm);font-family:var(--sl-font-mono);font-size:12.5px;line-height:1.6}',
  '.pdashboard-log-line{display:flex;gap:10px;padding:1px 0;white-space:pre-wrap;word-break:break-word;color:#c8d1de}',
  '.pdashboard-log-line .ts{color:#8b96a8;flex:0 0 auto}',
  '.pdashboard-log-line .lv{flex:0 0 46px;font-weight:600;text-transform:uppercase}',
  '.pdashboard-log-line .msg{flex:1 1 auto;min-width:0}',
  '.pdashboard-log-line.level-debug .lv{color:#9aa5b8}',
  '.pdashboard-log-line.level-info .lv{color:#6ba7ff}',
  '.pdashboard-log-line.level-warn .lv{color:#f5a524}',
  '.pdashboard-log-line.level-warn .msg{color:#f7d9a4}',
  '.pdashboard-log-line.level-error .lv{color:#ff7b82}',
  '.pdashboard-log-line.level-error .msg{color:#ffc0c4}',
  '.pdashboard-log-line .attrs{color:#96a2b5}',
  '.pdashboard-detail{font-size:12.5px;color:var(--text-faint);word-break:break-all}',
  '.pdashboard-note{margin:10px 0 0;font-size:12px;color:var(--text-faint)}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（与迁移前一致） */

function levelClass(level) {
  const value = String(level || '').toLowerCase();
  if (value.startsWith('err') || value === 'error' || value === 'fatal') return 'level-error';
  if (value.startsWith('warn')) return 'level-warn';
  if (value.startsWith('deb')) return 'level-debug';
  return 'level-info';
}

function normalizeLog(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { time: null, level: 'info', msg: entry, attrs: null };
  if (typeof entry !== 'object') return { time: null, level: 'info', msg: String(entry), attrs: null };
  const attrs = entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null;
  const extra = typeof entry.data === 'object' && entry.data !== null ? entry.data : null;
  return {
    time: entry.time || entry.timestamp || (extra && extra.time) || null,
    level: entry.level || entry.lvl || 'info',
    msg: String(entry.msg || entry.message || (extra && (extra.msg || extra.message)) || ''),
    attrs,
  };
}

function attrText(attrs) {
  const parts = [];
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    let text;
    if (value === null || value === undefined) text = '';
    else if (typeof value === 'object') {
      try { text = JSON.stringify(value); } catch (err) { text = String(value); }
    } else text = String(value);
    parts.push(key + '=' + text);
  }
  return parts.join('  ');
}

function statsTextOf(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const parts = [];
  for (const key of Object.keys(stats).slice(0, 4)) {
    const value = stats[key];
    if (value === null || value === undefined || typeof value === 'object') continue;
    parts.push(key + ': ' + value);
  }
  return parts.join('  ·  ');
}

function barKind(pct) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  if (value >= 90) return ' is-err';
  if (value >= 75) return ' is-warn';
  return '';
}

/* ------------------------------------------------------------------ 页面 */

class DashboardPage extends NuntElement {
  static properties = {
    stats: { attribute: false },
    statsError: { attribute: false },
    statsLoading: { type: Boolean },
    info: { attribute: false },
    infoError: { attribute: false },
    modules: { attribute: false },
    modulesError: { attribute: false },
    modulesLoading: { type: Boolean },
    busyModule: { type: String },
    ddns: { attribute: false },
    ddnsError: { attribute: false },
    ddnsLoading: { type: Boolean },
    logs: { attribute: false },
    logsError: { attribute: false },
    logsLoading: { type: Boolean },
  };

  constructor() {
    super();
    this.ctx = null;
    this.stats = null;
    this.statsError = null;
    this.statsLoading = false;
    this.info = null;
    this.infoError = null;
    this.modules = [];
    this.modulesError = null;
    this.modulesLoading = false;
    this.busyModule = '';
    this.ddns = null;
    this.ddnsError = null;
    this.ddnsLoading = false;
    this.logs = [];
    this.logsError = null;
    this.logsLoading = false;
    this.disposed = false;
    this.timer = null;
    this.offSSE = null;
    this.started = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.started) return;
    this.started = true;
    this.offSSE = this.ctx.onSSE((payload) => this.onEvent(payload));
    this.loadLogs();
    this.refreshAll();
    this.timer = setInterval(() => {
      if (!document.hidden && !this.disposed) this.refreshAll();
    }, REFRESH_MS);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：断开后不再写 state。 */
  dispose() {
    this.stop();
    this.disposed = true;
    this.remove();
  }

  /** stop 清掉定时器与 SSE 订阅（mount 返回的 cleanup 必须真的清干净）。 */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.offSSE) { try { this.offSSE(); } catch (err) { /* 忽略 */ } this.offSSE = null; }
  }

  updated(changed) {
    if (changed && changed.has('logs')) {
      const box = this.querySelector('.pdashboard-log');
      if (box) box.scrollTop = box.scrollHeight;
    }
  }

  onEvent(payload) {
    if (!payload || this.disposed) return;
    if (payload.type === 'log') {
      this.pushLog(payload.data);
    } else if (payload.type === 'status' || payload.type === 'modules' || payload.type === 'module') {
      this.loadModules();
      this.loadStats();
    }
  }

  async refreshAll() {
    await Promise.all([this.loadStats(), this.loadInfo(), this.loadModules(), this.loadDDNS()]);
  }

  /* ---------------------------------------------------------------- 取数 */

  async loadStats() {
    this.statsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/system/stats');
      if (this.disposed) return;
      this.stats = data || {};
      this.statsError = null;
    } catch (err) {
      if (this.disposed) return;
      // 首次失败才把卡片换成错误态；已经有数据时保留上一次的快照（与迁移前一致）。
      if (!this.stats) this.statsError = err;
    } finally {
      if (!this.disposed) this.statsLoading = false;
    }
  }

  async loadInfo() {
    try {
      const data = await this.ctx.api.get('/api/v1/system/info');
      if (this.disposed) return;
      this.info = data || {};
      this.infoError = null;
      this.ctx.state.info = this.info;
    } catch (err) {
      if (this.disposed) return;
      this.infoError = err;
      if (!this.info) this.info = {};
    }
  }

  async loadModules() {
    this.modulesLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/modules');
      if (this.disposed) return;
      const list = Array.isArray(data) ? data : [];
      this.modules = list;
      this.modulesError = null;
      this.ctx.state.modules = list;
      this.ctx.state.modulesError = null;
    } catch (err) {
      if (this.disposed) return;
      this.modulesError = err;
      this.ctx.state.modulesError = err;
    } finally {
      if (!this.disposed) this.modulesLoading = false;
    }
  }

  async loadDDNS() {
    this.ddnsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/ddns/status');
      if (this.disposed) return;
      if (data === null || data === undefined) {
        this.ddns = null;
      } else {
        this.ddns = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : [data]);
      }
      this.ddnsError = null;
    } catch (err) {
      if (this.disposed) return;
      this.ddnsError = err;
    } finally {
      if (!this.disposed) this.ddnsLoading = false;
    }
  }

  async loadLogs() {
    this.logsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/system/logs', { limit: 20 });
      if (this.disposed) return;
      const entries = data && Array.isArray(data.entries) ? data.entries : [];
      this.logs = entries.slice(-LOG_BUFFER);
      this.logsError = null;
    } catch (err) {
      if (this.disposed) return;
      // 日志失败不影响概览页其余部分，只在日志卡里说明。
      this.logsError = err;
    } finally {
      if (!this.disposed) this.logsLoading = false;
    }
  }

  pushLog(entry) {
    if (!entry) return;
    const next = this.logs.concat([entry]);
    this.logs = next.length > LOG_BUFFER ? next.slice(next.length - LOG_BUFFER) : next;
  }

  /* ---------------------------------------------------------------- 动作 */

  async moduleAction(mod, action, label) {
    const name = String(mod.name || '');
    if (action === 'stop' && !(await confirmDialog('确定要停止模块「' + (mod.title || name) + '」吗？', { danger: true, okLabel: '停止' }))) return;
    this.busyModule = name;
    try {
      await this.ctx.api.post('/api/v1/modules/' + encodeURIComponent(name) + '/' + action, {});
      if (this.disposed) return;
      toast((mod.title || name) + ' 已' + label, 'ok');
      await this.loadModules();
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '操作失败'), 'err');
    } finally {
      if (!this.disposed) this.busyModule = '';
    }
  }

  /* ---------------------------------------------------------------- 渲染片段 */

  metricTile(label, value, sub, extra) {
    return html`<div class="pdashboard-metric">
      <div class="pdashboard-metric-head">
        <span class="pdashboard-metric-label">${label}</span>
        <span class="pdashboard-metric-value">${value}</span>
      </div>
      ${extra || nothing}
      ${sub ? html`<div class="pdashboard-metric-sub">${sub}</div>` : nothing}
    </div>`;
  }

  bar(pct) {
    const value = Math.max(0, Math.min(100, Number(pct) || 0));
    return html`<div class="pdashboard-bar${barKind(value)}"><i style=${'width:' + value + '%'}></i></div>`;
  }

  renderProcessCard() {
    let body = nothing;
    if (this.statsError && !this.stats) {
      body = html`<nunt-error .error=${this.statsError} heading="无法获取系统统计" .onRetry=${() => this.loadStats()}></nunt-error>`;
    } else if (!this.stats) {
      body = html`<nunt-loading text="正在读取系统统计…"></nunt-loading>`;
    } else {
      const s = this.stats;
      const heap = Number(s.heapBytes) || 0;
      const sys = Number(s.sysBytes) || 0;
      const sub = [
        this.info && this.info.commit ? '提交 ' + String(this.info.commit).slice(0, 10) : '',
        s.hostname || '',
        s.os && s.arch ? s.os + '/' + s.arch : '',
      ].filter(Boolean).join('  ·  ');
      body = html`<div class="pdashboard-metrics">
        ${this.metricTile('CPU', s.numCpu ? String(s.numCpu) + ' 核' : '—',
          s.goroutines !== undefined ? '协程 ' + s.goroutines + ' 个' : '')}
        ${this.metricTile('Go 内存', fmtBytes(heap),
          sys ? '系统保留 ' + fmtBytes(sys) : '', heap && sys ? this.bar((heap / sys) * 100) : null)}
        ${this.metricTile('运行时长', fmtDuration(s.uptimeSec),
          this.info && this.info.startedAt ? '启动于 ' + fmtTime(this.info.startedAt) : '')}
        ${this.metricTile('版本', infoVersionText(this.info),
          this.infoError ? '版本信息读取失败' : sub)}
      </div>`;
    }
    return html`<section class="card">
      <div class="card-header">
        <h2>系统指标</h2>
        <span class="sub">每 5 秒自动刷新</span>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.refreshAll()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>立即刷新
        </sl-button>
      </div>
      <div class="card-body">${body}</div>
    </section>`;
  }

  // renderHostCard：后端只在 Linux 上采集主机内存/磁盘/负载（internal/sysinfo 的构建标签），
  // 其它平台 host 字段直接缺失。这里据此给出「该平台不支持」的空态，而不是一排破折号。
  renderHostCard() {
    const s = this.stats || {};
    const host = s.host || null;
    const platform = s.os ? String(s.os) : '';
    const tiles = [];
    if (host && host.memTotalBytes) {
      const pct = Number(host.memUsedPct) || ((1 - (Number(host.memFreeBytes) || 0) / host.memTotalBytes) * 100);
      tiles.push(this.metricTile('主机内存', pct.toFixed(1) + '%',
        '已用 ' + fmtBytes(host.memTotalBytes - (Number(host.memFreeBytes) || 0)) + ' / 共 ' + fmtBytes(host.memTotalBytes),
        this.bar(pct)));
    }
    if (host && host.diskTotalBytes) {
      const used = host.diskTotalBytes - (Number(host.diskFreeBytes) || 0);
      const pct = (used / host.diskTotalBytes) * 100;
      tiles.push(this.metricTile('磁盘', pct.toFixed(1) + '%',
        '可用 ' + fmtBytes(host.diskFreeBytes) + ' / 共 ' + fmtBytes(host.diskTotalBytes) + (host.diskPath ? '（' + host.diskPath + '）' : ''),
        this.bar(pct)));
    }
    if (host && host.load1 !== undefined && host.load1 !== null) {
      tiles.push(this.metricTile('系统负载',
        Number(host.load1).toFixed(2) + ' / ' + Number(host.load5 || 0).toFixed(2) + ' / ' + Number(host.load15 || 0).toFixed(2),
        '1 / 5 / 15 分钟'));
    }
    let body = nothing;
    if (this.statsError && !this.stats) {
      body = html`<nunt-error .error=${this.statsError} heading="无法获取主机指标" .onRetry=${() => this.loadStats()}></nunt-error>`;
    } else if (!this.stats) {
      body = html`<nunt-loading text="正在读取主机指标…"></nunt-loading>`;
    } else if (!tiles.length) {
      body = html`
        <nunt-empty text="该平台不支持" icon="dash-circle"
          hint=${'主机内存 / 磁盘 / 系统负载由后端按平台采集，只有 Linux 版本会返回；当前平台：' + (platform || '未知') + '。'}></nunt-empty>
        <p class="pdashboard-note">这三项指标在后端未提供时不再显示破折号。如果你在 Linux 上看到这个空态，说明后端没读到 /proc（例如容器内没有挂载），其它指标不受影响。</p>`;
    } else {
      body = html`<div class="pdashboard-metrics">${tiles}</div>
        ${tiles.length < 3
          ? html`<p class="pdashboard-note">当前平台只返回了 ${tiles.length} 项主机指标，其余项后端未提供（不显示占位破折号）。</p>`
          : nothing}`;
    }
    return html`<section class="card">
      <div class="card-header">
        <h2>主机指标</h2>
        <span class="sub">内存 / 磁盘 / 系统负载</span>
      </div>
      <div class="card-body">${body}</div>
    </section>`;
  }

  renderDDNSCard() {
    let body = nothing;
    if (this.ddnsError) {
      body = html`<nunt-error compact .error=${this.ddnsError} heading="动态域名状态不可用" .onRetry=${() => this.loadDDNS()}></nunt-error>`;
    } else if (this.ddnsLoading && this.ddns === null) {
      body = html`<nunt-loading compact text="正在读取动态域名状态…"></nunt-loading>`;
    } else if (this.ddns === null) {
      body = html`<nunt-empty compact text="无数据" hint="后端没有返回动态域名状态。"></nunt-empty>`;
    } else {
      const items = this.ddns;
      let bad = 0;
      const detail = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.error || item.lastError) bad += 1;
        if (detail.length < 6) {
          const name = item.name || item.domain || item.id || '规则';
          const value = item.ip || item.currentIp || item.value || '';
          detail.push(String(name) + (value ? ': ' + value : ''));
        }
      }
      body = html`<div class="row">
        <sl-badge pill variant=${bad ? 'danger' : 'success'}>${bad ? bad + ' 个异常 / 共 ' + items.length : items.length + ' 条规则'}</sl-badge>
        ${detail.length ? html`<span class="mono muted pdashboard-detail">${detail.join('   ')}</span>` : nothing}
      </div>`;
    }
    return html`<section class="card">
      <div class="card-header">
        <h2>动态域名</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.ctx.navigate('ddns')}>管理规则</sl-button>
      </div>
      <div class="card-body">${body}</div>
    </section>`;
  }

  renderModuleTile(mod) {
    const name = String(mod.name || '');
    const running = !!mod.running;
    const busy = this.busyModule !== '' && this.busyModule === name;
    const tone = running ? 'success' : (mod.error ? 'danger' : 'neutral');
    const text = running ? '运行中' : (mod.error ? '异常' : '已停止');
    const detail = mod.detail || statsTextOf(mod.stats && typeof mod.stats === 'object' ? mod.stats : null);
    return html`<div class="pdashboard-module">
      <div class="pdashboard-module-head">
        <span class="name">${mod.title || name || '未知模块'}</span>
        <sl-badge pill variant=${tone}>${text}</sl-badge>
      </div>
      <div class="pdashboard-module-detail">${detail || ''}</div>
      ${mod.error ? html`<div class="pdashboard-module-err">${String(mod.error)}</div>` : nothing}
      <div class="pdashboard-module-actions">
        ${running
          ? html`<sl-button size="small" ?loading=${busy} @click=${() => this.moduleAction(mod, 'restart', '重启')}>重启</sl-button>
              <sl-button size="small" variant="danger" outline ?loading=${busy} @click=${() => this.moduleAction(mod, 'stop', '停止')}>停止</sl-button>`
          : html`<sl-button size="small" variant="primary" ?loading=${busy} @click=${() => this.moduleAction(mod, 'start', '启动')}>启动</sl-button>`}
      </div>
    </div>`;
  }

  renderModuleCard() {
    let body = nothing;
    if (this.modulesError) {
      body = html`<nunt-error .error=${this.modulesError} heading="无法获取模块状态" .onRetry=${() => this.loadModules()}></nunt-error>`;
    } else if (this.modulesLoading && !this.modules.length) {
      body = html`<nunt-loading text="正在读取模块状态…"></nunt-loading>`;
    } else if (!this.modules.length) {
      body = html`<nunt-empty text="暂无模块信息" hint="后端没有返回任何已注册模块。"></nunt-empty>`;
    } else {
      body = html`<div class="pdashboard-modules">${this.modules.map((mod) => this.renderModuleTile(mod))}</div>`;
    }
    return html`<section class="card">
      <div class="card-header">
        <h2>模块状态</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.loadModules()}>刷新</sl-button>
      </div>
      <div class="card-body">${body}</div>
    </section>`;
  }

  logLine(entry) {
    const item = normalizeLog(entry);
    if (!item) return nothing;
    const extra = item.attrs ? attrText(item.attrs) : '';
    return html`<div class=${'pdashboard-log-line ' + levelClass(item.level)}>
      <span class="ts">${fmtTime(item.time)}</span>
      <span class="lv">${item.level || 'info'}</span>
      <span class="msg">${item.msg}${extra ? html`<span class="attrs">  ${extra}</span>` : nothing}</span>
    </div>`;
  }

  renderLogCard() {
    let body = nothing;
    if (this.logsError && !this.logs.length) {
      body = html`<nunt-error compact .error=${this.logsError} heading="无法读取日志" .onRetry=${() => this.loadLogs()}></nunt-error>`;
    } else if (this.logsLoading && !this.logs.length) {
      body = html`<nunt-loading compact text="正在读取日志…"></nunt-loading>`;
    } else if (!this.logs.length) {
      body = html`<nunt-empty compact text="暂无日志" hint="有日志产生时会实时出现在这里。"></nunt-empty>`;
    } else {
      body = html`<div class="pdashboard-log">${this.logs.slice(-LOG_LIMIT).map((entry) => this.logLine(entry))}</div>`;
    }
    return html`<section class="card">
      <div class="card-header">
        <h2>最近日志</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.ctx.navigate('logs')}>查看全部</sl-button>
      </div>
      <div class="card-body">${body}</div>
    </section>`;
  }

  render() {
    return html`
      ${this.renderProcessCard()}
      ${this.renderHostCard()}
      ${this.renderDDNSCard()}
      ${this.renderModuleCard()}
      ${this.renderLogCard()}`;
  }
}

define('nunt-page-dashboard', DashboardPage);

export default {
  id: 'dashboard',
  title: '概览',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 1116 0"/><path d="M12 13l4-3"/><path d="M4 17h16"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-dashboard');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
