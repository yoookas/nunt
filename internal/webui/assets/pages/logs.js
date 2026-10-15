// 日志页：历史日志 + SSE 实时追加，支持级别过滤、关键字搜索、自动滚动、清屏、导出。
//
// 阶段 2 迁移：日志列表改成 kit 的 nunt-table（列定义交给 kit，自动滚屏 / 级别过滤 /
// 关键字搜索 / 清屏 / 导出 / 实时跟随这些行为逐条保留），工具栏换成 sl-select / sl-input /
// sl-switch / sl-button，卡片标题 h2。数据流与迁移前一致：同一个接口
// （GET /api/v1/system/logs?limit=500）与字段名、同样的 3000 行窗口、160ms 搜索防抖。
//
// 长日志行的换行与缩进修在页面私有样式里（.plogs-* 前缀，随 cleanup 移除）：
// 迁移前是 flex 三列（时间戳 | 级别 | 消息），消息换行后第二行会顶到最左边、和上面的
// 时间戳挤在一起；现在用页面样式把表格改成固定三列的 grid，消息列加悬挂缩进 ——
// 换行后的行首缩进到首行文字下方，不再回退到时间戳那一列。
import {
  NuntElement, html, nothing, define, toast, errorMessage, fmtTime,
} from '../lib/kit.js';

const MAX_LINES = 3000;
const MAX_KEEP = MAX_LINES * 2;
const LEVELS = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.plogs-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:10px}',
  '.plogs-tools .plogs-level{width:150px}',
  '.plogs-tools .plogs-search{width:220px}',
  '.plogs-tools .plogs-switch{margin-bottom:9px}',
  '.plogs-count{font-size:12.5px;color:var(--text-dim);align-self:center;white-space:nowrap;padding-bottom:6px}',
  // 日志视图：表格本身当终端用（黑底、等宽、12.5px、固定高度可滚动），
  // 配色沿用迁移前 style.css 里 .log-view / .log-line 的那一套。
  '.plogs-view{height:min(62vh,560px);overflow:auto;background:#080b10;border-radius:var(--radius-sm);font-family:var(--sl-font-mono);font-size:12.5px}',
  '.plogs-view .nunt-table{font-size:12.5px;line-height:1.6}',
  '.plogs-view .nunt-table thead th{background:#05080c;border-bottom:1px solid #1b2230;color:#8b96a8}',
  // 三列固定：时间戳 | 级别 | 消息，消息列拿到确定的宽度后才能做悬挂缩进。
  '.plogs-view .nunt-table th:nth-child(1),.plogs-view .nunt-table td:nth-child(1){width:170px;white-space:nowrap}',
  '.plogs-view .nunt-table th:nth-child(2),.plogs-view .nunt-table td:nth-child(2){width:74px;white-space:nowrap}',
  '.plogs-view .nunt-table td{padding:2px 12px;border-bottom:0;vertical-align:top;word-break:break-word}',
  '.plogs-view .nunt-table td:nth-child(1){color:#8b96a8}',
  '.plogs-view .nunt-table tbody tr{color:#c8d1de}',
  '.plogs-view .nunt-table tbody tr:hover{background:#0d1119}',
  '.plogs-view .nunt-table .nunt-muted-cell{color:#8b96a8}',
  // 级别徽标按等级着色（badge 自带的 variant 保留，这里只做终端风格的强调）。
  '.plogs-view .plogs-lv{font-weight:600;text-transform:uppercase}',
  '.plogs-view .plogs-lv.level-debug{color:#9aa5b8}',
  '.plogs-view .plogs-lv.level-info{color:#6ba7ff}',
  '.plogs-view .plogs-lv.level-warn{color:#f5a524}',
  '.plogs-view .plogs-lv.level-error{color:#ff7b82}',
  // 悬挂缩进：首行顶格、换行后的行整体缩进 2em，行首与首行文字对齐。
  '.plogs-msg{display:block;white-space:pre-wrap;overflow-wrap:anywhere;text-indent:-2em;padding-left:2em}',
  '.plogs-msg.level-warn{color:#f7d9a4}',
  '.plogs-msg.level-error{color:#ffc0c4}',
  '.plogs-attrs{color:#96a2b5}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（与迁移前一致） */

function normalizeLog(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { time: null, level: 'info', msg: entry, attrs: null };
  if (typeof entry !== 'object') return { time: null, level: 'info', msg: String(entry), attrs: null };
  const attrs = entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null;
  return {
    time: entry.time || entry.timestamp || null,
    level: String(entry.level || entry.lvl || 'info').toLowerCase(),
    msg: String(entry.msg || entry.message || ''),
    attrs,
  };
}

function attrsText(attrs) {
  if (!attrs) return '';
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
  return parts.length ? '  ' + parts.join('  ') : '';
}

function levelClass(level) {
  const value = String(level || '').toLowerCase();
  if (value.startsWith('err') || value === 'fatal') return 'level-error';
  if (value.startsWith('warn')) return 'level-warn';
  if (value.startsWith('deb')) return 'level-debug';
  return 'level-info';
}

function lineText(item) {
  return fmtTime(item.time) + '  ' + String(item.level || 'info').toUpperCase().padEnd(5, ' ') + '  ' + item.msg + attrsText(item.attrs);
}

/** downloadText 触发浏览器下载（与迁移前 lib/ui.js 的实现一致，页面不再依赖它）。 */
function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ 页面 */

class LogsPage extends NuntElement {
  static properties = {
    entries: { attribute: false },
    level: { type: String },
    keyword: { type: String },
    autoScroll: { type: Boolean },
    follow: { type: Boolean },
    loading: { type: Boolean },
    error: { attribute: false },
    serverLevel: { type: String },
    visible: { attribute: false },
  };

  constructor() {
    super();
    this.ctx = null;
    this.entries = [];
    this.level = '';
    this.keyword = '';
    this.autoScroll = true;
    this.follow = true;
    this.loading = true;
    this.error = null;
    this.serverLevel = '';
    this.visible = [];
    this.seq = 0;
    this.filterTimer = null;
    this.started = false;
    this.offSSE = null;
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.started) return;
    this.started = true;
    this.offSSE = this.ctx.onSSE((payload) => this.onEvent(payload));
    this.load(true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stop();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：清掉防抖定时器、断开 SSE 订阅、移除元素。 */
  dispose() {
    this.stop();
    this.disposed = true;
    this.remove();
  }

  /** stop 真的断开 SSE 订阅与定时器（重复调用安全，cleanup 与 disconnectedCallback 都会调）。 */
  stop() {
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    if (this.offSSE) {
      try { this.offSSE(); } catch (err) { /* 忽略 */ }
      this.offSSE = null;
    }
  }

  updated(changed) {
    if (changed && changed.has('visible') && this.autoScroll) this.scrollToBottom();
  }

  scrollToBottom() {
    const view = this.querySelector('.plogs-view');
    if (view) view.scrollTop = view.scrollHeight;
  }

  /* ---------------------------------------------------------------- 数据 */

  visibleItems() {
    const min = this.level ? (LEVEL_RANK[this.level] || 0) : 0;
    const key = this.keyword.trim().toLowerCase();
    if (!min && !key) return this.entries.slice();
    const out = [];
    for (const item of this.entries) {
      if (min && (LEVEL_RANK[item.level] || 20) < min) continue;
      if (key && (item.msg + ' ' + attrsText(item.attrs)).toLowerCase().indexOf(key) < 0) continue;
      out.push(item);
    }
    return out;
  }

  // refreshWindow 只把「可见窗口」交给表格：与迁移前一样最多渲染最后 3000 行，
  // 计数仍然是完整命中数（例如「1200 / 3000 条」）。
  refreshWindow() {
    const items = this.visibleItems();
    this.visible = items.length > MAX_LINES ? items.slice(items.length - MAX_LINES) : items;
  }

  push(entry) {
    const item = normalizeLog(entry);
    if (!item) return;
    item.seq = this.seq;
    this.seq += 1;
    const next = this.entries.concat([item]);
    this.entries = next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next;
    if (this.follow) this.refreshWindow();
  }

  onEvent(payload) {
    if (this.disposed || !this.follow || !payload || payload.type !== 'log') return;
    this.push(payload.data);
  }

  async load(reset) {
    this.loading = true;
    if (reset) {
      this.entries = [];
      this.visible = [];
      this.seq = 0;
    }
    try {
      const data = await this.ctx.api.get('/api/v1/system/logs', { limit: 500 });
      if (this.disposed) return;
      const list = data && Array.isArray(data.entries) ? data.entries : [];
      const items = [];
      for (const raw of list) {
        const item = normalizeLog(raw);
        if (!item) continue;
        item.seq = this.seq;
        this.seq += 1;
        items.push(item);
      }
      this.entries = items;
      if (data && data.level) this.serverLevel = String(data.level);
      this.error = null;
      this.refreshWindow();
    } catch (err) {
      if (this.disposed) return;
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  /* ---------------------------------------------------------------- 动作 */

  setLevel(value) {
    this.level = String(value || '');
    this.refreshWindow();
  }

  onSearchInput(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      if (this.disposed) return;
      this.keyword = value;
      this.refreshWindow();
    }, 160);
  }

  // onViewScroll：手动滚到底部恢复自动滚动，往上滚就停下来（与迁移前一致），
  // 并把结果同步回「自动滚动」开关。
  onViewScroll(event) {
    const view = event.target;
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    if (nearBottom === this.autoScroll) return;
    this.autoScroll = nearBottom;
    if (nearBottom) this.scrollToBottom();
  }

  onAutoScrollChange(event) {
    this.autoScroll = !!(event.target && event.target.checked);
    if (this.autoScroll) this.scrollToBottom();
  }

  onFollowChange(event) {
    this.follow = !!(event.target && event.target.checked);
    if (this.follow) this.refreshWindow();
  }

  clearView() {
    this.entries = [];
    this.visible = [];
    this.error = null;
    toast('已清空当前视图（不影响服务端日志）', 'info');
  }

  exportView() {
    const items = this.visibleItems();
    if (!items.length) {
      toast('没有可导出的日志', 'warn');
      return;
    }
    const eol = String.fromCharCode(10);
    const text = items.map(lineText).join(eol);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadText('nunt-logs-' + stamp + '.log', text + eol, 'text/plain;charset=utf-8');
    toast('已导出 ' + items.length + ' 条日志', 'ok');
  }

  /* ---------------------------------------------------------------- 渲染 */

  logColumns() {
    return [
      {
        key: 'time',
        title: '时间',
        sort: (row) => (row && row.time ? String(row.time) : ''),
        render: (row) => html`<span>${fmtTime(row.time)}</span>`,
      },
      {
        key: 'level',
        title: '级别',
        sort: (row) => (row ? LEVEL_RANK[row.level] || 0 : 0),
        render: (row) => {
          const level = String((row && row.level) || 'info');
          return html`<span class=${'plogs-lv ' + levelClass(level)}>${level}</span>`;
        },
      },
      {
        key: 'msg',
        title: '内容',
        render: (row) => {
          const extra = attrsText(row.attrs);
          return html`<span class=${'plogs-msg ' + levelClass(row.level)}>${row.msg}${extra ? html`<span class="plogs-attrs">${extra}</span>` : nothing}</span>`;
        },
      },
    ];
  }

  render() {
    const total = this.entries.length;
    const shown = this.visible.length;
    const counter = shown === total ? total + ' 条' : shown + ' / ' + total + ' 条';
    return html`<section class="card">
      <div class="card-header">
        <h2>运行日志</h2>
        <span class="spacer"></span>
        <span class="sub">实时推送 + 服务端缓存</span>
      </div>
      <div class="card-body">
        <div class="plogs-tools">
          <sl-select class="plogs-level" size="small" label="日志级别" .value=${this.level}
            title=${this.serverLevel ? '服务端日志级别：' + this.serverLevel : ''}
            @sl-change=${(event) => this.setLevel(event.target.value)}>
            ${LEVELS.map((item) => html`<sl-option value=${item.value}>${item.label}</sl-option>`)}
          </sl-select>
          <sl-input class="plogs-search" size="small" label="搜索关键字" placeholder="搜索关键字…"
            @sl-input=${(event) => this.onSearchInput(event)}></sl-input>
          <sl-switch class="plogs-switch" size="small" aria-label="自动滚动" ?checked=${this.autoScroll}
            @sl-change=${(event) => this.onAutoScrollChange(event)}>自动滚动</sl-switch>
          <sl-switch class="plogs-switch" size="small" aria-label="实时跟随" ?checked=${this.follow}
            @sl-change=${(event) => this.onFollowChange(event)}>实时跟随</sl-switch>
          <span class="spacer"></span>
          <span class="plogs-count">${counter}</span>
          <sl-button size="small" @click=${() => this.clearView()}>清屏</sl-button>
          <sl-button size="small" @click=${() => this.exportView()}>导出</sl-button>
          <sl-button size="small" ?loading=${this.loading} @click=${() => this.load(true)}>
            <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>重新加载
          </sl-button>
        </div>
        <div class="plogs-view" @scroll=${(event) => this.onViewScroll(event)}>
          <nunt-table caption="运行日志"
            .columns=${this.logColumns()} .rows=${this.visible} .loading=${this.loading}
            .error=${this.error} .onRetry=${() => this.load(true)}
            .rowKey=${(row) => 'seq:' + row.seq} .sortable=${false}
            empty=${total ? '没有匹配的日志' : '暂无日志'}
            emptyHint=${total ? '换个级别或关键字试试。' : '服务端日志为空时这里会显示这一行，有新日志会实时出现。'}></nunt-table>
        </div>
      </div>
    </section>`;
  }
}

define('nunt-page-logs', LogsPage);

export default {
  id: 'logs',
  title: '日志',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v14H4z"/><path d="M7 9h10M7 13h7"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-logs');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要订阅/取数
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
