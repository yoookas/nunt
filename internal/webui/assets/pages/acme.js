// nunt 前端页面模块：acme.js
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
// 证书：ACME 签发任务 + 证书列表 + 手动上传
// ---------------------------------------------------------------------------
const CHALLENGE_LABEL = { 'http-01': 'HTTP-01', 'dns-01': 'DNS-01', 'tls-alpn-01': 'TLS-ALPN-01' };
const KEY_LABEL = { ecdsa: 'ECDSA P-256', rsa2048: 'RSA 2048', rsa4096: 'RSA 4096' };
const PAGE_CSS = [
  '.pacme-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pacme-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
  '@media (max-width:860px){.pacme-grid{grid-template-columns:1fr}}',
  '.pacme-days{display:flex;align-items:center;gap:8px;min-width:130px}',
  '.pacme-area{min-height:120px}',
].join(String.fromCharCode(10));

function challengeOptions(value) {
  return selectEl([
    { value: 'http-01', label: 'HTTP-01（需要 80 端口可访问）' },
    { value: 'dns-01', label: 'DNS-01（泛域名必须用这个）' },
    { value: 'tls-alpn-01', label: 'TLS-ALPN-01（需要 443 端口）' },
  ], value || 'http-01');
}

function keyTypeOptions(value) {
  return selectEl([
    { value: '', label: '使用全局默认' },
    { value: 'ecdsa', label: 'ECDSA P-256' },
    { value: 'rsa2048', label: 'RSA 2048' },
    { value: 'rsa4096', label: 'RSA 4096' },
  ], value || '');
}

function certDomains(c) {
  const list = c.domains || (c.domain ? [c.domain] : []);
  return list.filter((x) => x);
}

function certExpiry(c) {
  return c.notAfter || c.expiresAt || c.expiry || c.expireTime || c.validTo || null;
}

function certRemainDays(c) {
  const direct = c.remainDays !== undefined ? c.remainDays : (c.remainingDays !== undefined ? c.remainingDays : (c.daysLeft !== undefined ? c.daysLeft : undefined));
  if (direct !== undefined && direct !== null) return Number(direct);
  const exp = certExpiry(c);
  if (!exp) return null;
  const d = new Date(exp);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

function daysBar(days) {
  if (days === null || days === undefined || !isFinite(days)) return el('span', { class: 'muted', text: '-' });
  const pct = Math.max(0, Math.min(100, (days / 90) * 100));
  const kind = days <= 0 ? 'err' : (days <= 15 ? 'warn' : '');
  return el('div', { class: 'pacme-days' }, bar(pct, kind), el('span', { text: days + ' 天' }));
}

function openJobForm(job, providers, ctx, reload) {
  const base = job || {};
  const editing = !!base.id;
  const creds = Object.assign({}, base.dnsCreds || {});
  const name = input({ value: base.name || '', placeholder: '例如 主站证书' });
  const enable = checkEl('启用（参与自动续期）', base.enable !== false);
  const domains = textarea({ rows: '4', placeholder: '每行一个域名：' + LF + 'example.com' + LF + '*.example.com', value: (base.domains || []).join(LF) });
  const keyType = keyTypeOptions(base.keyType);
  const challenge = challengeOptions(base.challenge);
  const provider = selectEl(
    [{ value: '', label: '（不使用 DNS 提供商）' }].concat(providers.length
      ? providers.map((p) => ({ value: p.id, label: p.title }))
      : [{ value: base.dnsProvider || '', label: base.dnsProvider || '（未获取到提供商列表）' }]),
    base.dnsProvider || '',
  );
  const resolvers = textarea({ rows: '2', placeholder: '每行一个 DNS 解析服务器：' + LF + '1.1.1.1:53' + LF + '8.8.8.8:53', value: (base.dnsResolvers || []).join(LF) });
  const renewDays = input({ type: 'number', min: '1', value: String(base.renewDays || 30), placeholder: '30' });
  const remark = input({ value: base.remark || '', placeholder: '备注（可选）' });
  const credsHost = el('div', { class: 'grid' });
  let credNodes = [];

  function rebuildCreds() {
    clear(credsHost);
    credNodes = [];
    const id = val(provider);
    if (!id) return;
    const meta = providers.filter((p) => p.id === id)[0];
    const fields = (meta && meta.fields.length) ? meta.fields : (fallbackProviderFields(id) || []);
    if (!fields.length) {
      credsHost.appendChild(el('div', { class: 'notice', text: '未获取到该提供商的凭据说明（/ddns/providers 可能不可用）。' }));
      return;
    }
    for (const f of fields) {
      const node = input({
        type: f.secret ? 'password' : 'text',
        autocomplete: 'new-password',
        placeholder: f.placeholder || (editing ? '留空表示不修改' : ''),
        value: creds[f.key] || '',
      });
      credNodes.push({ key: f.key, node });
      credsHost.appendChild(field(f.label + (f.required ? ' *' : ''), node, f.help || ''));
    }
  }
  provider.addEventListener('change', rebuildCreds);
  rebuildCreds();

  function paintChallenge() {
    const isDNS = val(challenge) === 'dns-01';
    provider.parentNode.parentNode.style.display = isDNS ? '' : 'none';
    resolvers.parentNode.parentNode.style.display = isDNS ? '' : 'none';
    credsHost.style.display = isDNS ? '' : 'none';
  }
  challenge.addEventListener('change', paintChallenge);
  paintChallenge();

  openModal({
    title: editing ? '编辑证书任务' : '新建证书任务',
    body: el('div', {},
      el('div', { class: 'notice', text: '泛域名（*.example.com）必须使用 DNS-01 挑战并配置对应 DNS 提供商凭据；签发在后台异步进行，可在列表中查看进度。' }),
      fieldSet('任务', [
        field('名称', name),
        field('启用', enable),
        field('域名', domains, '每行一个', true),
        field('密钥类型', keyType),
        field('挑战方式', challenge),
        field('续期提前天数', renewDays),
      ]),
      fieldSet('DNS 挑战', [
        field('DNS 提供商', provider, '用于自动添加 TXT 记录'),
        field('解析服务器', resolvers, '校验时使用的 DNS 服务器'),
        field('凭据', credsHost, '', true),
      ]),
      fieldSet('其他', [field('备注', remark, '', true)]),
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          if (!val(name)) { toast('请填写任务名称', 'warn'); return false; }
          const list = lines(domains);
          if (!list.length) { toast('请至少填写一个域名', 'warn'); return false; }
          if (val(challenge) === 'dns-01' && !val(provider)) { toast('DNS-01 挑战需要选择 DNS 提供商', 'warn'); return false; }
          const outCreds = Object.assign({}, creds);
          for (const c of credNodes) {
            const v = val(c.node);
            if (v) outCreds[c.key] = v;
          }
          const payload = {
            name: val(name),
            enable: checked(enable),
            domains: list,
            keyType: val(keyType),
            challenge: val(challenge) || 'http-01',
            dnsProvider: val(provider),
            dnsCreds: outCreds,
            dnsResolvers: lines(resolvers),
            renewDays: numOf(renewDays, 30),
            remark: val(remark),
          };
          try {
            if (editing) await api.put('/acme/jobs/' + encodeURIComponent(base.id), payload);
            else await api.post('/acme/jobs', payload);
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

function issueJob(job, ctx, reload) {
  const view = el('div', {},
    el('div', { class: 'notice', text: '签发在后台异步执行：DNS-01 需要等待 TXT 记录生效，通常需要几十秒到几分钟。' }),
    el('div', { class: 'loading' }, el('span', { class: 'spacerin' }), el('span', { text: '正在提交签发请求…' })),
  );
  let stopPoll = null;
  let done = false;
  const logBox = el('div', { class: 'scroll' });

  function finish(msg, kind) {
    done = true;
    if (stopPoll) stopPoll();
    clear(view);
    view.appendChild(el('div', { class: 'notice', text: msg }));
    view.appendChild(el('div', { style: 'height:8px' }));
    view.appendChild(el('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => m.close() }));
    toast(msg, kind || 'ok');
    reload();
  }

  const m = openModal({
    title: '签发证书 - ' + (job.name || job.id),
    body: view,
    onClose: () => { if (stopPoll) stopPoll(); },
    actions: [{ label: '后台执行', kind: 'ghost' }],
  });

  async function poll() {
    if (done) return;
    try {
      const data = await api.get('/acme/certificates');
      const list = unwrap(data, ['certificates', 'items']);
      const want = (job.domains || []).map((d) => String(d).replace(/^\*\./, ''));
      const hit = list.filter((c) => {
        const ds = certDomains(c).map((d) => String(d).replace(/^\*\./, ''));
        return want.length && want.every((d) => ds.indexOf(d) >= 0);
      })[0];
      clear(logBox);
      if (hit) {
        logBox.appendChild(kv([
          ['域名', certDomains(hit).join(', ')],
          ['签发者', hit.issuer || hit.ca || '-'],
          ['到期时间', fmtTime(certExpiry(hit))],
          ['剩余', String(certRemainDays(hit)) + ' 天'],
        ]));
        finish('证书已签发：' + (certDomains(hit).join(', ') || '') , 'ok');
        return;
      }
      logBox.appendChild(el('div', { class: 'muted', text: '已等待 ' + Math.round(waited / 1000) + ' 秒，尚未在证书列表中看到该域名…' }));
    } catch (e) {
      clear(logBox);
      logBox.appendChild(errorCard(e, null));
    }
  }

  let waited = 0;
  (async () => {
    try {
      const res = await api.post('/acme/jobs/' + encodeURIComponent(job.id) + '/issue');
      const data = res || {};
      clear(view);
      view.appendChild(el('div', { class: 'notice', text: data.message || '签发请求已提交，正在等待结果…' }));
      view.appendChild(el('div', { class: 'muted', style: 'font-size:12px', text: '每 5 秒刷新一次证书列表。' }));
      view.appendChild(el('div', { style: 'height:8px' }));
      view.appendChild(logBox);
    } catch (e) {
      finish('签发失败：' + apiErr(e), 'error');
      return;
    }
    stopPoll = makePoller(() => { waited += 5000; return poll(); }, 5000);
    poll();
  })();
}

function openUpload(ctx, reload) {
  const domains = input({ placeholder: '证书包含的域名，逗号分隔，例如 example.com,*.example.com' });
  const name = input({ placeholder: '名称（可选）' });
  const certArea = textarea({ class: 'input pacme-area', placeholder: '-----BEGIN CERTIFICATE-----' + LF + '（把证书全文粘贴到这里）' });
  const keyArea = textarea({ class: 'input pacme-area', placeholder: '-----BEGIN PRIVATE KEY-----' + LF + '（把私钥全文粘贴到这里）' });
  const chainArea = textarea({ rows: '3', placeholder: '中间证书链（可选）' });

  function bindFile(btn, target) {
    const picker = el('input', { type: 'file', accept: '.pem,.crt,.cer,.key,.txt', style: 'display:none' });
    picker.addEventListener('change', () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { target.value = String(reader.result || ''); toast('已读取文件 ' + file.name, 'ok'); };
      reader.onerror = () => toast('读取文件失败', 'error');
      reader.readAsText(file);
    });
    btn.addEventListener('click', () => picker.click());
    return picker;
  }

  const certPick = el('button', { class: 'btn btn-sm', type: 'button', text: '选择文件…' });
  const keyPick = el('button', { class: 'btn btn-sm', type: 'button', text: '选择文件…' });
  const certPicker = bindFile(certPick, certArea);
  const keyPicker = bindFile(keyPick, keyArea);

  openModal({
    title: '上传证书',
    body: el('div', {},
      el('div', { class: 'notice', text: '用于导入自签名或第三方签发的证书；证书与私钥必须匹配。' }),
      fieldSet('证书信息', [
        field('名称', name),
        field('域名', domains, '逗号或换行分隔', true),
      ]),
      fieldSet('证书内容', [
        field('证书（PEM）', el('div', {}, el('div', { class: 'bar', style: 'margin-bottom:4px' }, certPick, certPicker), certArea), '', true),
        field('私钥（PEM）', el('div', {}, el('div', { class: 'bar', style: 'margin-bottom:4px' }, keyPick, keyPicker), keyArea), '', true),
        field('证书链（可选）', chainArea, '', true),
      ]),
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '上传', kind: 'primary',
        onClick: async () => {
          if (!val(certArea)) { toast('请粘贴或选择证书文件', 'warn'); return false; }
          if (!val(keyArea)) { toast('请粘贴或选择私钥文件', 'warn'); return false; }
          const list = val(domains).split(/[\s,]+/).filter((s) => s.length > 0);
          const payload = {
            name: val(name),
            domains: list,
            cert: val(certArea),
            certificate: val(certArea),
            key: val(keyArea),
            privateKey: val(keyArea),
            chain: val(chainArea),
          };
          try {
            await api.post('/acme/certificates/upload', payload);
            toast('上传成功', 'ok');
            reload();
          } catch (e) {
            toast('上传失败：' + apiErr(e), 'error');
            return false;
          }
        },
      },
    ],
  });
}

export default {
  id: 'acme',
  title: '证书',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    const jobsBox = el('div', {});
    const certsBox = el('div', {});
    let providers = [];

    async function toggleJob(job, next) {
    const want = (next === undefined) ? !job.enable : !!next;
      try {
        await api.post('/acme/jobs/' + encodeURIComponent(job.id) + '/toggle');
      } catch (e) {
        try {
          await api.put('/acme/jobs/' + encodeURIComponent(job.id), Object.assign({}, job, { enable: want }));
        } catch (e2) {
          toast('切换失败：' + apiErr(e2), 'error');
          return false;
        }
      }
      toast(want ? '已启用' : '已停用', 'ok');
      loadJobs();
    }

    const jobColumns = [
      { title: '名称', render: (j) => el('div', {}, el('div', { text: j.name || j.id }), j.remark ? el('div', { class: 'muted', style: 'font-size:11px', text: j.remark }) : null) },
      { title: '域名', render: (j) => chips(j.domains, 2) },
      { title: '挑战', render: (j) => badge(CHALLENGE_LABEL[j.challenge] || j.challenge || '-') },
      { title: 'DNS 提供商', render: (j) => (j.dnsProvider ? badge(j.dnsProvider) : el('span', { class: 'muted', text: '-' })) },
      { title: '密钥', render: (j) => textOf(KEY_LABEL[j.keyType] || j.keyType || '默认') },
      { title: '续期提前', cls: 'num', render: (j) => textOf((j.renewDays || 30) + ' 天') },
      { title: '状态', render: (j) => switchEl(!!j.enable, (next) => toggleJob(j, next)) },
      { title: '', cls: 'acts', render: (j) => el('span', {},
        btn('签发', { small: true, kind: 'primary', tag: 'issue', onClick: () => issueJob(j, ctx, loadAll) }),
        iconBtn(editIcon(), { title: '编辑', tag: 'edit', onClick: () => openJobForm(j, providers, ctx, loadJobs) }),
        iconBtn(trashIcon(), { title: '删除', tag: 'remove', onClick: () => removeJob(j) }),
      ) },
    ];

    async function removeJob(job) {
      const ok = await confirmDialog('确定删除证书任务「' + (job.name || job.id) + '」吗？已签发的证书不会被删除。');
      if (!ok) return;
      try {
        await api.del('/acme/jobs/' + encodeURIComponent(job.id));
        toast('已删除', 'ok');
        loadJobs();
      } catch (e) {
        toast('删除失败：' + apiErr(e), 'error');
      }
    }

    const certColumns = [
      { title: '域名', render: (c) => { const d = certDomains(c); return d.length ? chips(d, 3) : el('span', { class: 'muted', text: c.name || c.id || '-' }); } },
      { title: '签发者', render: (c) => textOf(c.issuer || c.ca || c.issuerCN || '-') },
      { title: '到期时间', render: (c) => el('div', {}, el('div', { text: fmtTime(certExpiry(c)) }), el('div', { class: 'muted', style: 'font-size:11px', text: certExpiry(c) ? dateAgo(certExpiry(c)) + ' 到期' : '' })) },
      { title: '剩余天数', render: (c) => daysBar(certRemainDays(c)) },
      { title: '来源', render: (c) => badge(c.source || c.type || (c.uploaded ? '手动上传' : 'ACME')) },
      { title: '', cls: 'acts', render: (c) => el('span', {},
        iconBtn(trashIcon(), { title: '删除证书', tag: 'remove', onClick: () => removeCert(c) }),
      ) },
    ];

    async function removeCert(c) {
      const label = certDomains(c).join(', ') || c.name || c.id;
      const ok = await confirmDialog('确定删除证书「' + label + '」吗？使用该证书的站点会失去 TLS。');
      if (!ok) return;
      try {
        await api.del('/acme/certificates/' + encodeURIComponent(c.id || c.name));
        toast('已删除', 'ok');
        loadCerts();
      } catch (e) {
        toast('删除失败：' + apiErr(e), 'error');
      }
    }

    async function loadJobs() {
      clear(jobsBox);
      jobsBox.appendChild(spinner('正在加载证书任务…'));
      try {
        const data = await api.get('/acme/jobs');
        const list = unwrap(data, ['jobs', 'items']);
        clear(jobsBox);
        jobsBox.appendChild(dataTable(jobColumns, list.map((j) => ({ raw: j, tag: j.id })), '还没有证书任务，点击右上角“新建任务”开始'));
      } catch (e) {
        clear(jobsBox);
        jobsBox.appendChild(errorCard(e, () => loadJobs()));
      }
    }

    async function loadCerts() {
      clear(certsBox);
      certsBox.appendChild(spinner('正在加载证书…'));
      try {
        const data = await api.get('/acme/certificates');
        const list = unwrap(data, ['certificates', 'items']);
        clear(certsBox);
        certsBox.appendChild(dataTable(certColumns, list.map((c) => ({ raw: c, tag: c.id || c.name })), '暂无已签发的证书'));
      } catch (e) {
        clear(certsBox);
        certsBox.appendChild(errorCard(e, () => loadCerts()));
      }
    }

    function loadAll() { loadJobs(); loadCerts(); }

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '证书任务' }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadAll() }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '新建任务', onclick: () => openJobForm(null, providers, ctx, loadJobs) }),
      ),
      el('div', { class: 'card-body' }, jobsBox),
    ));
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '证书列表' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: '剩余天数按 90 天有效期估算进度' }),
        el('button', { class: 'btn', type: 'button', text: '上传证书', onclick: () => openUpload(ctx, loadCerts) }),
      ),
      el('div', { class: 'card-body' }, certsBox),
    ));

    loadDNSProviders().then((list) => { providers = list; });
    loadAll();
    return () => { offStyle(); };
  },
};