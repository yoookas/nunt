// nunt 共享组件层（kit）：Shoelace 组件 + Lit 之上的内部构件。
//
// 为什么有这一层：Shoelace 没有表格、没有 toast、没有字段包装，而 12 个页面都要用
// 同一套表格/表单/反馈/对话框，才能避免「列宽失衡、状态竖排、操作列被裁切」这类
// 每个页面各写一遍的问题。页面的数据流（ctx.api 取数、写回）留在页面里，kit 只管显示。
//
// 设计约束（docs/CONTRACT.md 第 7 节）：
//   * 全部 light DOM：NuntElement.createRenderRoot() 返回 this，复用全局样式与设计 token，
//     需要微调控件时用 ::part() 与 --sl-* 变量，不隔断样式；
//   * 不拼 innerHTML：所有数据都走 Lit 的文本绑定或 DOM 节点，后端字符串不会变成 HTML；
//   * light DOM 下没有 <slot>，所以「插槽」用属性传：表格的操作列用 columns[].render，
//     状态块用 action 属性，对话框内容用 openDialog({ body })。
//
// 页面模板（最小示例）见 docs/CONTRACT.md 第 7 节。
import { LitElement, html, nothing, render } from '../vendor/lit/lit-element.js';
import { repeat } from '../vendor/lit/directives/repeat.js';
import { ifDefined } from '../vendor/lit/directives/if-defined.js';
import { classMap } from '../vendor/lit/directives/class-map.js';
// 注册全部 sl-* 组件，并把图标基准路径指向本地 vendor（零外部请求，符合 CSP）。
import '../vendor/shoelace/nunt-shoelace.js';
// 纯格式化函数继续与 lib/ui.js 共用一份实现；阶段 3 会把它们整体搬进本文件。
export { fmtBytes, fmtTime, fmtDuration, escapeHtml } from './ui.js';

export { html, nothing, repeat, ifDefined, classMap };

/* ------------------------------------------------------------------ data: URL 垫片 */

// Shoelace 的内置图标库（library="system"）把内联 SVG 编码成 data: URL，而 sl-icon 是用
// fetch(url, { mode: 'cors' }) 去读它的。Chrome 的 fetch 在 cors 模式下拒绝 data: URL，
// 于是每渲染一个内置图标（下拉箭头、复选框勾、对话框关闭按钮、标签删除按钮…）控制台就会
// 多出两条报错："Connecting to 'data:...'" 与 "Fetch API cannot load data:..."。
// 这里只对 data: URL 加一层本地垫片：解出内容、造一个 200 Response，其它请求原样透传。
// 不走网络、不改 CSP、也不改 vendor 目录（vendor 由同步脚本生成，不允许手改）。
let dataURLShimInstalled = false;

function dataURLToResponse(url) {
  const comma = url.indexOf(',');
  const header = comma >= 0 ? url.slice(5, comma) : '';
  const payload = comma >= 0 ? url.slice(comma + 1) : '';
  const isBase64 = /;base64$/i.test(header);
  const mime = (header.split(';')[0] || 'text/plain').trim() || 'text/plain';
  let body = payload;
  try {
    body = isBase64 ? atob(payload) : decodeURIComponent(payload);
  } catch (err) {
    body = payload;
  }
  return new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': mime } });
}

function installDataURLFetch() {
  if (dataURLShimInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  dataURLShimInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function nuntFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '');
    if (url.slice(0, 5) === 'data:') return Promise.resolve(dataURLToResponse(url));
    return nativeFetch(input, init);
  };
}

installDataURLFetch();

/* ------------------------------------------------------------------ 基础工具 */

/** TONES：kit 统一用语义色名，内部映射到 Shoelace 的 variant。 */
export const TONES = { ok: 'success', warn: 'warning', err: 'danger', error: 'danger', info: 'primary', neutral: 'neutral' };

export function toneVariant(tone) {
  return TONES[tone] || 'neutral';
}

const TONE_ICONS = {
  ok: 'check-circle',
  warn: 'exclamation-triangle',
  err: 'x-circle',
  error: 'x-circle',
  info: 'info-circle',
  neutral: 'info-circle',
};

export function toneIcon(tone) {
  return TONE_ICONS[tone] || 'info-circle';
}

/** iconEl 创建一个 sl-icon 元素（用于命令式构造的 DOM，例如 toast）。 */
export function iconEl(name, label) {
  const node = document.createElement('sl-icon');
  node.setAttribute('name', String(name || 'info-circle'));
  if (label) {
    node.setAttribute('label', String(label));
    node.setAttribute('role', 'img');
  } else {
    node.setAttribute('aria-hidden', 'true');
  }
  return node;
}

/** badge 返回一个 sl-badge 元素，tone: ok | warn | err | info | neutral。 */
export function badge(text, tone) {
  const node = document.createElement('sl-badge');
  node.setAttribute('variant', toneVariant(tone));
  node.setAttribute('pill', '');
  node.textContent = text === null || text === undefined ? '' : String(text);
  return node;
}

/**
 * versionText 把 /api/v1/system/info 的 version 字段变成一行文本。
 * 后端返回的是对象（name/version/commit/buildTime/goVersion/os/arch），
 * 直接拼进文本就会显示成 [object Object]，所以这里统一兜底。
 */
export function versionText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const candidates = [value.version, value.Version, value.tag, value.name, value.Name];
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim()) return item.trim();
      if (typeof item === 'number') return String(item);
    }
  }
  return '—';
}

/** infoVersionText 取 system/info 的版本号（外壳顶栏/侧栏与概览卡片共用）。 */
export function infoVersionText(info) {
  if (!info) return '—';
  return versionText(info.version !== undefined ? info.version : info);
}

/** errorMessage 从任意错误里取一句人话。 */
export function errorMessage(err, fallback) {
  if (!err) return fallback || '未知错误';
  if (typeof err === 'string') return err;
  const message = err.message || err.error || err.detail;
  if (typeof message === 'string' && message) return message;
  return fallback || '未知错误';
}

/**
 * friendlyMessage 把协议层的错误翻译成人话。
 * 典型场景：模块没启用时后端返回 404 + Go 默认响应体「404 page not found」，
 * 页面不应该把这行原文摊在界面上。
 */
export function friendlyMessage(err, options) {
  const opts = options || {};
  const status = Number(err && (err.status || err.statusCode)) || 0;
  if (status === 404) return opts.notFound || '接口不存在或对应模块未启用（HTTP 404）';
  if (status === 403) return '没有权限访问该资源（HTTP 403）';
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 429) return '操作过于频繁，请稍后再试（HTTP 429）';
  if (status >= 500) return '服务器内部错误（HTTP ' + status + '）';
  const message = errorMessage(err, opts.fallback);
  if (/^\s*404\s+page\s+not\s+found\s*$/i.test(message)) return opts.notFound || '接口不存在或对应模块未启用（HTTP 404）';
  return message;
}

/** attrSelector 把字段名安全地放进 CSS 选择器（只用于 querySelector 的 [data-*] 值）。 */
function attrSelector(name) {
  return '[data-nunt-field="' + String(name).replace(/["\\]/g, '\\$&') + '"]';
}

/* ------------------------------------------------------------------ 组件基类 */

/**
 * NuntElement 是所有 kit 组件的基类：light DOM（不建 shadow root），
 * 全局样式、设计 token 与页面里的 CSS 都能直接作用到组件内部的节点。
 */
export class NuntElement extends LitElement {
  createRenderRoot() {
    return this;
  }
}

/** define 幂等注册自定义元素。 */
export function define(tag, klass) {
  if (!customElements.get(tag)) customElements.define(tag, klass);
  return klass;
}

/** renderInto 把一个 Lit 模板渲染进容器。 */
export function renderInto(container, template) {
  render(template, container);
  return container;
}

function compareValues(a, b) {
  const na = typeof a === 'number' ? a : (a === null || a === undefined || a === '' ? null : Number(a));
  const nb = typeof b === 'number' ? b : (b === null || b === undefined || b === '' ? null : Number(b));
  if (na !== null && nb !== null && !isNaN(na) && !isNaN(nb)) return na === nb ? 0 : (na < nb ? -1 : 1);
  const sa = a === null || a === undefined ? '' : String(a);
  const sb = b === null || b === undefined ? '' : String(b);
  return sa.localeCompare(sb, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

/* ------------------------------------------------------------------ 状态块 */

/** NuntEmpty：空状态。light DOM 没有 slot，附加内容用 action 属性传模板。 */
export class NuntEmpty extends NuntElement {
  static properties = {
    text: { type: String },
    hint: { type: String },
    icon: { type: String },
    compact: { type: Boolean },
    action: { attribute: false },
  };

  constructor() {
    super();
    this.text = '暂无数据';
    this.hint = '';
    this.icon = 'dash-circle';
    this.compact = false;
    this.action = null;
  }

  render() {
    return html`<div class="nunt-state nunt-state--empty ${classMap({ 'is-compact': this.compact })}" role="status">
      <sl-icon name=${this.icon} aria-hidden="true"></sl-icon>
      <p class="nunt-state-title">${this.text}</p>
      ${this.hint ? html`<p class="nunt-state-hint">${this.hint}</p>` : nothing}
      ${this.action ? html`<div class="nunt-state-action">${this.action}</div>` : nothing}
    </div>`;
  }
}

/** NuntLoading：加载态。 */
export class NuntLoading extends NuntElement {
  static properties = { text: { type: String }, compact: { type: Boolean } };

  constructor() {
    super();
    this.text = '正在加载…';
    this.compact = false;
  }

  render() {
    return html`<div class="nunt-state nunt-state--loading ${classMap({ 'is-compact': this.compact })}" role="status" aria-live="polite">
      <sl-spinner aria-hidden="true"></sl-spinner>
      <p class="nunt-state-title">${this.text}</p>
    </div>`;
  }
}

/** NuntError：错误卡。 */
export class NuntError extends NuntElement {
  static properties = {
    error: { attribute: false },
    heading: { type: String },
    hint: { type: String },
    onRetry: { attribute: false },
    retryLabel: { type: String },
    compact: { type: Boolean },
  };

  constructor() {
    super();
    this.error = null;
    this.heading = '加载失败';
    this.hint = '';
    this.onRetry = null;
    this.retryLabel = '重试';
    this.compact = false;
  }

  render() {
    const message = friendlyMessage(this.error, { fallback: this.heading });
    return html`<div class="nunt-state nunt-state--error ${classMap({ 'is-compact': this.compact })}" role="alert">
      <sl-icon name="exclamation-octagon" aria-hidden="true"></sl-icon>
      <p class="nunt-state-title">${this.heading}</p>
      <p class="nunt-state-hint">${message}</p>
      ${this.hint ? html`<p class="nunt-state-hint">${this.hint}</p>` : nothing}
      ${typeof this.onRetry === 'function'
        ? html`<div class="nunt-state-action">
            <sl-button size="small" @click=${() => this.onRetry()}>
              <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>${this.retryLabel}
            </sl-button>
          </div>`
        : nothing}
    </div>`;
  }
}

/** emptyState / loadingState / errorCard：命令式构造，旧写法仍可 appendChild。 */
export function emptyState(text, options) {
  const opts = options || {};
  const node = document.createElement('nunt-empty');
  if (text !== undefined) node.text = text;
  if (opts.hint) node.hint = opts.hint;
  if (opts.icon) node.icon = opts.icon;
  if (opts.compact) node.compact = true;
  if (opts.action) node.action = opts.action;
  return node;
}

export function loadingState(text, options) {
  const opts = options || {};
  const node = document.createElement('nunt-loading');
  if (text) node.text = text;
  if (opts.compact) node.compact = true;
  return node;
}

export function errorCard(err, options) {
  const opts = options || {};
  const node = document.createElement('nunt-error');
  node.error = err;
  if (opts.title) node.heading = opts.title;
  if (opts.hint) node.hint = opts.hint;
  if (opts.retryLabel) node.retryLabel = opts.retryLabel;
  if (typeof opts.onRetry === 'function') node.onRetry = opts.onRetry;
  if (opts.compact) node.compact = true;
  return node;
}

/* ------------------------------------------------------------------ 分页 */

/** NuntPager：上一页/下一页 + 页码与总数。 */
export class NuntPager extends NuntElement {
  static properties = {
    page: { type: Number },
    hasNext: { type: Boolean },
    total: { type: Number },
    onPage: { attribute: false },
    label: { type: String },
  };

  constructor() {
    super();
    this.page = 1;
    this.hasNext = false;
    this.total = 0;
    this.onPage = null;
    this.label = '';
  }

  go(next) {
    if (typeof this.onPage !== 'function') return;
    const page = Math.max(1, Number(next) || 1);
    if (page === this.page) return;
    this.onPage(page);
  }

  render() {
    const totalText = this.total > 0 ? '共 ' + this.total + ' 条' : '';
    return html`<div class="nunt-pager" role="group" aria-label=${ifDefined(this.label || '分页')}>
      ${totalText ? html`<span class="nunt-pager-total">${totalText}</span>` : nothing}
      <sl-button size="small" ?disabled=${this.page <= 1} @click=${() => this.go(this.page - 1)}>
        <sl-icon slot="prefix" name="chevron-left"></sl-icon>上一页
      </sl-button>
      <span class="nunt-pager-page">第 ${this.page} 页</span>
      <sl-button size="small" ?disabled=${!this.hasNext} @click=${() => this.go(this.page + 1)}>
        下一页<sl-icon slot="suffix" name="chevron-right"></sl-icon>
      </sl-button>
    </div>`;
  }
}

/* ------------------------------------------------------------------ 数据表格 */

/**
 * NuntTable：统一的数据表格（原生 table + 设计 token）。
 *
 * 列定义：{ key, title, width, align, sortable, sort(row), render(row, index),
 *           actions, className, headerTitle, placeholder }
 *   * render 返回字符串/数字/节点/Lit 模板，全部按文本或元素插入（不走 innerHTML）；
 *   * actions: true 表示操作列：右对齐、不换行、统一包在 .nunt-actions 里；
 *   * title 省略时按「操作」渲染，避免 axe 的 empty-table-header。
 * 状态：loading（加载态）、error（错误卡 + 重试）、empty（空状态）；
 * 分页：给了 onPage 就在表尾渲染 nunt-pager。
 */
export class NuntTable extends NuntElement {
  static properties = {
    columns: { attribute: false },
    rows: { attribute: false },
    rowKey: { attribute: false },
    loading: { type: Boolean },
    empty: { type: String },
    emptyHint: { type: String },
    error: { attribute: false },
    onRetry: { attribute: false },
    page: { type: Number },
    hasNext: { type: Boolean },
    onPage: { attribute: false },
    total: { type: Number },
    caption: { type: String },
    dense: { type: Boolean },
    sort: { attribute: false },
    sortable: { type: Boolean },
  };

  constructor() {
    super();
    this.columns = [];
    this.rows = [];
    this.rowKey = null;
    this.loading = false;
    this.empty = '暂无数据';
    this.emptyHint = '';
    this.error = null;
    this.onRetry = null;
    this.page = 1;
    this.hasNext = false;
    this.onPage = null;
    this.total = 0;
    this.caption = '';
    this.dense = false;
    this.sort = null;
    this.sortable = true;
  }

  get viewRows() {
    const rows = Array.isArray(this.rows) ? this.rows.slice() : [];
    const sort = this.sort;
    if (!sort || !sort.key || this.sortable === false) return rows;
    const columns = Array.isArray(this.columns) ? this.columns : [];
    const column = columns.find((item) => item && item.key === sort.key);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      let av;
      let bv;
      if (column && typeof column.sort === 'function') {
        av = column.sort(a);
        bv = column.sort(b);
      } else {
        av = a ? a[sort.key] : '';
        bv = b ? b[sort.key] : '';
      }
      return compareValues(av, bv) * dir;
    });
  }

  keyOf(row, index) {
    if (typeof this.rowKey === 'function') {
      const key = this.rowKey(row, index);
      if (key !== undefined && key !== null) return String(key);
    }
    if (row && typeof row === 'object') {
      if (row.id !== undefined && row.id !== null && row.id !== '') return 'id:' + String(row.id);
      if (row.key !== undefined && row.key !== null && row.key !== '') return 'key:' + String(row.key);
    }
    return 'row:' + index;
  }

  toggleSort(column, index) {
    if (this.sortable === false || !column || column.sortable === false) return;
    const key = column.key === undefined ? String(index) : column.key;
    const current = this.sort;
    const dir = current && current.key === key && current.dir === 'asc' ? 'desc' : 'asc';
    const next = { key, dir };
    this.sort = next;
    this.dispatchEvent(new CustomEvent('nunt-sort', { detail: next, bubbles: true, composed: true }));
  }

  renderHeader(column, index) {
    const title = column.title === undefined || column.title === null || column.title === '' ? '操作' : column.title;
    const sortable = this.sortable !== false && column.sortable !== false && column.key !== undefined;
    const active = this.sort && this.sort.key === column.key ? this.sort.dir : '';
    const style = column.width ? 'width:' + (typeof column.width === 'number' ? column.width + 'px' : String(column.width)) + ';' : '';
    return html`<th scope="col"
      class=${classMap({ 'nunt-th-actions': !!column.actions, 'is-sorted': !!active, 'is-sortable': sortable })} style=${ifDefined(style || undefined)}
      aria-sort=${active === 'asc' ? 'ascending' : (active === 'desc' ? 'descending' : nothing)}>
      ${sortable
        ? html`<button type="button" class="nunt-th-button" title=${ifDefined(column.headerTitle || ('按「' + title + '」排序'))} @click=${() => this.toggleSort(column, index)}>
            <span>${title}</span>
            <sl-icon class=${classMap({ 'nunt-sort-icon': true, 'is-desc': active === 'desc' })} name="chevron-down" aria-hidden="true"></sl-icon>
          </button>`
        : html`<span class="nunt-th-label">${title}</span>`}
    </th>`;
  }

  renderCell(column, row, index) {
    const raw = typeof column.render === 'function' ? column.render(row, index) : (row ? row[column.key] : undefined);
    let value = raw;
    if (typeof value === 'function') value = value(row, index);
    const empty = value === undefined || value === null || value === '';
    const style = column.align ? 'text-align:' + column.align + ';' : '';
    const content = empty
      ? (column.placeholder ? html`<span class="nunt-muted">${column.placeholder}</span>` : nothing)
      : value;
    if (column.actions) {
      return html`<td class="nunt-td-actions" style=${ifDefined(style || undefined)}>
        <div class="nunt-actions">${content}</div>
      </td>`;
    }
    return html`<td class=${classMap({ 'nunt-muted-cell': empty })} style=${ifDefined(style || undefined)}>${content}</td>`;
  }

  renderTable(columns, rows) {
    return html`<div class="nunt-table-scroll">
      <table class=${classMap({ 'nunt-table': true, 'is-dense': this.dense })} aria-busy=${this.loading ? 'true' : 'false'}>
        ${this.caption ? html`<caption class="sr-only">${this.caption}</caption>` : nothing}
        <thead>
          <tr>${columns.map((column, index) => this.renderHeader(column, index))}</tr>
        </thead>
        <tbody>
          ${repeat(rows, (row, index) => this.keyOf(row, index), (row, index) => html`<tr>
            ${columns.map((column) => this.renderCell(column, row, index))}
          </tr>`)}
        </tbody>
      </table>
    </div>`;
  }

  render() {
    const columns = (Array.isArray(this.columns) ? this.columns : []).filter(Boolean);
    const rows = this.viewRows;
    const hasFooter = typeof this.onPage === 'function';
    let body = nothing;
    if (this.error) {
      body = html`<nunt-error .error=${this.error} .onRetry=${this.onRetry} title="无法加载数据"></nunt-error>`;
    } else if (this.loading && !rows.length) {
      body = html`<nunt-loading></nunt-loading>`;
    } else if (!rows.length) {
      body = html`<nunt-empty text=${this.empty} hint=${this.emptyHint}></nunt-empty>`;
    } else {
      body = this.renderTable(columns, rows);
    }
    return html`<div class=${classMap({ 'nunt-table-wrap': true, 'is-loading': !!this.loading })}>
      ${body}
      ${hasFooter
        ? html`<nunt-pager .page=${Math.max(1, Number(this.page) || 1)} .hasNext=${!!this.hasNext}
            .total=${Number(this.total) || 0} .onPage=${this.onPage}></nunt-pager>`
        : nothing}
    </div>`;
  }
}

/** table 便捷构造：table({columns, rows, ...}) 返回一个 nunt-table 元素。 */
export function table(config) {
  const node = document.createElement('nunt-table');
  applyTableConfig(node, config || {});
  return node;
}

/** applyTableConfig 把配置写进已存在的 nunt-table（页面刷新数据时复用同一个表格）。 */
export function applyTableConfig(node, config) {
  const cfg = config || {};
  for (const key of ['columns', 'rows', 'rowKey', 'loading', 'empty', 'emptyHint', 'error', 'onRetry', 'page', 'hasNext', 'onPage', 'total', 'caption', 'dense', 'sort', 'sortable']) {
    if (cfg[key] !== undefined) node[key] = cfg[key];
  }
  return node;
}

/* ------------------------------------------------------------------ 表单 */

/**
 * NuntTags：多行标签输入（值是一个数组）。
 * 输入框里回车/逗号/分号/换行都会变成一枚标签；粘贴多行文本会一次拆成多个标签；
 * 每枚标签可以单独删除。value 始终是当前标签数组。
 * label 会转交给内部的 sl-input（阴影里的 <input> 需要可见标签，否则 axe 判 label-title-only）。
 */
export class NuntTags extends NuntElement {
  static properties = {
    value: { attribute: false },
    placeholder: { type: String },
    disabled: { type: Boolean },
    label: { type: String },
  };

  constructor() {
    super();
    this.value = [];
    this.placeholder = '输入后按回车添加';
    this.disabled = false;
    this.input = '';
    // label 是必须的：内层 sl-input 的真实 <input> 在 shadow DOM 里只带
    // aria-describedby="help-text"，没有可访问名称时 axe 会判 label-title-only/serious。
    // 只有把 label 交给 sl-input，阴影里的 <label for="input"> 才会渲染出可见文字。
    this.label = '';
  }

  willUpdate() {
    if (!Array.isArray(this.value)) this.value = this.value === undefined || this.value === null || this.value === '' ? [] : [String(this.value)];
  }

  add(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw);
    const parts = text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = Array.isArray(this.value) ? this.value.slice() : [];
    for (const part of parts) if (next.indexOf(part) < 0) next.push(part);
    this.value = next;
    this.input = '';
    this.changed();
  }

  remove(index) {
    const next = (Array.isArray(this.value) ? this.value : []).slice();
    next.splice(index, 1);
    this.value = next;
    this.changed();
  }

  changed() {
    this.dispatchEvent(new CustomEvent('nunt-change', { detail: { value: this.value }, bubbles: true, composed: true }));
  }

  render() {
    const items = Array.isArray(this.value) ? this.value : [];
    // 顺序：先把带可见 label 的输入框放在最上面（label 由 sl-input 渲染，控件与标签天然关联），
    // 已添加的标签排在下面。这样 nunt-form 里就不需要再渲染一遍外层标签。
    return html`<div class=${classMap({ 'nunt-tags': true, 'is-disabled': !!this.disabled })}>
      <sl-input size="small" label=${this.label || nothing} .value=${this.input}
        placeholder=${this.placeholder} ?disabled=${!!this.disabled}
        @sl-input=${(event) => { this.input = event.target.value; }}
        @keydown=${(event) => {
          if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault();
            this.add(this.input);
          } else if (event.key === 'Backspace' && !this.input && items.length) {
            this.remove(items.length - 1);
          }
        }}
        @sl-change=${() => { if (this.input) this.add(this.input); }}></sl-input>
      ${items.length
        ? html`<div class="nunt-tags-list">
            ${items.map((item, index) => html`<sl-tag size="small" removable ?disabled=${!!this.disabled}
              @sl-remove=${() => this.remove(index)}>${item}</sl-tag>`)}
          </div>`
        : nothing}
    </div>`;
  }
}

/**
 * NuntKV：键值对编辑（值是一个对象）。
 * 行内输入不触发重渲染（否则光标会跳），read()/value 以 rows 为准。
 */
export class NuntKV extends NuntElement {
  static properties = { value: { attribute: false }, disabled: { type: Boolean } };

  constructor() {
    super();
    this.value = {};
    this.disabled = false;
    this.rows = [];
  }

  willUpdate() {
    const source = this.value;
    const rows = [];
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const key of Object.keys(source)) rows.push({ key, value: source[key] === undefined || source[key] === null ? '' : String(source[key]) });
    } else if (Array.isArray(source)) {
      for (const item of source) rows.push({ key: item && item.key ? String(item.key) : '', value: item && item.value !== undefined ? String(item.value) : '' });
    }
    this.rows = rows;
  }

  read() {
    const out = {};
    for (const row of this.rows) {
      const key = String(row.key || '').trim();
      if (key) out[key] = row.value;
    }
    return out;
  }

  changed() {
    this.value = this.read();
    this.dispatchEvent(new CustomEvent('nunt-change', { detail: { value: this.value }, bubbles: true, composed: true }));
  }

  addRow() {
    this.rows = this.rows.concat([{ key: '', value: '' }]);
  }

  removeRow(index) {
    const rows = this.rows.slice();
    rows.splice(index, 1);
    this.rows = rows;
    this.changed();
  }

  render() {
    return html`<div class="nunt-kv">
      ${this.rows.map((row, index) => html`<div class="nunt-kv-row">
        <sl-input size="small" placeholder="名称" .value=${row.key} ?disabled=${!!this.disabled}
          @sl-input=${(event) => { row.key = event.target.value; }} @sl-change=${() => this.changed()}></sl-input>
        <sl-input size="small" placeholder="值" .value=${row.value} ?disabled=${!!this.disabled}
          @sl-input=${(event) => { row.value = event.target.value; }} @sl-change=${() => this.changed()}></sl-input>
        <sl-icon-button name="x-lg" label="删除这一项" ?disabled=${!!this.disabled} @click=${() => this.removeRow(index)}></sl-icon-button>
      </div>`)}
      <div class="nunt-kv-add">
        <sl-button size="small" ?disabled=${!!this.disabled} @click=${() => this.addRow()}>
          <sl-icon slot="prefix" name="plus-lg"></sl-icon>添加一项
        </sl-button>
      </div>
    </div>`;
  }
}

/**
 * NuntForm：字段网格。字段定义与 lib/ui.js 的 formGrid 保持一致，便于逐页迁移：
 *   { name, label, type, value, options, placeholder, hint, error, wide, disabled,
 *     readonly, required, min, max, step, rows, multiple, text, onChange }
 * type: text | password | number | url | email | textarea | select | switch | checkbox |
 *       tags（多行标签输入）| kv（键值对）| custom/html
 * 读取一律走 read()：输入过程中的值存在 draft 里，重渲染（例如显示字段错误）不会丢字。
 * 标签交给 sl-input/sl-select/sl-textarea 的 label 属性，控件与标签天然关联（axe 的 label/select-name 规则）。
 */
export class NuntForm extends NuntElement {
  static properties = {
    fields: { attribute: false },
    errorMessage: { attribute: false },
    columns: { type: Number },
    onFieldChange: { attribute: false },
  };

  constructor() {
    super();
    this.fields = [];
    this.errorMessage = '';
    this.columns = 0;
    this.onFieldChange = null;
    this.draft = new Map();
    this.fieldErrors = new Map();
    this.hiddenFields = new Set();
  }

  willUpdate() {
    for (const field of Array.isArray(this.fields) ? this.fields : []) {
      if (!field || !field.name) continue;
      const name = String(field.name);
      if (!this.draft.has(name)) {
        if (field.type === 'switch' || field.type === 'checkbox') this.draft.set(name, !!field.value);
        else if (field.value === undefined || field.value === null) this.draft.set(name, field.type === 'select' && field.multiple ? [] : '');
        else this.draft.set(name, field.value);
      }
    }
  }

  valueOf(field) {
    const name = String(field.name || '');
    return this.draft.has(name) ? this.draft.get(name) : field.value;
  }

  track(field, value) {
    const name = String(field.name || '');
    this.draft.set(name, value);
    if (typeof field.onChange === 'function') {
      try { field.onChange(value); } catch (err) { /* 页面回调异常不影响输入 */ }
    }
    if (typeof this.onFieldChange === 'function') {
      try { this.onFieldChange(name, value); } catch (err) { /* 忽略 */ }
    }
  }

  link(field) {
    return (event) => this.track(field, event.target.value);
  }

  linkChecked(field) {
    return (event) => this.track(field, !!event.target.checked);
  }

  renderLabel(field) {
    if (field.label === false || field.label === undefined) return nothing;
    return html`<span class="nunt-field-label">${field.label}</span>`;
  }

  renderHint(field, ownsHelp) {
    const name = String(field.name || '');
    const error = this.fieldErrors.get(name);
    if (error) return html`<span class="nunt-field-hint is-error" role="alert">${error}</span>`;
    if (field.hint && !ownsHelp) return html`<span class="nunt-field-hint">${field.hint}</span>`;
    return nothing;
  }

  renderControl(field) {
    const type = field.type || 'text';
    const name = String(field.name || '');
    const value = this.valueOf(field);
    const invalid = this.fieldErrors.has(name);
    const help = this.fieldErrors.get(name) || field.hint || '';
    const label = field.label === false ? nothing : (field.label === undefined ? nothing : field.label);
    if (type === 'custom' || type === 'html') {
      const node = field.node || (typeof field.render === 'function' ? field.render(field) : String(field.value === undefined ? '' : field.value));
      return html`<div class="nunt-control nunt-control-custom">${node}</div>`;
    }
    if (type === 'switch') {
      return html`<sl-switch data-nunt-field=${name} ?checked=${!!value} ?disabled=${!!field.disabled}
        @sl-change=${this.linkChecked(field)}>${field.text || field.label || ''}</sl-switch>`;
    }
    if (type === 'checkbox') {
      return html`<sl-checkbox data-nunt-field=${name} ?checked=${!!value} ?disabled=${!!field.disabled}
        @sl-change=${this.linkChecked(field)}>${field.text || field.label || ''}</sl-checkbox>`;
    }
    if (type === 'textarea') {
      return html`<sl-textarea class=${classMap({ 'nunt-control': true, 'is-invalid': invalid })} data-nunt-field=${name} name=${name || nothing}
        rows=${field.rows || 4} label=${label} help-text=${help || nothing} placeholder=${field.placeholder || nothing}
        aria-invalid=${invalid ? 'true' : nothing}
        .value=${value === undefined || value === null ? '' : String(value)}
        ?disabled=${!!field.disabled} ?readonly=${!!field.readonly} ?required=${!!field.required}
        @sl-input=${this.link(field)}></sl-textarea>`;
    }
    if (type === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const current = field.multiple
        ? (Array.isArray(value) ? value.map(String) : (value === undefined || value === null || value === '' ? [] : [String(value)]))
        : (value === undefined || value === null ? '' : String(value));
      return html`<sl-select class=${classMap({ 'nunt-control': true, 'is-invalid': invalid })} data-nunt-field=${name} name=${name || nothing}
        label=${label} help-text=${help || nothing} placeholder=${field.placeholder || nothing}
        aria-invalid=${invalid ? 'true' : nothing}
        .value=${current} ?multiple=${!!field.multiple} ?disabled=${!!field.disabled} ?required=${!!field.required}
        max-tag-count="responsive"
        @sl-change=${this.link(field)}>
        ${options.map((choice) => {
          const isObject = choice !== null && typeof choice === 'object';
          const optionValue = isObject ? (choice.value === undefined ? '' : choice.value) : choice;
          const optionLabel = isObject ? (choice.label === undefined ? choice.value : choice.label) : choice;
          const optionDisabled = isObject && choice.disabled ? true : false;
          return html`<sl-option value=${String(optionValue === undefined || optionValue === null ? '' : optionValue)} ?disabled=${optionDisabled}>${optionLabel}</sl-option>`;
        })}
      </sl-select>`;
    }
    if (type === 'tags') {
      // 标签交给 nunt-tags 内部的 sl-input（light DOM 没有 slot，所以用属性传），
      // nunt-form 因此不再重复渲染外层标签（见 renderField 的 ownsLabel）。
      return html`<nunt-tags class=${classMap({ 'nunt-control': true, 'is-invalid': invalid })} data-nunt-field=${name}
        label=${field.label === false || field.label === undefined ? nothing : String(field.label)}
        .value=${Array.isArray(value) ? value : []} ?disabled=${!!field.disabled}
        placeholder=${field.placeholder || '输入后按回车添加，支持逗号或换行分隔'}
        @nunt-change=${(event) => this.track(field, event.detail.value)}></nunt-tags>`;
    }
    if (type === 'kv') {
      return html`<nunt-kv class=${classMap({ 'nunt-control': true, 'is-invalid': invalid })} data-nunt-field=${name}
        .value=${value || {}} ?disabled=${!!field.disabled}
        @nunt-change=${(event) => this.track(field, event.detail.value)}></nunt-kv>`;
    }
    const inputType = type === 'password' ? 'password' : (type === 'number' ? 'number' : (type === 'url' ? 'url' : (type === 'email' ? 'email' : 'text')));
    return html`<sl-input class=${classMap({ 'nunt-control': true, 'is-invalid': invalid })} data-nunt-field=${name} name=${name || nothing}
      type=${inputType} label=${label} help-text=${help || nothing} placeholder=${field.placeholder || nothing}
      autocomplete=${field.autocomplete || 'off'} aria-invalid=${invalid ? 'true' : nothing}
      .value=${value === undefined || value === null ? '' : String(value)}
      ?disabled=${!!field.disabled} ?readonly=${!!field.readonly} ?required=${!!field.required}
      ?password-toggle=${inputType === 'password' && field.passwordToggle !== false}
      min=${field.min === undefined ? nothing : field.min} max=${field.max === undefined ? nothing : field.max}
      step=${field.step === undefined ? nothing : field.step}
      @sl-input=${this.link(field)}></sl-input>`;
  }

  renderField(field, index) {
    if (!field) return nothing;
    const type = field.type || 'text';
    const name = String(field.name || '');
    // sl-input / sl-select / sl-textarea 自己带 label（控件与标签天然关联）；
    // tags 把 label 转交给 nunt-tags 内部的 sl-input，同样不需要外层标签。
    // 只有 switch / checkbox / kv / custom 需要我们自己渲染一行标签。
    const ownsLabel = type === 'text' || type === 'password' || type === 'number' || type === 'url' || type === 'email' || type === 'textarea' || type === 'select' || type === 'tags';
    const ownsHelp = ownsLabel;
    return html`<div class=${classMap({ 'nunt-field': true, 'is-wide': !!field.wide, 'is-invalid': this.fieldErrors.has(name), hidden: this.hiddenFields.has(name) })}
      data-nunt-wrap=${name}>
      ${ownsLabel ? nothing : this.renderLabel(field)}
      ${this.renderControl(field)}
      ${this.renderHint(field, ownsHelp)}
    </div>`;
  }

  render() {
    const fields = Array.isArray(this.fields) ? this.fields : [];
    const style = this.columns > 0 ? 'grid-template-columns: repeat(' + this.columns + ', minmax(0, 1fr));' : '';
    return html`<div class="nunt-form">
      ${this.errorMessage ? html`<div class="nunt-form-error" role="alert">${this.errorMessage}</div>` : nothing}
      <div class="nunt-form-grid" style=${ifDefined(style || undefined)}>
        ${fields.map((field, index) => this.renderField(field, index))}
      </div>
    </div>`;
  }

  readField(field) {
    const name = String(field.name || '');
    const type = field.type || 'text';
    const node = name ? this.querySelector(attrSelector(name)) : null;
    if (!node) return this.draft.get(name);
    if (type === 'switch' || type === 'checkbox') return !!node.checked;
    if (type === 'tags') return Array.isArray(node.value) ? node.value.slice() : [];
    if (type === 'kv') return typeof node.read === 'function' ? node.read() : (node.value || {});
    if (type === 'select' && field.multiple) return Array.isArray(node.value) ? node.value.slice() : [];
    const raw = node.value;
    if (type === 'number') {
      if (raw === '' || raw === null || raw === undefined) return null;
      const num = Number(raw);
      return isNaN(num) ? null : num;
    }
    return raw === undefined || raw === null ? '' : raw;
  }

  read() {
    const out = {};
    for (const field of Array.isArray(this.fields) ? this.fields : []) {
      if (!field || !field.name) continue;
      out[String(field.name)] = this.readField(field);
    }
    return out;
  }

  get(name) {
    const field = (Array.isArray(this.fields) ? this.fields : []).find((item) => item && String(item.name) === String(name));
    return field ? this.readField(field) : undefined;
  }

  set(name, value) {
    const key = String(name);
    this.draft.set(key, value);
    const field = (Array.isArray(this.fields) ? this.fields : []).find((item) => item && String(item.name) === key);
    const node = this.querySelector(attrSelector(key));
    if (node && field && (field.type === 'switch' || field.type === 'checkbox')) node.checked = !!value;
    else if (node && field && (field.type === 'tags' || field.type === 'kv')) node.value = value;
    else if (node && 'value' in node) node.value = value === undefined || value === null ? '' : (Array.isArray(value) ? value : String(value));
    else this.requestUpdate();
  }

  /** error 显示表单级错误（例如保存失败）。 */
  error(message) {
    this.errorMessage = message ? String(message) : '';
  }

  /** fieldError 显示某个字段的错误；message 为空即清除。 */
  fieldError(name, message) {
    const key = String(name);
    if (message) this.fieldErrors.set(key, String(message));
    else this.fieldErrors.delete(key);
    this.requestUpdate();
  }

  clearErrors() {
    this.errorMessage = '';
    this.fieldErrors.clear();
    this.requestUpdate();
  }

  /** toggleField 显示/隐藏某个字段（用于按类型切换表单项）。 */
  toggleField(name, visible) {
    const key = String(name);
    if (visible) this.hiddenFields.delete(key);
    else this.hiddenFields.add(key);
    this.requestUpdate();
  }
}

/** formGrid 是 NuntForm 的构造函数式封装，返回 { node, read, get, set, error, ... }。 */
export function formGrid(fields, options) {
  const opts = options || {};
  const node = document.createElement('nunt-form');
  node.fields = Array.isArray(fields) ? fields : [];
  if (opts.columns) node.columns = opts.columns;
  if (typeof opts.onFieldChange === 'function') node.onFieldChange = opts.onFieldChange;
  return {
    node,
    fields: node.fields,
    read: () => node.read(),
    get: (name) => node.get(name),
    set: (name, value) => node.set(name, value),
    error: (message) => node.error(message),
    fieldError: (name, message) => node.fieldError(name, message),
    toggle: (name, visible) => node.toggleField(name, visible),
    clearErrors: () => node.clearErrors(),
  };
}

/* ------------------------------------------------------------------ 提示 / 对话框 */

/**
 * toast：用 <sl-alert toast> 弹一条提示，自动进 Shoelace 的 .sl-toast-stack（右上角、自动堆叠）。
 * type: ok | warn | err | info（也接受 success/warning/error）。
 */
export function toast(msg, type) {
  const raw = String(type === undefined || type === null ? '' : type).toLowerCase();
  const tone = raw === 'success' ? 'ok'
    : raw === 'error' ? 'err'
      : raw === 'warning' ? 'warn'
        : (TONES[raw] ? raw : 'info');
  const alert = document.createElement('sl-alert');
  alert.setAttribute('variant', toneVariant(tone));
  alert.setAttribute('closable', '');
  alert.setAttribute('duration', tone === 'err' ? '6000' : '3200');
  const icon = iconEl(toneIcon(tone));
  icon.setAttribute('slot', 'icon');
  alert.appendChild(icon);
  alert.appendChild(document.createTextNode(String(msg === undefined || msg === null ? '' : msg)));
  if (typeof alert.toast === 'function') alert.toast();
  else document.body.appendChild(alert);
  return alert;
}

/**
 * demoteDialogHeader 把 sl-dialog 阴影 DOM 里那个 <header> 的角色降级。
 *
 * 为什么需要：<header> 在 ARIA 里映射成 banner landmark，对话框一打开，页面就同时有了
 * 外壳顶栏（.topbar）和对话框标题栏两个 banner，axe 于是报
 * landmark-no-duplicate-banner + landmark-unique（阶段 2C/2D 记录的现象）。
 * 对话框内部的标题栏本来就不是页面级 landmark，把它的隐式角色去掉（role="presentation"）
 * 既消掉误报，也不影响对话框本身：面板仍然由 aria-labelledby="title" 指向阴影里的 h2，
 * 可访问名称不变。
 *
 * 这是运行时补丁，**不改 vendor 文件**；选择器取自 sl-dialog 的公开阴影结构
 * （<header part="header">），拿不到就静默跳过 —— 最坏情况退化为已知限制
 * （docs/CONTRACT.md 第 7 节「已知限制」）。
 */
function demoteDialogHeader(dialog) {
  const apply = () => {
    const root = dialog && dialog.shadowRoot;
    if (!root) return false;
    const header = root.querySelector('header');
    if (!header) return false;
    if (header.getAttribute('role') !== 'presentation') header.setAttribute('role', 'presentation');
    return true;
  };
  if (apply()) return;
  if (dialog && dialog.updateComplete && typeof dialog.updateComplete.then === 'function') {
    dialog.updateComplete.then(apply).catch(() => {});
  }
}

/**
 * openDialog：封装 sl-dialog。
 * options: { title, body（Node | Lit 模板 | 字符串）, actions: [{label, kind, onClick(api, button), close}],
 *            wide | width, onClose, onMount(api), closeOnEscape }
 * 返回 { dialog, body, footer, actions, close(), setBusy(busy, button) }。
 */
export function openDialog(options) {
  const opts = options || {};
  const dialog = document.createElement('sl-dialog');
  dialog.setAttribute('label', String(opts.title || ''));
  if (opts.width) dialog.setAttribute('style', '--width: ' + String(opts.width) + ';');
  else if (opts.wide) dialog.setAttribute('style', '--width: min(920px, 94vw);');
  else dialog.setAttribute('style', '--width: min(560px, 94vw);');

  const body = document.createElement('div');
  body.className = 'nunt-dialog-body';
  if (opts.body instanceof Node) body.appendChild(opts.body);
  else if (typeof opts.body === 'string') body.textContent = opts.body;
  else if (opts.body) render(opts.body, body);
  dialog.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'nunt-dialog-footer';
  footer.setAttribute('slot', 'footer');
  dialog.appendChild(footer);

  let closed = false;
  const api = {
    dialog,
    body,
    footer,
    buttons: {},
    get closed() { return closed; },
    close() {
      if (closed) return;
      try { dialog.hide(); } catch (err) { /* 未显示时忽略 */ }
    },
    setBusy(busy, button) {
      const nodes = footer.querySelectorAll('sl-button');
      for (const node of nodes) {
        if (busy) node.setAttribute('disabled', '');
        else node.removeAttribute('disabled');
      }
      if (button) {
        if (busy) button.setAttribute('loading', '');
        else button.removeAttribute('loading');
      }
    },
  };

  for (const action of opts.actions || []) {
    if (!action) continue;
    const button = document.createElement('sl-button');
    button.setAttribute('size', 'small');
    if (action.kind === 'primary') button.setAttribute('variant', 'primary');
    else if (action.kind === 'danger') button.setAttribute('variant', 'danger');
    else if (action.kind === 'ghost') button.setAttribute('outline', '');
    if (action.disabled) button.setAttribute('disabled', '');
    button.textContent = String(action.label === undefined ? '' : action.label);
    button.addEventListener('click', async () => {
      if (typeof action.onClick === 'function') {
        let result;
        try {
          result = await action.onClick(api, button);
        } catch (err) {
          return; // 由调用方决定怎么提示
        }
        if (result === false || action.close === false) return;
      }
      api.close();
    });
    footer.appendChild(button);
    api.buttons[String(action.label === undefined ? '' : action.label)] = button;
  }

  if (opts.closeOnEscape === false) {
    dialog.addEventListener('sl-request-close', (event) => {
      event.preventDefault();
    });
  }
  dialog.addEventListener('sl-after-hide', () => {
    closed = true;
    dialog.remove();
    if (typeof opts.onClose === 'function') {
      try { opts.onClose(); } catch (err) { /* 关闭回调异常不影响关闭 */ }
    }
  });

  document.body.appendChild(dialog);
  demoteDialogHeader(dialog);
  dialog.addEventListener('sl-after-show', () => demoteDialogHeader(dialog));
  const shown = typeof dialog.show === 'function' ? dialog.show() : Promise.resolve();
  Promise.resolve(shown).then(() => {
    if (typeof opts.onMount === 'function') {
      try { opts.onMount(api); } catch (err) { /* 忽略 */ }
    }
  }).catch(() => {});
  return api;
}

/** confirmDialog：确认框，返回 Promise<boolean>。 */
export function confirmDialog(msg, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const body = document.createElement('div');
    const text = document.createElement('p');
    text.className = 'nunt-dialog-text';
    text.textContent = String(msg === undefined || msg === null ? '' : msg);
    body.appendChild(text);
    if (opts.hint) {
      const hint = document.createElement('p');
      hint.className = 'nunt-dialog-hint';
      hint.textContent = String(opts.hint);
      body.appendChild(hint);
    }
    openDialog({
      title: opts.title || '请确认',
      body,
      width: '440px',
      onClose: () => finish(false),
      actions: [
        { label: opts.cancelLabel || '取消', onClick: () => { finish(false); } },
        { label: opts.okLabel || '确定', kind: opts.danger ? 'danger' : 'primary', onClick: () => { finish(true); } },
      ],
      onMount: (api) => {
        const target = opts.danger ? api.buttons[opts.cancelLabel || '取消'] : api.buttons[opts.okLabel || '确定'];
        if (target && typeof target.focus === 'function') target.focus();
      },
    });
  });
}

/** promptDialog：单行输入框，返回 Promise<string|null>。 */
export function promptDialog(msg, def, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const form = formGrid([
      {
        name: 'value',
        label: false,
        type: opts.type === 'password' ? 'password' : 'text',
        value: def === undefined || def === null ? '' : String(def),
        placeholder: opts.placeholder || '',
      },
    ]);
    const label = document.createElement('p');
    label.className = 'nunt-dialog-text';
    label.textContent = String(msg === undefined || msg === null ? '' : msg);
    const body = document.createElement('div');
    body.appendChild(label);
    body.appendChild(form.node);
    body.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      finish(form.read().value);
      const dialog = body.closest('sl-dialog');
      if (dialog) dialog.hide();
    });
    openDialog({
      title: opts.title || '输入',
      body,
      width: '440px',
      onClose: () => finish(null),
      actions: [
        { label: '取消', onClick: () => { finish(null); } },
        { label: opts.okLabel || '确定', kind: 'primary', onClick: () => { finish(form.read().value); } },
      ],
      onMount: () => {
        const input = form.node.querySelector(attrSelector('value'));
        if (input && typeof input.focus === 'function') input.focus();
      },
    });
  });
}

/* ------------------------------------------------------------------ 注册 */

define('nunt-empty', NuntEmpty);
define('nunt-loading', NuntLoading);
define('nunt-error', NuntError);
define('nunt-pager', NuntPager);
define('nunt-table', NuntTable);
define('nunt-tags', NuntTags);
define('nunt-kv', NuntKV);
define('nunt-form', NuntForm);

/* ------------------------------------------------------------------ 页面模板

最小示例（完整说明见 docs/CONTRACT.md 第 7 节）：

    import { NuntElement, html, nothing, define, formGrid, openDialog, toast, confirmDialog } from '../lib/kit.js';

    class DemoPage extends NuntElement {
      static properties = { rows: { attribute: false }, loading: { type: Boolean } };
      constructor() { super(); this.rows = []; this.loading = true; }
      async connectedCallback() {
        super.connectedCallback();
        await this.load();
      }
      async load() {
        this.loading = true;
        try { this.rows = (await this.ctx.api.get('/api/v1/demo')) || []; this.error = null; }
        catch (err) { this.error = err; }
        finally { this.loading = false; }
      }
      render() {
        return html`<nunt-table .columns=${[{ key: 'name', title: '名称' }]} .rows=${this.rows}
          .loading=${this.loading} .error=${this.error} .onRetry=${() => this.load()}></nunt-table>`;
      }
    }
    define('nunt-page-demo', DemoPage);

    export default {
      id: 'demo',
      title: '示例',
      icon: '<svg viewBox="0 0 24 24" ...></svg>',
      async mount(root, ctx) {
        const page = document.createElement('nunt-page-demo');
        page.ctx = ctx;
        root.appendChild(page);
        return () => page.remove();
      },
    };

导出清单：
  工具      versionText / infoVersionText / errorMessage / friendlyMessage / toneVariant / toneIcon
            badge / iconEl / fmtBytes / fmtTime / fmtDuration / escapeHtml
  Lit       html / nothing / repeat / ifDefined / classMap / NuntElement / define / renderInto
  表格      NuntTable（nunt-table）/ table(config) / applyTableConfig(node, config)
  表单      NuntForm（nunt-form）/ formGrid(fields) / NuntTags（nunt-tags）/ NuntKV（nunt-kv）
  状态      NuntEmpty（nunt-empty）/ NuntLoading（nunt-loading）/ NuntError（nunt-error）
            emptyState() / loadingState() / errorCard() / NuntPager（nunt-pager）
  交互      toast() / confirmDialog() / promptDialog() / openDialog()
*/
