// nunt 前端页面模块：task.js
// 依赖 lib/ui.js 的导出，同时每个文件内置本地兜底实现（类名与 style.css 对齐），
// 因此 lib/ui.js 尚未完成时页面也不会白屏。

// ---------------------------------------------------------------------------
// 页面本地基础工具（自包含，无构建步骤）
//
// 优先使用 lib/ui.js 的导出；lib/ui.js 尚未就绪时退回到本地实现，并把本地
// 实现产生的 DOM 对齐 style.css 的类名（.card/.btn/.table/...），因此两种
// 情况下页面的外观保持一致。导入名与本项目前端契约一致。
// ---------------------------------------------------------------------------
import {
  el as libEl,
  toast as libToast,
  confirmDialog as libConfirm,
  openModal as libOpenModal,
  fmtBytes as libFmtBytes,
  fmtTime as libFmtTime,
  escapeHtml as libEscapeHtml,
  renderTable as libRenderTable,
} from '../lib/ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const TXT = (s) => (s === null || s === undefined ? '' : String(s));

function attach(parent, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    if (Array.isArray(kid)) { attach(parent, kid); continue; }
    if (typeof kid === 'object' && kid.nodeType) { parent.appendChild(kid); continue; }
    parent.appendChild(document.createTextNode(String(kid)));
  }
}

function makeEl(tag, attrs, kids, ns) {
  const node = ns ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !attrs.nodeType && !Array.isArray(attrs)) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') node.setAttribute('class', TXT(value));
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
      else if (key === 'text') node.textContent = TXT(value);
      else if (key === 'value') node.value = TXT(value);
      else if (key === 'checked') node.checked = !!value;
      else if (key === 'disabled') node.disabled = !!value;
      else if (key === 'selected') node.selected = !!value;
      else if (/^on[a-z]+$/.test(key) && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : TXT(value));
    }
  } else if (attrs !== null && attrs !== undefined && typeof attrs !== 'object') {
    kids = [attrs].concat(kids || []);
  }
  attach(node, kids || []);
  return node;
}

function el(tag, attrs, ...kids) {
  if (typeof tag === 'string' && /^[a-zA-Z]+$/.test(tag)) return makeEl(tag, attrs, kids, false);
  return makeEl('span', null, [tag].concat(kids || []), false);
}

const h = libEl || el;

/* ------------------------------------------------------------------ 提示 */

function toast(msg, type) {
  if (libToast) { try { libToast(TXT(msg), type || 'info'); return; } catch (err) { /* 回退 */ } }
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const kind = (type === 'ok' || type === 'warn' || type === 'err' || type === 'info') ? type : 'info';
  const node = el('div', { class: 'toast ' + kind, text: TXT(msg) });
  host.appendChild(node);
  setTimeout(() => node.remove(), kind === 'err' ? 6000 : 3200);
}

/* ------------------------------------------------------------------ 弹窗 */

function modal(options) {
  const opts = options || {};
  const bodyNode = el('div', { class: 'modal-body' });
  if (opts.body && opts.body.nodeType) bodyNode.appendChild(opts.body);
  else if (opts.body !== undefined && opts.body !== null) bodyNode.textContent = TXT(opts.body);

  const footerNode = el('div', { class: 'modal-footer' });
  const card = el('div', { class: 'modal-card' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  const titleId = 'page-modal-' + Math.random().toString(36).slice(2, 8);
  card.setAttribute('aria-labelledby', titleId);

  const closeBtn = el('button', {
    class: 'icon-btn', type: 'button', title: '关闭', 'aria-label': '关闭',
    text: String.fromCharCode(10005),
    onclick: () => close(),
  });
  const header = el('div', { class: 'modal-header' }, el('span', { id: titleId, text: TXT(opts.title) }), el('span', { class: 'spacer' }), closeBtn);
  const root = el('div', { class: 'modal' }, card);
  card.appendChild(header);
  card.appendChild(bodyNode);
  if (opts.actions && opts.actions.length) card.appendChild(footerNode);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    if (!document.querySelector('.modal')) document.body.classList.remove('modal-open');
    if (typeof opts.onClose === 'function') { try { opts.onClose(); } catch (err) { /* 忽略 */ } }
  }
  function onKey(event) { if (event.key === 'Escape' && opts.onEscape !== false) close(); }

  const api = { root, card, body: bodyNode, footer: footerNode, buttons: {}, close, setBusy() {} };
  for (const action of opts.actions || []) {
    if (!action) continue;
    const kind = action.kind === 'primary' ? 'btn btn-primary'
      : action.kind === 'danger' ? 'btn btn-danger'
        : action.kind === 'ghost' ? 'btn btn-ghost' : 'btn';
    const node = el('button', { class: kind, type: 'button', disabled: !!action.disabled, text: TXT(action.label) });
    node.addEventListener('click', async () => {
      if (typeof action.onClick !== 'function') { close(); return; }
      let result;
      try { result = await action.onClick(api); } catch (err) { return; }
      if (result !== false && action.close !== false) close();
    });
    footerNode.appendChild(node);
    api.buttons[TXT(action.label)] = node;
  }
  if (opts.maskClose !== false) root.addEventListener('mousedown', (event) => { if (event.target === root) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.classList.add('modal-open');
  document.body.appendChild(root);
  return api;
}

function openModal(options) {
  if (libOpenModal) { try { return libOpenModal(options); } catch (err) { /* 回退 */ } }
  return modal(options);
}

function confirmDialog(msg, options) {
  if (libConfirm) {
    try {
      const p = libConfirm(TXT(msg), options);
      if (p && typeof p.then === 'function') return p;
      return Promise.resolve(!!p);
    } catch (err) { /* 回退 */ }
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    modal({
      title: '请确认',
      body: el('div', null, el('p', { style: { margin: '0' }, text: TXT(msg) })),
      onClose: () => finish(false),
      actions: [
        { label: '取消', onClick: () => finish(false) },
        { label: '确定', kind: 'primary', onClick: () => finish(true) },
      ],
    });
  });
}

/* ------------------------------------------------------------------ 格式化 */

function fmtBytes(n) {
  if (libFmtBytes) { try { return libFmtBytes(n); } catch (err) { /* 回退 */ } }
  if (n === null || n === undefined || n === '') return '-';
  const num = Number(n);
  if (!isFinite(num)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.abs(num);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  const text = i === 0 ? String(Math.round(value)) : (value >= 100 ? value.toFixed(0) : value.toFixed(1));
  return (num < 0 ? '-' : '') + text + ' ' + units[i];
}

function fmtTime(t) {
  if (libFmtTime) { try { return libFmtTime(t); } catch (err) { /* 回退 */ } }
  if (t === null || t === undefined || t === '') return '-';
  let date;
  if (t instanceof Date) date = t;
  else if (typeof t === 'number') date = new Date(t < 1e12 ? t * 1000 : t);
  else {
    date = new Date(String(t));
    if (isNaN(date.getTime())) {
      const num = Number(String(t));
      if (!isNaN(num) && String(t).trim() !== '') date = new Date(num < 1e12 ? num * 1000 : num);
    }
  }
  if (!date || isNaN(date.getTime())) return TXT(t);
  const p = (x) => (x < 10 ? '0' + x : String(x));
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) + ' ' + p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds());
}

function dateAgo(t) {
  if (!t) return '-';
  const date = (t instanceof Date) ? t : new Date(String(t));
  if (isNaN(date.getTime())) return TXT(t);
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 0) return fmtTime(t);
  if (secs < 60) return secs + ' 秒前';
  if (secs < 3600) return Math.floor(secs / 60) + ' 分钟前';
  if (secs < 86400) return Math.floor(secs / 3600) + ' 小时前';
  return Math.floor(secs / 86400) + ' 天前';
}

function escapeHtml(s) {
  if (libEscapeHtml) { try { return libEscapeHtml(s); } catch (err) { /* 回退 */ } }
  return TXT(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function textOf(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback === undefined ? '-' : fallback;
  if (Array.isArray(v)) {
    const parts = v.filter((x) => x !== null && x !== undefined && String(x) !== '');
    return parts.length ? parts.map((x) => String(x)).join(', ') : (fallback === undefined ? '-' : fallback);
  }
  return String(v);
}

/* ------------------------------------------------------------------ 组件 */

function clear(node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); return node; }

function spinner(label) {
  return el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', { text: label || '加载中…' }));
}

function emptyBox(msg) {
  return el('div', { class: 'empty' }, el('div', { class: 'empty-title', text: msg || '暂无数据' }));
}

function errorCard(err, onRetry) {
  const msg = (err && err.message) ? err.message : TXT(err || '未知错误');
  const notice = el('div', { class: 'notice' },
    el('div', { style: { fontWeight: '600' }, text: '接口调用失败' }),
    el('div', { text: msg }),
    el('div', { style: { opacity: '.85', marginTop: '4px' }, text: '该功能可能尚未实现，或后台服务异常；可稍后重试。' }),
  );
  if (onRetry) {
    notice.appendChild(el('div', { style: { marginTop: '8px' } }, el('button', { class: 'btn btn-sm', type: 'button', text: '重试', onclick: () => onRetry() })));
  }
  return notice;
}

function btn(label, opts) {
  const o = opts || {};
  const kind = o.kind === 'primary' ? ' btn-primary' : (o.kind === 'danger' ? ' btn-danger' : (o.kind === 'ghost' ? ' btn-ghost' : ''));
  const node = el('button', {
    class: 'btn' + kind + (o.small ? ' btn-sm' : ''),
    type: 'button',
    title: o.title || '',
    disabled: !!o.disabled,
    onclick: o.onClick,
  }, o.icon || null, el('span', { text: TXT(label) }));
  if (o.tag) node.dataset.tag = o.tag;
  return node;
}

function iconBtn(icon, opts) {
  const o = opts || {};
  const node = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: o.title || '',
    'aria-label': o.title || '',
    onclick: o.onClick,
  }, icon || null);
  if (o.tag) node.dataset.tag = o.tag;
  return node;
}

function svgIcon(paths) {
  return makeEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', width: '16', height: '16' },
    paths.map((d) => makeEl('path', { d: d }, [], true)), true);
}

function editIcon() { return svgIcon(['M4 20h4l10-10-4-4L4 16v4z', 'M14 6l4 4']); }
function trashIcon() { return svgIcon(['M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13']); }
function logIcon() { return svgIcon(['M4 5h16v14H4z', 'M7 9h10M7 13h7']); }
function runIcon() { return svgIcon(['M7 5l12 7-12 7z']); }

function switchEl(on, onToggle) {
  const box = el('input', { type: 'checkbox' });
  box.checked = !!on;
  const textNode = el('span', { text: on ? '已启用' : '已停用' });
  const label = el('label', { class: 'switch', title: on ? '点击停用' : '点击启用' }, box, el('span', { class: 'track' }), textNode);
  label.dataset.tag = 'toggle';
  let busy = false;
  const state = { on: !!on, set(next) { busy = false; state.on = !!next; box.checked = state.on; textNode.textContent = state.on ? '已启用' : '已停用'; } };
  label.addEventListener('click', (event) => event.stopPropagation());
  box.addEventListener('change', () => {
    if (busy) return;
    busy = true;
    label.dataset.busy = '1';
    const next = box.checked;
    Promise.resolve(onToggle ? onToggle({ target: label, value: next }) : next)
      .then((result) => { busy = false; delete label.dataset.busy; if (result === false) state.set(!next); })
      .catch(() => { busy = false; delete label.dataset.busy; state.set(!next); });
  });
  return label;
}

function chip(txt) { return el('span', { class: 'chip', text: TXT(txt) }); }

function chips(list, max) {
  const arr = (list || []).filter((x) => x !== null && x !== undefined && String(x) !== '');
  if (!arr.length) return el('span', { class: 'muted', text: '-' });
  const box = el('span', { class: 'row' });
  const limit = max || 3;
  for (const item of arr.slice(0, limit)) box.appendChild(chip(item));
  if (arr.length > limit) box.appendChild(el('span', { class: 'faint', style: { fontSize: '12px' }, text: '+' + (arr.length - limit) }));
  return box;
}

function badge(txt, kind) {
  const k = (kind === 'ok' || kind === 'warn' || kind === 'err') ? ' ' + kind : '';
  return el('span', { class: 'badge' + k, text: TXT(txt) });
}

function bar(pct, kind) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const k = (kind === 'warn' || kind === 'err') ? ' ' + kind : '';
  return el('span', { class: 'bar' + k, style: { flex: '1 1 auto', minWidth: '70px' }, title: Math.round(p) + '%' },
    el('i', { style: { width: p + '%' } }));
}

function card(title, headExtra, body) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', { text: TXT(title) }), el('span', { class: 'spacer' }), headExtra || null),
    el('div', { class: 'card-body' }, body || null),
  );
}

function tableEl(cols, rows, empty) {
  const list = rows || [];
  if (!list.length) return emptyBox(empty || '暂无数据');
  const thead = el('thead', null, el('tr', null, (cols || []).map((c) => el('th', { text: c.title, style: c.align === 'right' ? { textAlign: 'right' } : null }))));
  const tbody = el('tbody', null, list.map((row) => el('tr',
    { class: row.onClick ? 'clickable' : null, dataset: row.tag ? { row: row.tag } : null, onclick: row.onClick || null },
    (cols || []).map((c) => {
      // 行包装对象 {raw, tag, onClick}：渲染函数始终拿到真实数据对象。
      const data = (row && row.raw !== undefined) ? row.raw : row;
      const value = c.render ? c.render(data) : (data ? data[c.key] : '');
      const cell = el('td', { class: c.cls || null });
      attach(cell, [value === null || value === undefined ? '-' : value]);
      return cell;
    }),
  )));
  return el('table', { class: 'table' }, thead, tbody);
}

/**
 * renderTable 渲染表格。
 * 优先使用 lib/ui.js 的 renderTable(container, config)；不可用时按同样的配置
 * 形状在本地渲染（columns[{title,key,render,align,cls}] + rows[{tag,onClick,raw}]）。
 * 返回承载表格的容器元素。
 */
// dataTable 是本地表格渲染函数（renderTable 的兜底实现）。
const dataTable = tableEl;

function renderTable(container, config) {
  const cfg = config || {};
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return null;
  const cols = cfg.columns || [];
  const rows = cfg.rows || [];
  if (libRenderTable) {
    try {
      libRenderTable(host, cfg);
      const box = el('div', { class: 'page-table' });
      while (host.firstChild) box.appendChild(host.firstChild);
      host.appendChild(box);
      return box;
    } catch (err) { clear(host); }
  }
  clear(host);
  host.appendChild(tableEl(cols, rows, cfg.empty));
  return host;
}

function field(label, control, hint, wide) {
  const node = el('div', { class: 'field' + (wide ? ' wide' : '') });
  if (wide) node.style.gridColumn = '1 / -1';
  if (label) node.appendChild(el('label', { text: TXT(label) }));
  node.appendChild(control);
  if (hint) node.appendChild(el('div', { class: 'hint', text: TXT(hint) }));
  return node;
}

function fieldSet(legend, kids) {
  const box = el('div', { class: 'stack', style: { margin: '14px 0' } });
  if (legend) box.appendChild(el('div', { class: 'muted', style: { fontSize: '12px', fontWeight: '600' }, text: TXT(legend) }));
  const grid = el('div', { class: 'grid' });
  attach(grid, kids || []);
  box.appendChild(grid);
  return box;
}

function input(attrs) { return el('input', Object.assign({ class: 'input', type: 'text' }, attrs || {})); }
function textarea(attrs) { return el('textarea', Object.assign({ class: 'input', rows: '4' }, attrs || {})); }

function selectEl(items, value, attrs) {
  const node = el('select', Object.assign({ class: 'select' }, attrs || {}));
  for (const item of (items || [])) {
    const o = (typeof item === 'string') ? { value: item, label: item } : item;
    node.appendChild(el('option', { value: TXT(o.value), text: TXT(o.label) }));
  }
  node.value = (value === undefined || value === null) ? '' : String(value);
  if (node.selectedIndex < 0 && node.options.length) node.selectedIndex = 0;
  return node;
}

function checkEl(label, isChecked, attrs) {
  const box = el('input', Object.assign({ type: 'checkbox' }, attrs || {}));
  box.checked = !!isChecked;
  return el('label', { class: 'check' }, box, el('span', { text: TXT(label) }));
}

function tabs(names, active, onPick) {
  const box = el('div', { class: 'tabs', style: { borderBottom: '0', marginBottom: '0' } });
  for (const item of names) {
    const n = (typeof item === 'string') ? { id: item, label: item } : item;
    box.appendChild(el('button', {
      class: 'tab' + (String(n.id) === String(active) ? ' active' : ''),
      type: 'button',
      text: TXT(n.label),
      onclick: () => onPick(n.id),
    }));
  }
  return box;
}

function kv(pairs) {
  const box = el('div', { class: 'kv' });
  for (const pair of (pairs || [])) {
    box.appendChild(el('span', { class: 'k', text: TXT(pair[0]) }));
    const cell = el('span', { class: 'v' });
    attach(cell, [pair[1] === null || pair[1] === undefined ? '-' : pair[1]]);
    box.appendChild(cell);
  }
  return box;
}

function logView(lines, max) {
  const arr = (lines || []).slice(-1 * (max || 300));
  if (!arr.length) return emptyBox('暂无日志');
  return el('div', { class: 'log-view', style: { minHeight: '140px' } }, arr.map((line) => el('div', { class: 'log-line' },
    el('span', { class: 'msg', text: typeof line === 'string' ? line : JSON.stringify(line) }))));
}

/* ------------------------------------------------------------------ 表单取值 */

function val(node) { return node && node.value !== undefined ? String(node.value).trim() : ''; }
function lines(node) { return val(node).split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length > 0); }

function keyValues(node) {
  const out = {};
  for (const raw of val(node).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function kvText(map) {
  const src = map || {};
  return Object.keys(src).map((k) => k + ': ' + src[k]).join('\n');
}

function numOf(node, dflt) {
  const text = val(node);
  const n = Number(text);
  return (text !== '' && isFinite(n)) ? n : (dflt === undefined ? 0 : dflt);
}
function checked(node) { return !!(node && node.checked); }

/* ------------------------------------------------------------------ API */

function currentToken() {
  const w = typeof window !== 'undefined' ? window : {};
  const boot = w.__NUNT__ || w.__DSH_BOOT__ || null;
  if (boot && typeof boot === 'object' && boot.csrf) return boot.csrf;
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta && meta.content) return meta.content;
  const jar = (typeof document !== 'undefined' && document.cookie) ? document.cookie : '';
  const m = jar.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function fetchJSON(method, path, payload, timeoutMs) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 20000) : null;
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': currentToken() },
      body: (payload === undefined || payload === null) ? undefined : JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (err) { data = text; } }
    if (!res.ok) {
      let msg = '';
      if (data && typeof data === 'object') {
        if (data.error && data.error.message) msg = data.error.message;
        else if (data.message) msg = data.message;
      }
      if (!msg && typeof data === 'string' && data) msg = data.slice(0, 180);
      if (!msg && res.status === 404) msg = '接口不存在（404），该功能可能尚未实现';
      if (!msg) msg = '请求失败（HTTP ' + res.status + '）';
      const err = new Error(msg);
      err.status = res.status;
      err.notFound = res.status === 404;
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') { const err = new Error('请求超时（服务器无响应）'); err.timeout = true; throw err; }
    if (e instanceof Error) throw e;
    throw new Error(String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapAPI(raw) {
  const base = '/api/v1';
  const qs = (params) => {
    if (!params) return '';
    const sp = new URLSearchParams();
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value === undefined || value === null || value === '') continue;
      sp.append(key, String(value));
    }
    const text = sp.toString();
    return text ? '?' + text : '';
  };
  const call = (name, method, path, body, isQuery) => {
    const fn = (raw && typeof raw[name] === 'function') ? raw[name].bind(raw) : null;
    const full = base + path;
    if (!fn) return fetchJSON(method, full + qs(isQuery ? body : null), isQuery ? undefined : body);
    return Promise.resolve().then(() => (isQuery ? fn(full, body) : fn(full, body))).catch((err) => {
      const retryable = err && (err.notFound === true || err.status === 404 || err.status >= 500 || err.name === 'TypeError');
      if (!retryable) throw err;
      return fetchJSON(method, full + qs(isQuery ? body : null), isQuery ? undefined : body);
    });
  };
  return {
    get: (p, params) => call('get', 'GET', p, params, true),
    post: (p, b) => call('post', 'POST', p, b, false),
    put: (p, b) => call('put', 'PUT', p, b, false),
    del: (p, b) => call('del', 'DELETE', p, b, false),
    raw,
  };
}

/* ------------------------------------------------------------------ 数据 */

function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

function debounce(fn, wait) {
  let timer = null;
  return function () {
    const args = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(null, args); }, wait || 220);
  };
}

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

function apiErr(e) { return (e && e.message) ? e.message : TXT(e || '未知错误'); }
function notFoundHint(e) { return !!(e && (e.notFound === true || e.status === 404)); }

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

// --- DNS 提供商元数据（DDNS 与证书页共用） ---------------------------------
let dnsProviderCache = null;
let dnsProviderFinal = false;
let dnsProviderInflight = null;

// fallbackProviderFields 在 /api/v1/ddns/providers 不可用时提供已知提供商的
// 凭据输入，保证表单仍然可用。
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

// loadDNSProviders 带缓存：404 视为该接口不存在并记住，其它失败下次重试。
async function loadDNSProviders() {
  if (dnsProviderCache && dnsProviderCache.length) return dnsProviderCache;
  if (dnsProviderFinal) return dnsProviderCache || [];
  if (dnsProviderInflight) return dnsProviderInflight;
  dnsProviderInflight = (async () => {
    try {
      const data = await api.get('/ddns/providers');
      const list = normalizeProviders(data);
      dnsProviderCache = list;
      dnsProviderFinal = true;
      return list;
    } catch (e) {
      if (e && (e.notFound === true || e.status === 404)) { dnsProviderFinal = true; dnsProviderCache = []; return []; }
      return [];
    } finally {
      dnsProviderInflight = null;
    }
  })();
  return dnsProviderInflight;
}

// 页面模块只导出 default；下面的名字供页面内部使用，不再二次导出（避免与
// lib/ui.js 的语义混淆）。
const LF = String.fromCharCode(10);

// ---------------------------------------------------------------------------
// 计划任务：cron 调度 + 动作列表
// ---------------------------------------------------------------------------
const ACTION_LABEL = {
  'module.toggle': '模块开关',
  'rule.toggle': '规则开关',
  'http.request': 'HTTP 请求',
  'notify.webhook': '发送通知',
  'shell.exec': '执行 Shell',
};
const NOTIFY_EVENTS = [
  'ddns.updated', 'ddns.failed', 'acme.issued', 'acme.failed',
  'waf.blocked', 'forward.error', 'web.error', 'cert.expiring', 'task.failed',
];
const CRON_EXAMPLES = [
  { expr: '*/5 * * * *', label: '每 5 分钟' },
  { expr: '0 * * * *', label: '每小时' },
  { expr: '30 3 * * *', label: '每天 03:30' },
  { expr: '0 4 * * 0', label: '每周日 04:00' },
  { expr: '0 0 1 * *', label: '每月 1 日 00:00' },
  { expr: '@every 30m', label: '每 30 分钟' },
  { expr: '@daily', label: '每天（快捷）' },
];
const PAGE_CSS = [
  '.ptask-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.ptask-search{width:180px}',
  '.ptask-ex{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}',
  '.ptask-act{display:grid;grid-template-columns:150px 1fr auto;gap:8px;align-items:start;border:1px solid var(--border,#2a2f3a);border-radius:8px;padding:8px;margin-bottom:8px}',
  '@media (max-width:760px){.ptask-act{grid-template-columns:1fr}}',
  '.ptask-actbody{display:flex;flex-direction:column;gap:6px;min-width:0}',
  '.ptask-cron{font-family:ui-monospace,Consolas,monospace}',
].join(String.fromCharCode(10));

function cronHintBox(cronInput) {
  const box = el('div', { class: 'ptask-ex' });
  for (const ex of CRON_EXAMPLES) {
    box.appendChild(el('button', {
      class: 'btn btn-sm', type: 'button', text: ex.label, title: ex.expr,
      onclick: () => { cronInput.value = ex.expr; toast('已填入：' + ex.expr, 'ok'); },
    }));
  }
  return box;
}

function actionRow(action, actions) {
  const a = action || { type: 'module.toggle' };
  const row = el('div', { class: 'ptask-act' });
  const typeSel = selectEl(Object.keys(ACTION_LABEL).map((k) => ({ value: k, label: ACTION_LABEL[k] })), a.type || 'module.toggle');
  const bodyBox = el('div', { class: 'ptask-actbody' });
  const removeBtn = btn('删除', { small: true, kind: 'danger', onClick: () => { const i = actions.indexOf(ctrl); if (i >= 0) actions.splice(i, 1); if (row.parentNode) row.parentNode.removeChild(row); } });
  const ctrl = { node: row, collect: () => null, type: a.type };

  function paint() {
    clear(bodyBox);
    const t = val(typeSel);
    ctrl.type = t;
    if (t === 'module.toggle') {
      const target = input({ value: a.target || '', placeholder: '模块名，例如 web / ddns / waf / forward' });
      const value = selectEl([{ value: 'on', label: '启动' }, { value: 'off', label: '停止' }, { value: 'restart', label: '重启' }], a.value || 'restart');
      bodyBox.appendChild(el('div', { class: 'grid two' }, field('模块名', target), field('动作', value)));
      ctrl.collect = () => ({ type: t, target: val(target), value: val(value) });
    } else if (t === 'rule.toggle') {
      const target = input({ value: a.target || '', placeholder: '模块/规则类型，例如 forward 或 web' });
      const value = input({ value: a.value || '', placeholder: '规则 ID' });
      const extra = selectEl([{ value: 'on', label: '启用规则' }, { value: 'off', label: '停用规则' }], 'on');
      bodyBox.appendChild(el('div', { class: 'grid two' }, field('模块', target), field('规则 ID', value), field('动作', extra)));
      ctrl.collect = () => ({ type: t, target: val(target), value: val(value), url: val(extra) });
    } else if (t === 'http.request') {
      const method = selectEl(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map((m) => ({ value: m, label: m })), (a.method || 'GET').toUpperCase());
      const url = input({ value: a.url || '', placeholder: 'https://example.com/hook' });
      const headers = textarea({ rows: '2', placeholder: '每行一条 key: value', value: kvText(a.headers) });
      const body = textarea({ rows: '2', placeholder: '请求体（可选）', value: a.body || '' });
      bodyBox.appendChild(el('div', { class: 'grid two' }, field('方法', method), field('URL', url, '', true)));
      bodyBox.appendChild(field('请求头', headers, '', true));
      bodyBox.appendChild(field('请求体', body, '', true));
      ctrl.collect = () => ({ type: t, method: val(method) || 'GET', url: val(url), headers: keyValues(headers), body: val(body) });
    } else if (t === 'notify.webhook') {
      const target = input({ value: a.target || '', placeholder: 'webhook ID（留空表示全部通知渠道）' });
      const events = textarea({ rows: '2', placeholder: '每行一个事件名，留空表示全部', value: (a.headers && a.headers.__events ? [] : []).join(LF) });
      const value = input({ value: a.value || '', placeholder: '通知内容，支持变量（可选）' });
      const sel = selectEl([{ value: '', label: '（不指定事件）' }].concat(NOTIFY_EVENTS.map((e) => ({ value: e, label: e }))), '');
      bodyBox.appendChild(el('div', { class: 'grid two' }, field('webhook ID', target, '对应“通知”页面里的 webhook'), field('事件', sel)));
      bodyBox.appendChild(field('通知内容', value, '留空使用默认文案', true));
      ctrl.collect = () => ({ type: t, target: val(target), headers: val(sel) ? { __events: val(sel) } : undefined, value: val(value) });
    } else {
      const command = textarea({ rows: '2', placeholder: '需要后台显式开启 shell 才能执行', value: a.command || '' });
      bodyBox.appendChild(field('命令', command, '禁止拼接未校验的用户输入', true));
      ctrl.collect = () => ({ type: t, command: val(command) });
    }
  }

  typeSel.addEventListener('change', () => { a.type = val(typeSel); paint(); });
  row.appendChild(typeSel);
  row.appendChild(bodyBox);
  row.appendChild(removeBtn);
  paint();
  return ctrl;
}

function openTaskForm(task, ctx, reload) {
  const base = task || {};
  const editing = !!base.id;
  const name = input({ value: base.name || '', placeholder: '例如 每天检查证书' });
  const enable = checkEl('启用该任务', base.enable !== false);
  const cron = input({ class: 'input ptask-cron', value: base.cron || '', placeholder: '*/5 * * * *' });
  const remark = input({ value: base.remark || '', placeholder: '备注（可选）' });
  const actions = [];
  const listBox = el('div', {});
  for (const a of (base.actions || [])) actions.push(actionRow(a, actions));

  function addAction() {
    actions.push(actionRow({ type: 'module.toggle' }, actions));
    clear(listBox);
    for (const ctrl of actions) listBox.appendChild(ctrl.node);
  }
  function repaint() {
    clear(listBox);
    for (const ctrl of actions) listBox.appendChild(ctrl.node);
  }
  repaint();

  openModal({
    title: editing ? '编辑计划任务' : '新建计划任务',
    body: el('div', {},
      el('div', { class: 'notice', text: 'Cron 为 5 段式（分 时 日 月 周），也支持 @every 30m / @daily 这类快捷写法。动作按顺序执行，任一动作失败会记录到运行结果中。' }),
      fieldSet('任务', [
        field('名称', name),
        field('启用', enable),
        field('Cron 表达式', el('div', {}, cron, cronHintBox(cron))),
        field('备注', remark, '', true),
      ]),
      el('fieldset', { class: 'sect' },
        el('legend', { text: '动作列表' }),
        listBox,
        el('button', { class: 'btn', type: 'button', text: '添加动作', onclick: () => addAction() }),
      ),
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          if (!val(name)) { toast('请填写任务名称', 'warn'); return false; }
          if (!val(cron)) { toast('请填写 Cron 表达式', 'warn'); return false; }
          const list = [];
          for (const ctrl of actions) {
            const item = ctrl.collect();
            if (item) list.push(item);
          }
          if (!list.length) { toast('请至少添加一个动作', 'warn'); return false; }
          const payload = { name: val(name), enable: checked(enable), cron: val(cron), remark: val(remark), actions: list };
          try {
            if (editing) await api.put('/task/items/' + encodeURIComponent(base.id), payload);
            else await api.post('/task/items', payload);
            toast('保存成功', 'ok');
            reload();
          } catch (e) {
            toast('保存失败：' + apiErr(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

export default {
  id: 'task',
  title: '计划任务',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    const state = { q: '', items: [] };
    const bodyBox = el('div', {});

    function lastRun(t) {
      return t.lastRun || t.lastTime || t.lastExecutedAt || (t.state && t.state.lastRun) || null;
    }
    function lastResult(t) {
      const s = t.state || t;
      return s.lastResult || s.lastMessage || s.message || s.lastError || (s.lastOK === true ? '成功' : (s.lastOK === false ? '失败' : ''));
    }

    async function toggle(item, next) {
    const want = (next === undefined) ? !item.enable : !!next;
      try {
        await api.post('/task/items/' + encodeURIComponent(item.id) + '/toggle');
      } catch (e) {
        try {
          await api.put('/task/items/' + encodeURIComponent(item.id), Object.assign({}, item, { enable: want }));
        } catch (e2) {
          toast('切换失败：' + apiErr(e2), 'error');
          return false;
        }
      }
      toast(want ? '已启用' : '已停用', 'ok');
      load();
    }

    async function remove(item) {
      const ok = await confirmDialog('确定删除计划任务「' + (item.name || item.id) + '」吗？');
      if (!ok) return;
      try {
        await api.del('/task/items/' + encodeURIComponent(item.id));
        toast('已删除', 'ok');
        load();
      } catch (e) {
        toast('删除失败：' + apiErr(e), 'error');
      }
    }

    async function runNow(item) {
      toast('正在执行「' + (item.name || item.id) + '」…', 'info');
      try {
        const res = await api.post('/task/items/' + encodeURIComponent(item.id) + '/run');
        const data = res || {};
        const msg = data.message || data.result || (data.ok === false ? '执行失败' : '执行完成');
        toast((data.ok === false ? '执行失败：' : '执行完成：') + msg, data.ok === false ? 'error' : 'ok');
        load();
      } catch (e) {
        toast('执行失败：' + apiErr(e), 'error');
      }
    }

    const columns = [
      { title: '名称', render: (t) => el('div', {}, el('div', { text: t.name || t.id }), t.remark ? el('div', { class: 'muted', style: 'font-size:11px', text: t.remark }) : null) },
      { title: 'Cron', render: (t) => el('span', { class: 'mono', text: t.cron || '-' }) },
      { title: '动作', render: (t) => {
        const list = t.actions || [];
        if (!list.length) return el('span', { class: 'muted', text: '-' });
        return el('span', {}, chips(list.map((a) => ACTION_LABEL[a.type] || a.type), 3));
      } },
      { title: '上次运行', render: (t) => el('div', {}, el('div', { text: fmtTime(lastRun(t)) }), el('div', { class: 'muted', style: 'font-size:11px', text: lastRun(t) ? dateAgo(lastRun(t)) : '' })) },
      { title: '下次运行', render: (t) => el('span', { class: 'muted', text: fmtTime(t.nextRun || (t.state && t.state.nextRun)) }) },
      { title: '运行结果', render: (t) => {
        const r = lastResult(t);
        if (!r) return el('span', { class: 'muted', text: '尚未运行' });
        const bad = /失败|error|fail/i.test(String(r));
        return badge(String(r).slice(0, 40), bad ? 'err' : 'ok');
      } },
      { title: '状态', render: (t) => switchEl(!!t.enable, (next) => toggle(t, next)) },
      { title: '', cls: 'acts', render: (t) => el('span', {},
        iconBtn(runIcon(), { title: '立即运行', tag: 'run', onClick: () => runNow(t) }),
        iconBtn(editIcon(), { title: '编辑', tag: 'edit', onClick: () => openTaskForm(t, ctx, load) }),
        iconBtn(trashIcon(), { title: '删除', tag: 'remove', onClick: () => remove(t) }),
      ) },
    ];

    function filtered() {
      const q = state.q.trim().toLowerCase();
      if (!q) return state.items;
      return state.items.filter((t) => [t.name, t.cron, (t.actions || []).map((a) => a.type + ' ' + (a.target || '')).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0);
    }

    function paint() {
      clear(bodyBox);
      const rows = filtered().map((t) => ({ raw: t, tag: t.id }));
      if (!rows.length) {
        bodyBox.appendChild(emptyBox(state.items.length ? '没有符合条件的任务' : '还没有计划任务，点击右上角“新建任务”开始'));
        return;
      }
      bodyBox.appendChild(dataTable(columns, rows, '暂无任务'));
    }

    async function load() {
      clear(bodyBox);
      bodyBox.appendChild(spinner('正在加载计划任务…'));
      try {
        const data = await api.get('/task/items');
        state.items = unwrap(data, ['items', 'tasks', 'list']);
      } catch (e) {
        clear(bodyBox);
        bodyBox.appendChild(errorCard(e, () => load()));
        return;
      }
      paint();
    }

    const search = input({ class: 'input ptask-search', placeholder: '搜索名称/Cron' });
    search.addEventListener('input', debounce(() => { state.q = search.value; paint(); }, 200));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '计划任务' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: 'shell 动作需要在服务端配置中显式开启' }),
        search,
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => load() }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '新建任务', onclick: () => openTaskForm(null, ctx, load) }),
      ),
      el('div', { class: 'card-body' }, bodyBox),
    ));

    load();
    return () => { offStyle(); };
  },
};