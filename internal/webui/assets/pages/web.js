// nunt 前端页面模块：web.js
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

// ---------------------------------------------------------------------------
// Web 服务：反向代理 / 重定向 / 静态托管 / 文件管理 / WebDAV
// ---------------------------------------------------------------------------
const TYPES = [
  { id: 'proxy', label: '反向代理' },
  { id: 'redirect', label: '重定向' },
  { id: 'static', label: '静态托管' },
  { id: 'filebrowser', label: '文件管理' },
  { id: 'webdav', label: 'WebDAV' },
];
const TYPE_LABEL = { proxy: '反向代理', redirect: '重定向', static: '静态托管', filebrowser: '文件管理', webdav: 'WebDAV' };
const TLS_LABEL = { off: '关闭', auto: '自动证书', custom: '指定证书' };
const BALANCE_LABEL = { round_robin: '轮询', random: '随机', ip_hash: 'IP 哈希', least_conn: '最少连接' };
const ACCESS_LABEL = { off: '关闭', allow: '仅允许', deny: '拒绝' };
const PAGE_CSS = [
  '.pweb-sum{font-size:12px}',
  '.pweb-hint{margin-bottom:10px}',
  '.pweb-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pweb-search{width:180px}',
  '.pweb-log{max-height:300px}',
  '.pweb-hit>td{background:color-mix(in srgb,var(--brand) 10%,transparent)}',
].join(String.fromCharCode(10));
const NEWLINE = String.fromCharCode(10);

function numVal(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : (dflt || 0);
}

function tlsLabel(r) {
  const mode = (r && r.tls && r.tls.mode) || 'off';
  return TLS_LABEL[mode] || '关闭';
}

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

async function certOptions() {
  try {
    const data = await api.get('/acme/certificates');
    return unwrap(data, ['certificates', 'items']).map((c) => {
      const domains = c.domains || (c.domain ? [c.domain] : []);
      const label = domains.join(', ') || c.name || c.id;
      return { value: c.id || c.name || label, label: label };
    });
  } catch (e) {
    return [];
  }
}

async function mountOptions() {
  try {
    const data = await api.get('/storage/mounts');
    return unwrap(data, ['mounts', 'items']).filter((m) => m.enable !== false).map((m) => ({
      value: m.id,
      label: (m.name || m.id) + (m.type === 'webdav' ? '（WebDAV）' : '（本地）'),
    }));
  } catch (e) {
    return [];
  }
}

function accessFields(base) {
  const a = (base && base.access) || {};
  const f = {};
  f.accessMode = selectEl([
    { value: 'off', label: '关闭' },
    { value: 'allow', label: '白名单（仅允许以下 IP）' },
    { value: 'deny', label: '黑名单（拒绝以下 IP）' },
  ], a.mode || 'off');
  f.accessIPs = textarea({ rows: '3', placeholder: '每行一条，支持 CIDR：' + NEWLINE + '192.168.1.0/24' + NEWLINE + '10.0.0.8', value: (a.ips || []).join(NEWLINE) });
  f.uaMode = selectEl([
    { value: 'off', label: '关闭' },
    { value: 'allow', label: '白名单（仅允许匹配 UA）' },
    { value: 'deny', label: '黑名单（拒绝匹配 UA）' },
  ], a.uaMode || 'off');
  f.uaList = textarea({ rows: '3', placeholder: '每行一条，支持 * 通配：' + NEWLINE + '*bot*' + NEWLINE + 'curl*', value: (a.uas || []).join(NEWLINE) });
  return f;
}

function basicAuthFields(base) {
  const b = base && base.basicAuth;
  const users = (b && b.users) || [];
  const first = users[0] || {};
  const f = {};
  f.authEnable = checkEl('启用 BasicAuth 保护', !!(b && b.enable));
  f.authUser = input({ placeholder: '用户名', value: first.username || '' });
  f.authPass = input({ type: 'password', autocomplete: 'new-password', placeholder: base && base.id ? '留空表示不修改' : '密码' });
  f.authExtra = textarea({ rows: '2', placeholder: '其他账号，每行一个：user:password', value: users.slice(1).map((u) => u.username + ':' + u.password).join(NEWLINE) });
  return f;
}

function collectAuth(F, editing) {
  const users = [];
  const user = val(F.authUser);
  const pass = val(F.authPass);
  if (user && pass) users.push({ username: user, password: pass });
  for (const raw of val(F.authExtra).split(NEWLINE)) {
    const line = raw.trim();
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    users.push({ username: line.slice(0, idx).trim(), password: line.slice(idx + 1).trim() });
  }
  const out = { enable: checked(F.authEnable), users: users };
  if (editing && out.enable && !users.length) delete out.users;
  if (!out.enable) out.users = [];
  return out;
}

function redirectFields(base) {
  const t = (base && base.redirect) || {};
  const f = {};
  f.redirectTo = input({ value: t.to || '', placeholder: 'https://example.com/new' });
  f.redirectStatus = selectEl([
    { value: '301', label: '301 永久重定向' },
    { value: '302', label: '302 临时重定向' },
    { value: '307', label: '307 保持方法' },
    { value: '308', label: '308 永久且保持方法' },
  ], String(t.status || 302));
  f.redirectKeep = checkEl('保留原始路径（拼接在目标之后）', !!t.keepPath);
  return f;
}

function staticFields(base, mounts) {
  const t = (base && base.static) || {};
  const f = {};
  f.staticMount = selectEl([{ value: '', label: '（不使用挂载，直接用本地目录）' }].concat(mounts), t.mountId || '');
  f.staticRoot = input({ value: t.root || '', placeholder: '例如 /var/www/site 或 /srv/nunt/www' });
  f.staticIndex = input({ value: (t.index || ['index.html']).join(' '), placeholder: 'index.html index.htm' });
  f.staticCache = input({ type: 'number', min: '0', value: String(t.cacheSeconds || 0), placeholder: '0 表示不缓存' });
  f.staticListing = checkEl('允许目录列表', !!t.listing);
  f.staticSPA = checkEl('单页应用模式（找不到文件时回退 index.html）', !!t.spa);
  return f;
}

function filesFields(base, mounts) {
  const t = (base && base.files) || {};
  const f = {};
  f.filesMount = selectEl([{ value: '', label: '（不使用挂载，直接用本地目录）' }].concat(mounts), t.mountId || '');
  f.filesRoot = input({ value: t.root || '/', placeholder: '/' });
  f.filesTitle = input({ value: t.title || '', placeholder: '页面标题，留空使用规则名称' });
  f.filesReadonly = checkEl('只读（禁止所有写操作）', !!t.readOnly);
  f.filesUpload = checkEl('允许上传', !!t.allowUpload);
  f.filesDelete = checkEl('允许删除', !!t.allowDelete);
  f.filesMkdir = checkEl('允许新建目录', !!t.allowMkdir);
  f.filesRename = checkEl('允许重命名', !!t.allowRename);
  f.filesHidden = checkEl('显示隐藏文件', !!t.showHidden);
  f.filesShare = checkEl('启用分享链接', !!t.shareLinks);
  f.filesTTL = input({ type: 'number', min: '0', value: String(t.shareTtlMin || 0), placeholder: '0 表示永久' });
  return f;
}

function proxyHint() {
  return el('div', { class: 'notice' },
    '上游列表每行一个地址（支持 http/https，可带端口）；路径重写会把匹配到的“路径重写前缀”替换为“路径替换为”，留空则不重写。');
}

function buildTarget(kind, base, mounts, host) {
  clear(host);
  if (kind === 'proxy') {
    const p = (base && base.proxy) || {};
    const targets = textarea({ rows: '4', placeholder: '每行一个上游地址：' + NEWLINE + 'http://127.0.0.1:8080' + NEWLINE + 'http://10.0.0.5:80', value: (p.targets || []).join(NEWLINE) });
    const balance = selectEl([
      { value: 'round_robin', label: '轮询' },
      { value: 'random', label: '随机' },
      { value: 'ip_hash', label: 'IP 哈希' },
      { value: 'least_conn', label: '最少连接' },
    ], p.balance || 'round_robin');
    const hostHeader = input({ value: p.hostHeader || '', placeholder: '留空透传客户端 Host' });
    const timeout = input({ type: 'number', min: '0', value: String(p.timeoutSec === undefined ? '' : p.timeoutSec), placeholder: '0 表示默认' });
    const reqHeaders = textarea({ rows: '3', placeholder: '每行一条 key: value' + NEWLINE + 'X-Real-IP: $remote_addr', value: kvText(p.headers) });
    const respHeaders = textarea({ rows: '3', placeholder: '每行一条 key: value', value: kvText(p.respHeaders) });
    const prefix = input({ value: p.pathPrefix || '', placeholder: '例如 /api' });
    const replace = input({ value: p.pathReplace || '', placeholder: '例如 /' });
    const insecure = checkEl('跳过上游证书校验', !!p.insecureTls);
    const noCompress = checkEl('禁用压缩', !!p.disableCompres);
    host.appendChild(proxyHint());
    host.appendChild(fieldSet('上游服务', [
      field('上游列表', targets, '每行一个上游地址', true),
      field('负载均衡方式', balance),
      field('Host 头', hostHeader, '留空透传客户端 Host'),
    ]));
    host.appendChild(fieldSet('请求 / 响应调整', [
      field('超时（秒）', timeout),
      field('请求头', reqHeaders),
      field('响应头', respHeaders),
      field('路径重写前缀', prefix),
      field('路径替换为', replace),
      field('其他选项', el('div', { class: 'bar' }, insecure, noCompress)),
    ]));
    return {
      collect: () => ({
        proxy: {
          targets: lines(targets),
          balance: val(balance) || 'round_robin',
          hostHeader: val(hostHeader),
          headers: keyValues(reqHeaders),
          respHeaders: keyValues(respHeaders),
          pathPrefix: val(prefix),
          pathReplace: val(replace),
          timeoutSec: numOf(timeout, 0),
          insecureTls: checked(insecure),
          disableCompres: checked(noCompress),
        },
      }),
    };
  }
  if (kind === 'redirect') {
    const F = redirectFields(base);
    host.appendChild(fieldSet('重定向设置', [
      field('目标地址', F.redirectTo, '可以包含 https:// 前缀', true),
      field('状态码', F.redirectStatus),
      field('路径处理', F.redirectKeep),
    ]));
    host.appendChild(el('div', { class: 'notice', text: '开启“保留原始路径”后，请求 /a/b 会被重定向到 目标地址 + /a/b。' }));
    return {
      collect: () => ({ redirect: { to: val(F.redirectTo), status: numOf(F.redirectStatus, 302), keepPath: checked(F.redirectKeep) } }),
      redirect: true,
    };
  }
  if (kind === 'static') {
    const F = staticFields(base, mounts);
    host.appendChild(fieldSet('静态文件', [
      field('存储挂载', F.staticMount, '来自“存储挂载”页面'),
      field('本地目录', F.staticRoot, '未选择挂载时使用'),
      field('索引文件', F.staticIndex, '空格分隔'),
      field('缓存秒数', F.staticCache),
      field('选项', el('div', { class: 'bar' }, F.staticListing, F.staticSPA)),
    ]));
    return {
      collect: () => ({
        static: {
          mountId: val(F.staticMount),
          root: val(F.staticRoot),
          index: val(F.staticIndex).split(/\s+/).filter((s) => s.length > 0),
          cacheSeconds: numOf(F.staticCache, 0),
          listing: checked(F.staticListing),
          spa: checked(F.staticSPA),
        },
      }),
      needsMount: true,
    };
  }
  const F = filesFields(base, mounts);
  const isDav = kind === 'webdav';
  host.appendChild(fieldSet(isDav ? 'WebDAV 服务' : '文件管理', [
    field('存储挂载', F.filesMount, '来自“存储挂载”页面'),
    field('根目录', F.filesRoot),
    field('标题', F.filesTitle),
    field('只读', F.filesReadonly),
    field('权限', el('div', { class: 'bar' }, F.filesUpload, F.filesDelete, F.filesMkdir, F.filesRename)),
    field('显示', el('div', { class: 'bar' }, F.filesHidden, F.filesShare)),
    field('分享有效期（分钟）', F.filesTTL, '0 表示永久有效'),
  ]));
  return {
    collect: () => ({
      files: {
        mountId: val(F.filesMount),
        root: val(F.filesRoot) || '/',
        title: val(F.filesTitle),
        readOnly: checked(F.filesReadonly),
        allowUpload: checked(F.filesUpload),
        allowDelete: checked(F.filesDelete),
        allowMkdir: checked(F.filesMkdir),
        allowRename: checked(F.filesRename),
        showHidden: checked(F.filesHidden),
        shareLinks: checked(F.filesShare),
        shareTtlMinutes: numOf(F.filesTTL, 0),
      },
    }),
    needsMount: true,
  };
}

// ---------------------------------------------------------------------------
// 请求体检查策略（与后端 model.WebRule.bodyPolicy 一一对应）
//
// 空串 = 继承全局默认策略；其余取值由 PLAN-waf-body-policy.md §2 冻结。
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

function bodyPolicyHintOf(value) {
  const key = BODY_POLICY_OPTIONS.filter((o) => o.value === String(value || ''))[0];
  return key ? BODY_POLICY_HINT[key.value] : BODY_POLICY_HINT[''];
}

function bodyPolicyBadge(value) {
  const key = String(value || '');
  if (key === 'full') return badge('全量', 'ok');
  if (key === 'peek') return badge('偷看', 'warn');
  if (key === 'skip') return badge('跳过', 'err');
  if (key === 'grpc-unary') return badge('gRPC 单消息', 'ok');
  if (key === 'grpc-stream') return badge('gRPC 流式', 'warn');
  return el('span', { class: 'muted', text: '继承默认' });
}

function baseFields(base) {
  const b = base || {};
  const f = {};
  f.name = input({ value: b.name || '', placeholder: '例如 博客首页' });
  // WAF 开关与请求体策略：两者都是可编辑的（旧版本把 WAF 当成只读回显，
  // 导致编辑规则时无法调整防护开关）。
  f.waf = checkEl('启用 WAF 检查', !!b.waf);
  f.bodyPolicy = selectEl(BODY_POLICY_OPTIONS, String(b.bodyPolicy || ''));
  f.enable = checkEl('启用该规则', b.enable !== false);
  f.type = selectEl(TYPES.map((t) => ({ value: t.id, label: t.label })), b.type || 'proxy');
  f.listen = textarea({ rows: '3', placeholder: '每行一个监听地址，例如：' + NEWLINE + ':443' + NEWLINE + '0.0.0.0:8080', value: (b.listen || []).join(NEWLINE) });
  f.domains = textarea({ rows: '3', placeholder: '每行一个域名，支持通配：' + NEWLINE + 'example.com' + NEWLINE + '*.example.com', value: (b.domains || []).join(NEWLINE) });
  f.path = input({ value: b.path || '/', placeholder: '/' });
  f.priority = input({ type: 'number', value: String(b.priority || 0) });
  return f;
}

// bodyPolicyHintNode 随下拉选择实时更新策略说明。
function bodyPolicyHintNode(select) {
  const node = el('div', { class: 'hint', text: bodyPolicyHintOf(val(select)) });
  select.addEventListener('change', () => { node.textContent = bodyPolicyHintOf(val(select)); });
  return node;
}

function tlsFields(base) {
  const t = (base && base.tls) || {};
  const f = {};
  f.mode = selectEl([
    { value: 'off', label: '关闭（仅 HTTP）' },
    { value: 'auto', label: '自动证书（ACME 自动申请）' },
    { value: 'custom', label: '指定证书' },
  ], t.mode || 'off');
  f.cert = null;
  f.hsts = checkEl('启用 HSTS（强制浏览器使用 HTTPS）', !!t.hsts);
  return f;
}

async function openRuleForm(rule, ctx, reload) {
  const base = rule || {};
  const editing = !!base.id;
  const F = baseFields(base);
  const T = tlsFields(base);
  const A = accessFields(base);
  const B = basicAuthFields(base);
  const targetBox = el('div', {});
  const targetRef = { collect: () => ({}), needsMount: false };
  const certRow = el('div', {});

  async function refreshCertRow() {
    clear(certRow);
    if (val(T.mode) === 'custom') {
      const opts = await certOptions();
      const certSel = opts.length
        ? selectEl(opts, (base.tls && base.tls.certId) || '')
        : input({ value: (base.tls && base.tls.certId) || '', placeholder: '证书 ID（暂无证书，请先在“证书”页面申请）' });
      certRow.appendChild(field('证书', certSel, opts.length ? '' : '未能获取证书列表，可直接填写证书 ID'));
      targetRef.cert = certSel;
    } else {
      targetRef.cert = null;
    }
  }

  let mounts = await mountOptions();
  function rebuildTarget() {
    const kind = val(F.type);
    if (targetRef.needsMount && !mounts.length) {
      mountOptions().then((list) => { mounts = list; rebuildTarget(); });
    }
    const built = buildTarget(kind, base, mounts, targetBox);
    targetRef.collect = built.collect;
    targetRef.needsMount = !!built.needsMount;
  }

  const body = el('div', {},
    el('div', { class: 'notice', text: editing ? '正在编辑规则：' + (base.name || base.id) : '新建规则。监听地址可写 :443、0.0.0.0:8080、[::]:443 等；不填域名则匹配任意 Host。' }),
    fieldSet('基本信息', [
      field('名称', F.name),
      field('类型', F.type, '不同类型显示不同的目标配置'),
      field('监听地址', F.listen, '每行一个', true),
      field('域名', F.domains, '支持 *.example.com', true),
      field('路径', F.path, '前缀匹配'),
      field('优先级', F.priority, '数字越小越优先'),
      field('启用', F.enable),
    ]),
    fieldSet('TLS', [
      field('模式', T.mode),
      certRow,
      field('HSTS', T.hsts),
    ]),
    targetBox,
    fieldSet('访问控制', [
      field('IP 策略', A.accessMode),
      field('IP 列表', A.accessIPs, '每行一条，支持 CIDR'),
      field('UA 策略', A.uaMode),
      field('UA 列表', A.uaList, '每行一条，支持 * 通配'),
    ]),
    fieldSet('BasicAuth', [
      field('启用', B.authEnable),
      field('用户名', B.authUser),
      field('密码', B.authPass, editing ? '留空表示不修改' : ''),
      field('其他账号', B.authExtra, '每行一个 user:password'),
    ]),
    fieldSet('WAF 与请求体检查策略', [
      field('WAF 开关', F.waf, '关闭后该路由完全不经过 WAF（含请求体检查）'),
      field('请求体策略', F.bodyPolicy, ''),
      el('div', { class: 'field', style: { gridColumn: '1 / -1' } },
        bodyPolicyHintNode(F.bodyPolicy),
        el('div', { class: 'hint', text: '能力边界：gRPC 流式路由只做首消息检查 + 帧校验，后续消息不会被逐条检查；' +
          '声明 grpc-unary 的路由若出现第二帧，enforce 模式下拒绝、observe 模式下只记录。' }),
      ),
    ]),
  );

  F.type.addEventListener('change', () => { rebuildTarget(); });
  T.mode.addEventListener('change', () => { refreshCertRow(); });
  rebuildTarget();
  await refreshCertRow();

  openModal({
    title: editing ? '编辑 Web 规则' : '新建 Web 规则',
    body,
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          const name = val(F.name);
          if (!name) { toast('请填写规则名称', 'warn'); return false; }
          const listens = lines(F.listen);
          if (!listens.length) { toast('请至少填写一个监听地址，例如 :443', 'warn'); return false; }
          const kind = val(F.type);
          const payload = {
            name,
            enable: checked(F.enable),
            type: kind,
            listen: listens,
            domains: lines(F.domains),
            path: val(F.path) || '/',
            priority: numOf(F.priority, 0),
            tls: {
              mode: val(T.mode) || 'off',
              certId: targetRef.cert ? val(targetRef.cert) : ((base.tls && base.tls.certId) || ''),
              hsts: checked(T.hsts),
            },
            waf: checked(F.waf),
            bodyPolicy: val(F.bodyPolicy),
            access: {
              mode: val(A.accessMode) || 'off',
              ips: lines(A.accessIPs),
              uaMode: val(A.uaMode) || 'off',
              uas: lines(A.uaList),
            },
            basicAuth: collectAuth(B, editing),
            proxy: null,
            redirect: null,
            static: null,
            files: null,
          };
          const tgt = targetRef.collect() || {};
          Object.assign(payload, tgt);
          if (kind === 'proxy' && (!payload.proxy || !payload.proxy.targets.length)) { toast('请至少填写一个上游地址', 'warn'); return false; }
          if (kind === 'redirect' && (!payload.redirect || !payload.redirect.to)) { toast('请填写重定向目标地址', 'warn'); return false; }
          try {
            if (editing) await api.put('/web/rules/' + encodeURIComponent(base.id), payload);
            else await api.post('/web/rules', payload);
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

function openRuleLogs(rule, ctx) {
  const view = el('div', {}, spinner('正在加载访问日志…'));
  let stop = null;
  async function tick() {
    try {
      const data = await api.get('/web/logs', { rule: rule.id, limit: 200 });
      const list = unwrap(data, ['logs', 'items', 'entries']);
      clear(view);
      if (!list.length) { view.appendChild(emptyBox('暂无访问日志（可能未开启访问日志记录）')); return; }
      view.appendChild(logView(list.map((item) => {
        if (typeof item === 'string') return item;
        const t = fmtTime(item.time || item.ts || item.at);
        const ip = item.ip || item.remoteIp || item.clientIp || '-';
        const method = item.method || '-';
        const path = item.path || item.url || item.uri || '-';
        const code = item.status || item.code || '-';
        const ms = (item.durationMs !== undefined ? item.durationMs : item.latencyMs);
        return t + '  ' + ip + '  ' + method + ' ' + path + '  ' + code + (ms !== undefined ? '  ' + ms + 'ms' : '');
      }), 300));
    } catch (e) {
      clear(view);
      view.appendChild(errorCard(e, () => tick()));
    }
  }
  const m = openModal({
    title: '访问日志 - ' + (rule.name || rule.id),
    body: view,
    onClose: () => { if (stop) stop(); },
    actions: [{ label: '关闭', kind: 'ghost' }],
  });
  stop = makePoller(tick, 5000);
  tick();
  return m;
}

export default {
  id: 'web',
  title: 'Web 服务',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    // WAF 页的「未声明 bodyPolicy 的路由」通过 #/web?rule=<id> 跳转到本页，
    // 这里把该规则从列表里挑出来高亮，并提供「设置请求体策略」的一键入口。
    const focusId = String((ctx && ctx.params && ctx.params.get('rule')) || '').trim();
    const state = { type: 'all', q: focusId, rules: [] };
    const bodyBox = el('div', {});
    const focusBox = el('div', {});
    let focusWarned = false;

    async function getRule(id) {
      const data = await api.get('/web/rules');
      const list = unwrap(data, ['rules', 'items']);
      return list.filter((r) => r.id === id)[0] || null;
    }

    async function toggle(rule, next) {
      const want = (next === undefined) ? !rule.enable : !!next;
      try {
        await api.post('/web/rules/' + encodeURIComponent(rule.id) + '/toggle');
      } catch (e) {
        try {
          await api.put('/web/rules/' + encodeURIComponent(rule.id), Object.assign({}, rule, { enable: want }));
        } catch (e2) {
          toast('切换失败：' + apiErr(e2), 'error');
          return false;
        }
      }
      toast(want ? '已启用' : '已停用', 'ok');
      load();
    }

    async function remove(rule) {
      const ok = await confirmDialog('确定删除规则「' + (rule.name || rule.id) + '」吗？该操作不可撤销。');
      if (!ok) return;
      try {
        await api.del('/web/rules/' + encodeURIComponent(rule.id));
        toast('已删除', 'ok');
        load();
      } catch (e) {
        toast('删除失败：' + apiErr(e), 'error');
      }
    }

    const columns = [
      { title: '名称', render: (r) => el('div', {}, el('div', { text: r.name || r.id }), el('div', { class: 'muted mono', text: r.path || '/' })) },
      { title: '类型', render: (r) => badge(TYPE_LABEL[r.type] || r.type || '-') },
      { title: '监听', render: (r) => chips(r.listen, 2) },
      { title: '域名', render: (r) => chips(r.domains, 2) },
      { title: '目标', render: (r) => el('span', { class: 'mono pweb-sum', text: targetText(r) }) },
      { title: 'TLS', render: (r) => badge(tlsLabel(r), r.tls && r.tls.mode === 'off' ? '' : 'ok') },
      { title: 'WAF', render: (r) => (r.waf ? badge('已开启', 'ok') : el('span', { class: 'muted', text: '关闭' })) },
      { title: '请求体策略', render: (r) => (r.waf ? bodyPolicyBadge(r.bodyPolicy) : el('span', { class: 'muted', text: '不检查' })) },
      { title: '状态', render: (r) => switchEl(!!r.enable, (next) => toggle(r, next)) },
      { title: '', cls: 'acts', render: (r) => el('span', {},
        iconBtn(logIcon(), { title: '访问日志', tag: 'logs', onClick: () => openRuleLogs(r, ctx) }),
        iconBtn(editIcon(), { title: '编辑', tag: 'edit', onClick: () => openRuleForm(r, ctx, load) }),
        iconBtn(trashIcon(), { title: '删除', tag: 'remove', onClick: () => remove(r) }),
      ) },
    ];

    function filtered() {
      const q = state.q.trim().toLowerCase();
      return state.rules.filter((r) => {
        if (state.type !== 'all' && r.type !== state.type) return false;
        if (!q) return true;
        const hay = [r.name, r.id, (r.listen || []).join(' '), (r.domains || []).join(' '), r.path, r.type].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }

    function paint() {
      clear(bodyBox);
      const rows = filtered().map((r) => ({
        raw: r, tag: r.id,
        onClick: (ev) => {
          if (ev && ev.target && ev.target.closest && ev.target.closest('button,a,input,label')) return;
          openRuleLogs(r, ctx);
        },
      }));
      if (!rows.length) {
        bodyBox.appendChild(emptyBox(state.rules.length ? '没有符合条件的规则' : '还没有 Web 规则，点击右上角“新建规则”开始'));
        return;
      }
      const table = dataTable(columns, rows, '暂无规则');
      bodyBox.appendChild(table);
      if (focusId) {
        // dataTable 的行标签就是规则 id，用它定位并高亮目标行。
        const hit = table.querySelector('tr[data-row="' + focusId.replace(/"/g, '') + '"]');
        if (hit) hit.classList.add('pweb-hit');
        if (!hit && !focusWarned) {
          focusWarned = true;
          toast('未在当前规则列表里找到 ' + focusId + '，可能已被删除', 'warn');
        }
      }
    }

    // paintFocus 顶部提示条：说明本次是从 WAF 页跳过来的，并直接给出编辑入口。
    function paintFocus() {
      clear(focusBox);
      if (!focusId) return;
      const rule = state.rules.filter((r) => r.id === focusId)[0] || null;
      const open = rule
        ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '设置请求体策略', onclick: () => openRuleForm(rule, ctx, load) })
        : null;
      focusBox.appendChild(el('div', { class: 'notice' },
        el('div', { style: { fontWeight: '600' }, text: rule ? '来自 WAF 页：为路由「' + (rule.name || rule.id) + '」声明请求体策略' : '来自 WAF 页：找不到规则 ' + focusId }),
        el('div', { text: rule ? '该路由尚未声明 bodyPolicy，当前继承全局默认策略；保存后按该路由自己的策略执行。' : '该规则可能已被删除，请刷新列表。' }),
        open ? el('div', { style: { marginTop: '8px' } }, open) : null,
      ));
      focusBox.appendChild(el('div', { style: { height: '10px' } }));
    }

    async function load() {
      clear(bodyBox);
      bodyBox.appendChild(spinner('正在加载 Web 规则…'));
      try {
        const data = await api.get('/web/rules');
        state.rules = unwrap(data, ['rules', 'items']);
      } catch (e) {
        clear(bodyBox);
        bodyBox.appendChild(errorCard(e, () => load()));
        return;
      }
      paintFocus();
      paint();
    }

    const search = input({ class: 'input pweb-search', placeholder: '搜索名称/域名/路径', value: focusId });
    search.addEventListener('input', debounce(() => { state.q = search.value; paint(); }, 200));

    function paintTabs(host) {
      clear(host);
      host.appendChild(tabs([{ id: 'all', label: '全部' }].concat(TYPES), state.type, (id) => {
        state.type = id;
        paintTabs(host);
        paint();
      }));
    }

    const tabHost = el('div', {});
    paintTabs(tabHost);

    const head = el('div', { class: 'pweb-tools' },
      tabHost,
      el('span', { class: 'bar spacer' }),
      search,
      el('button', { class: 'btn btn-primary', type: 'button', text: '新建规则', onclick: () => openRuleForm(null, ctx, load) }),
    );

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { text: 'Web 规则' }), el('span', { class: 'grow' }), el('span', { class: 'muted', style: 'font-size:12px', text: '点击规则行可查看最近访问日志' })),
      el('div', { class: 'card-body' }, focusBox, head, el('div', { style: 'height:10px' }), bodyBox),
    ));

    load();
    return () => { offStyle(); };
  },
};