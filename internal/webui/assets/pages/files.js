// nunt 前端页面模块：files.js
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
  if (typeof tag === 'string' && /^[a-zA-Z][a-zA-Z0-9]*$/.test(tag)) return makeEl(tag, attrs, kids, false);
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
// 文件管理：浏览存储挂载点 + 分享链接
// ---------------------------------------------------------------------------
const PAGE_CSS = [
  '.pfiles-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pfiles-crumb{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:13px}',
  '.pfiles-crumb button{background:none;border:0;color:var(--accent,#4a9eff);cursor:pointer;font:inherit;font-size:13px;padding:1px 3px;border-radius:4px}',
  '.pfiles-crumb button:hover{background:rgba(127,127,127,.16)}',
  '.pfiles-crumb .pfiles-sep{color:var(--muted,#98a2b3)}',
  '.pfiles-name{cursor:pointer}',
  '.pfiles-dir{color:var(--accent,#4a9eff)}',
  '.pfiles-path{width:260px;font-family:ui-monospace,Consolas,monospace}',
  '.pfiles-foot{margin-top:8px;font-size:12px}',
].join(String.fromCharCode(10));

function joinPath(base, name) {
  const b = String(base || '/').replace(/\/+$/, '');
  return (b === '' ? '' : b) + '/' + name;
}

function parentPath(p) {
  const clean = String(p || '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return '/';
  return clean.slice(0, idx);
}

function downloadURL(mount, path, inline) {
  const sp = new URLSearchParams();
  sp.set('mount', String(mount || ''));
  sp.set('path', String(path || '/'));
  if (inline) sp.set('inline', '1');
  return '/api/v1/files/download?' + sp.toString();
}

function fileName(e) { return e.name || String(e.path || '').split('/').pop() || ''; }
function isDir(e) { return !!(e.dir || e.isDir || e.directory); }
function modTime(e) { return e.modTime || e.modified || e.mtime || e.updatedAt || null; }
function sizeOf(e) { return e.size !== undefined ? e.size : (e.length !== undefined ? e.length : 0); }

function crumbs(root, path, onGo) {
  const box = el('div', { class: 'pfiles-crumb' });
  const parts = String(path || '/').split('/').filter((s) => s.length > 0);
  const rootBtn = el('button', { type: 'button', text: '根目录', onclick: () => onGo('/') });
  box.appendChild(rootBtn);
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc += '/' + parts[i];
    const target = acc;
    box.appendChild(el('span', { class: 'pfiles-sep', text: '/' }));
    box.appendChild(el('button', { type: 'button', text: parts[i], onclick: () => onGo(target) }));
  }
  return box;
}

export default {
  id: 'files',
  title: '文件管理',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    const state = { mounts: [], mountId: '', path: '/', entries: [], shares: null, shareErr: null, q: '' };
    const listBox = el('div', {});
    const crumbBox = el('div', {});
    const shareBox = el('div', {});
    const mountSel = selectEl([{ value: '', label: '（未获取到挂载点）' }], '');
    const pathInput = input({ class: 'input pfiles-path', value: '/', placeholder: '/sub/dir' });

    function currentMount() {
      return state.mounts.filter((m) => m.id === state.mountId)[0] || null;
    }

    function filtered() {
      const q = state.q.trim().toLowerCase();
      if (!q) return state.entries;
      return state.entries.filter((e) => fileName(e).toLowerCase().indexOf(q) >= 0);
    }

    function paintCrumbs() {
      clear(crumbBox);
      crumbBox.appendChild(crumbs('', state.path, (p) => browse(p)));
      pathInput.value = state.path;
    }

    function paintList() {
      clear(listBox);
      if (!state.mountId) {
        listBox.appendChild(emptyBox('请选择或先创建一个存储挂载点（可在“存储”页面创建）'));
        return;
      }
      const rows = filtered().map((e) => ({ raw: e, tag: e.path || fileName(e) }));
      if (!rows.length) {
        listBox.appendChild(emptyBox(state.entries.length ? '没有匹配的文件' : '该目录为空'));
        return;
      }
      const cols = [
        { title: '名称', render: (e) => el('span', { class: 'pfiles-name' + (isDir(e) ? ' pfiles-dir' : ''), text: fileName(e) + (isDir(e) ? '/' : '') }) },
        { title: '类型', render: (e) => badge(isDir(e) ? '目录' : (e.mode || '文件')) },
        { title: '大小', cls: 'num', render: (e) => (isDir(e) ? el('span', { class: 'muted', text: '-' }) : el('span', { text: fmtBytes(sizeOf(e)) })) },
        { title: '修改时间', render: (e) => el('span', { text: fmtTime(modTime(e)) }) },
        { title: '', cls: 'acts', render: (e) => (isDir(e)
          ? el('span', {}, el('button', { class: 'btn btn-sm', type: 'button', text: '打开', dataset: { tag: 'open' }, onclick: () => browse(e.path || joinPath(state.path, fileName(e))) }))
          : el('span', {},
            el('a', { class: 'btn btn-sm', href: downloadURL(state.mountId, e.path || joinPath(state.path, fileName(e))), download: fileName(e), text: '下载' }),
            el('a', { class: 'btn btn-sm ghost', href: downloadURL(state.mountId, e.path || joinPath(state.path, fileName(e)), true), target: '_blank', rel: 'noopener', text: '预览' }),
          )) },
      ];
      listBox.appendChild(dataTable(cols, rows, '该目录为空'));
    }

    async function browse(p) {
      state.path = p || '/';
      pathInput.value = state.path;
      paintCrumbs();
      clear(listBox);
      if (!state.mountId) { paintList(); return; }
      listBox.appendChild(spinner('正在读取目录…'));
      try {
        const data = await api.get('/storage/mounts/' + encodeURIComponent(state.mountId) + '/list', { path: state.path });
        const list = (data && Array.isArray(data.entries)) ? data.entries : unwrap(data, ['entries', 'items']);
        state.entries = list.map((e) => Object.assign({}, e, {
          name: e.name || String(e.path || '').split('/').pop(),
          dir: !!(e.dir || e.isDir || e.directory),
          size: sizeOf(e),
          modTime: modTime(e),
        }));
      } catch (e) {
        clear(listBox);
        listBox.appendChild(errorCard(e, () => browse(state.path)));
        return;
      }
      paintList();
    }

    async function loadMounts() {
      try {
        const data = await api.get('/storage/mounts');
        state.mounts = unwrap(data, ['mounts', 'items']);
      } catch (e) {
        state.mounts = [];
        clear(listBox);
        listBox.appendChild(errorCard(e, () => loadMounts()));
        return;
      }
      clear(mountSel);
      if (!state.mounts.length) {
        mountSel.appendChild(el('option', { value: '', text: '（暂无挂载点）' }));
        paintList();
        return;
      }
      for (const m of state.mounts) {
        mountSel.appendChild(el('option', { value: m.id, text: (m.name || m.id) + (m.readOnly ? '（只读）' : '') }));
      }
      state.mountId = state.mounts[0].id;
      mountSel.value = state.mountId;
      browse('/');
    }

    async function loadShares() {
      clear(shareBox);
      shareBox.appendChild(spinner('正在加载分享链接…'));
      try {
        const data = await api.get('/files/shares');
        state.shares = unwrap(data, ['shares', 'items']);
        state.shareErr = null;
      } catch (e) {
        state.shares = null;
        state.shareErr = e;
      }
      paintShares();
    }

    function shareURL(s, token) {
      if (s && s.url) return s.url;
      if (token) return '/s/' + token;
      return '';
    }

    function paintShares() {
      clear(shareBox);
      if (state.shareErr) {
        shareBox.appendChild(el('div', { class: 'error' },
          el('div', { style: 'font-weight:600;margin-bottom:5px', text: '分享链接接口不可用' }),
          el('div', { text: apiErr(state.shareErr) }),
          el('div', { class: 'muted', style: 'margin-top:5px;font-size:12px', text: '分享链接由文件管理模块（filebrowser）提供；如果该模块未启用，可以改用 Web 服务里的“文件管理”规则生成分享链接。' }),
          el('div', { style: 'margin-top:9px' }, el('button', { class: 'btn', type: 'button', text: '重试', onclick: () => loadShares() })),
        ));
        return;
      }
      const list = state.shares || [];
      if (!list.length) { shareBox.appendChild(emptyBox('暂无分享链接（在文件管理站点中点击“分享”可生成）')); return; }
      const cols = [
        { title: '挂载 / 路径', render: (s) => el('div', {}, el('div', { class: 'mono', text: (s.mountId || s.mount || '-') + ' ' + (s.path || '-') }), s.name ? el('div', { class: 'muted', style: 'font-size:11px', text: s.name }) : null) },
        { title: '链接', render: (s) => {
          const url = shareURL(s, s.token || s.id);
          if (!url) return el('span', { class: 'muted', text: '-' });
          const node = el('span', { class: 'mono', text: url });
          const copy = el('button', { class: 'btn btn-sm ghost', type: 'button', text: '复制', onclick: () => {
            const full = url.indexOf('http') === 0 ? url : (window.location.origin + url);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(full).then(() => toast('已复制链接', 'ok')).catch(() => toast('复制失败，请手动复制：' + full, 'warn'));
            } else {
              toast('请手动复制：' + full, 'warn');
            }
          } });
          return el('span', {}, node, el('span', { text: ' ' }), copy);
        } },
        { title: '有效期', render: (s) => el('span', { text: s.expiresAt || s.expireAt ? fmtTime(s.expiresAt || s.expireAt) : (s.ttlMinutes || s.shareTtlMinutes ? (s.ttlMinutes || s.shareTtlMinutes) + ' 分钟' : '永久') }) },
        { title: '创建者', render: (s) => el('span', { class: 'muted', text: s.createdBy || s.user || '-' }) },
        { title: '', cls: 'acts', render: (s) => el('span', {},
          iconBtn(trashIcon(), { title: '取消分享', tag: 'remove', onClick: () => removeShare(s) }),
        ) },
      ];
      shareBox.appendChild(dataTable(cols, list.map((s) => ({ raw: s, tag: s.id || s.token })), '暂无分享链接'));
    }

    async function removeShare(s) {
      const ok = await confirmDialog('确定取消该分享链接吗？取消后原链接立即失效。');
      if (!ok) return;
      try {
        await api.del('/files/shares/' + encodeURIComponent(s.id || s.token));
        toast('已取消分享', 'ok');
        loadShares();
      } catch (e) {
        toast('取消失败：' + apiErr(e), 'error');
      }
    }

    mountSel.addEventListener('change', () => {
      state.mountId = mountSel.value;
      browse('/');
    });
    pathInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') browse(pathInput.value || '/'); });

    function goUp() { browse(parentPath(state.path)); }

    const search = input({ class: 'input', style: 'width:160px', placeholder: '过滤当前目录' });
    search.addEventListener('input', debounce(() => { state.q = search.value; paintList(); }, 180));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '文件浏览' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: 'GET /api/v1/storage/mounts/{id}/list?path=' }),
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => browse(state.path) }),
      ),
      el('div', { class: 'card-body' },
        el('div', { class: 'pfiles-tools' },
          el('span', { class: 'muted', text: '挂载点' }),
          mountSel,
          el('button', { class: 'btn', type: 'button', text: '上一级', onclick: () => goUp() }),
          el('button', { class: 'btn', type: 'button', text: '根目录', onclick: () => browse('/') }),
          pathInput,
          el('button', { class: 'btn', type: 'button', text: '前往', onclick: () => browse(pathInput.value || '/') }),
          el('span', { class: 'spacer' }),
          search,
        ),
        el('div', { style: 'height:8px' }),
        crumbBox,
        el('div', { style: 'height:6px' }),
        listBox,
        el('div', { class: 'muted pfiles-foot', text: '下载地址：/api/v1/files/download?mount={挂载}&path={路径}（浏览器直接打开该地址即可下载）。如果该接口未实现，请通过 Web 服务规则或 WebDAV 下载文件。' }),
      ),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '分享链接' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: 'GET/DELETE /api/v1/files/shares' }),
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadShares() }),
      ),
      el('div', { class: 'card-body' }, shareBox),
    ));

    paintCrumbs();
    loadMounts();
    loadShares();
    return () => { offStyle(); };
  },
};
