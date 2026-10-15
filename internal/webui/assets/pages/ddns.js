// nunt 前端页面模块：ddns.js
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
// 动态域名：提供商（DNS API）凭据 + 规则 + 运行状态
// ---------------------------------------------------------------------------
const RECORD_TYPES = ['A', 'AAAA', 'A_AND_AAAA'];
const MODE_LABEL = { interface: '网卡', url: '通过 URL 获取', static: '静态地址' };
const PAGE_CSS = [
  '.pddns-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pddns-search{width:200px}',
  '.pddns-creds{margin-top:4px}',
  '.pddns-ip{font-family:ui-monospace,Consolas,monospace}',
].join(String.fromCharCode(10));

function ipModeOptions(value) {
  return selectEl([
    { value: 'interface', label: '网卡地址（本机接口）' },
    { value: 'url', label: '通过 URL 获取公网 IP' },
    { value: 'static', label: '静态地址（不自动更新）' },
  ], value || 'url');
}

function recordTypeOptions(value) {
  return selectEl([
    { value: 'A', label: 'A（IPv4）' },
    { value: 'AAAA', label: 'AAAA（IPv6）' },
    { value: 'A_AND_AAAA', label: 'A + AAAA（同时更新）' },
  ], value || 'A');
}

function ipBlock(legend, base) {
  const g = base || {};
  const host = el('div', {});
  const enable = checkEl('启用', !!g.enable);
  const mode = ipModeOptions(g.mode);
  const dynamic = el('div', { class: 'grid' });
  function paint() {
    clear(dynamic);
    const m = val(mode);
    if (m === 'url') {
      const url = input({ value: g.value || '', placeholder: 'https://api.ipify.org' });
      const regex = input({ value: g.regex || '', placeholder: '可选：从响应中提取 IP 的正则' });
      dynamic.__url = url; dynamic.__regex = regex; dynamic.__iface = null;
      dynamic.appendChild(field('获取地址', url, '返回纯文本 IP 的接口'));
      dynamic.appendChild(field('提取正则', regex, '留空则直接使用响应内容'));
    } else if (m === 'interface') {
      const iface = input({ value: g.iface || '', placeholder: 'eth0 / en0 / 以太网' });
      dynamic.__iface = iface; dynamic.__url = null; dynamic.__regex = null;
      dynamic.appendChild(field('网卡名称', iface, '留空自动选择默认网卡'));
    } else {
      const value = input({ value: g.value || '', placeholder: '1.2.3.4 或 2001:db8::1' });
      dynamic.__iface = null; dynamic.__url = null; dynamic.__regex = null;
      dynamic.__staticValue = value;
      dynamic.appendChild(field('静态地址', value));
    }
  }
  mode.addEventListener('change', paint);
  paint();
  host.appendChild(fieldSet(legend, [field('状态', enable), field('获取方式', mode)]));
  host.appendChild(dynamic);
  return {
    node: host,
    collect: () => {
      const m = val(mode);
      return {
        enable: checked(enable),
        mode: m,
        value: m === 'url' ? (dynamic.__url ? val(dynamic.__url) : '') : (dynamic.__staticValue ? val(dynamic.__staticValue) : ''),
        iface: m === 'interface' && dynamic.__iface ? val(dynamic.__iface) : '',
        regex: m === 'url' && dynamic.__regex ? val(dynamic.__regex) : '',
      };
    },
  };
}

function openRuleForm(rule, providers, ctx, reload) {
  const base = rule || {};
  const editing = !!base.id;
  const creds = Object.assign({}, base.creds || {});
  const name = input({ value: base.name || '', placeholder: '例如 家里宽带' });
  const enable = checkEl('启用该规则', base.enable !== false);
  const provider = selectEl(
    (providers.length ? providers.map((p) => ({ value: p.id, label: p.title })) : [{ value: base.provider || '', label: base.provider || '（未获取到提供商列表）' }]),
    base.provider || (providers[0] && providers[0].id) || '',
  );
  const domain = input({ value: base.domain || '', placeholder: 'example.com' });
  const subdomains = textarea({ rows: '3', placeholder: '每行一个子域名，主域名用 @：' + LF + '@' + LF + 'www' + LF + '*', value: (base.subDomains || []).join(LF) });
  const recordType = recordTypeOptions(base.recordType);
  const ttl = input({ type: 'number', min: '0', value: String(base.ttl || 0), placeholder: '0 表示默认' });
  const interval = input({ type: 'number', min: '0', value: String(base.intervalSec || 0), placeholder: '例如 300' });
  const cron = input({ value: base.cron || '', placeholder: '例如 */5 * * * *（与间隔二选一）' });
  const remark = input({ value: base.remark || '', placeholder: '备注（可选）' });
  const credsHost = el('div', {});
  let credNodes = [];

  function providerMeta(id) {
    for (const p of providers) if (p.id === id) return p;
    return null;
  }

  function rebuildCreds() {
    clear(credsHost);
    credNodes = [];
    const id = val(provider);
    const meta = providerMeta(id);
    const fields = (meta && meta.fields.length) ? meta.fields : (fallbackProviderFields(id) || []);
    if (!fields.length) {
      credsHost.appendChild(el('div', { class: 'notice', text: '未获取到该提供商的凭据说明（/ddns/providers 可能不可用）。可先在“设置”里确认 DNS 提供商是否已注册。' }));
      return;
    }
    const box = el('div', { class: 'grid pddns-creds' });
    for (const f of fields) {
      const node = input({
        type: f.secret ? 'password' : 'text',
        autocomplete: 'new-password',
        placeholder: f.placeholder || (editing ? '留空表示不修改' : ''),
        value: creds[f.key] || '',
        'data-secret': f.secret ? '1' : '0',
      });
      credNodes.push({ key: f.key, node, secret: f.secret });
      box.appendChild(field(f.label + (f.required ? ' *' : ''), node, f.help || (f.secret ? '密钥不会明文回显，留空表示不修改' : '')));
    }
    credsHost.appendChild(fieldSet('提供商凭据', [box]));
    if (meta && meta.authNote) credsHost.appendChild(el('div', { class: 'notice', text: meta.authNote }));
    const cb = base.callback || {};
    const cbEnable = checkEl('使用自定义回调（自定义域名商）', !!(cb && cb.enable));
    const cbURL = input({ value: cb.url || '', placeholder: 'https://example.com/update' });
    const cbMethod = selectEl([{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }], (cb.method || 'GET').toUpperCase());
    const cbHeaders = textarea({ rows: '2', placeholder: '每行一条 key: value', value: kvText(cb.headers) });
    const cbBody = textarea({ rows: '2', placeholder: '请求体模板（POST 时使用）', value: cb.body || '' });
    const cbUser = input({ value: cb.basicUser || '', placeholder: 'BasicAuth 用户名（可选）' });
    const cbPass = input({ type: 'password', autocomplete: 'new-password', placeholder: '留空表示不修改' });
    const cbHost = el('div', {});
    function paintCB() {
      clear(cbHost);
      if (!checked(cbEnable)) return;
      cbHost.appendChild(el('div', { class: 'grid' },
        field('回调地址', cbURL, '', true),
        field('方法', cbMethod),
        field('请求头', cbHeaders),
        field('请求体', cbBody, '', true),
        field('用户名', cbUser),
        field('密码', cbPass),
      ));
    }
    cbEnable.querySelector('input').addEventListener('change', paintCB);
    paintCB();
    credsHost.appendChild(fieldSet('自定义回调', [field('', cbEnable), cbHost]));
    credsHost.__callback = () => (checked(cbEnable) ? {
      enable: true,
      url: val(cbURL),
      method: val(cbMethod) || 'GET',
      headers: keyValues(cbHeaders),
      body: val(cbBody),
      basicUser: val(cbUser),
      basicPass: val(cbPass),
      contentType: '',
      successCode: (base.callback && base.callback.successCode) || [],
    } : null);
  }

  provider.addEventListener('change', rebuildCreds);
  rebuildCreds();

  const v4 = ipBlock('IPv4（A 记录）', base.ipv4);
  const v6 = ipBlock('IPv6（AAAA 记录）', base.ipv6);

  openModal({
    title: editing ? '编辑 DDNS 规则' : '新建 DDNS 规则',
    body: el('div', {},
      el('div', { class: 'notice', text: '凭据表单由 /api/v1/ddns/providers 的元数据动态生成；密钥类字段不会明文回显，留空表示保持原值。' }),
      fieldSet('基本信息', [
        field('名称', name),
        field('提供商', provider, providers.length ? '' : '未能获取提供商列表，已回退为手工输入'),
        field('启用', enable),
      ]),
      credsHost,
      fieldSet('记录', [
        field('主域名', domain, '例如 example.com'),
        field('子域名', subdomains, '每行一个，@ 表示主域名', true),
        field('记录类型', recordType),
        field('TTL（秒）', ttl),
        field('检查间隔（秒）', interval),
        field('Cron 表达式', cron, '填写后优先使用 cron'),
        field('备注', remark, '', true),
      ]),
      v4.node,
      v6.node,
    ),
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '保存', kind: 'primary',
        onClick: async () => {
          if (!val(name)) { toast('请填写规则名称', 'warn'); return false; }
          if (!val(provider)) { toast('请选择 DNS 提供商', 'warn'); return false; }
          if (!val(domain)) { toast('请填写主域名', 'warn'); return false; }
          const outCreds = Object.assign({}, creds);
          for (const c of credNodes) {
            const v = val(c.node);
            if (v) outCreds[c.key] = v;
          }
          const payload = {
            name: val(name),
            enable: checked(enable),
            provider: val(provider),
            creds: outCreds,
            domain: val(domain),
            subDomains: lines(subdomains),
            recordType: val(recordType) || 'A',
            ttl: numOf(ttl, 0),
            intervalSec: numOf(interval, 0),
            cron: val(cron),
            ipv4: v4.collect(),
            ipv6: v6.collect(),
            callback: credsHost.__callback ? credsHost.__callback() : (base.callback || null),
            remark: val(remark),
          };
          try {
            if (editing) await api.put('/ddns/rules/' + encodeURIComponent(base.id), payload);
            else await api.post('/ddns/rules', payload);
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

function statusOf(map, id) {
  if (!map) return null;
  if (Array.isArray(map)) return map.filter((x) => x && (x.id === id || x.ruleId === id))[0] || null;
  return map[id] || null;
}

function statusPairs(st) {
  const s = st || {};
  return [
    ['当前 IP', el('span', { class: 'pddns-ip', text: statusIP(s) })],
    ['上次更新', fmtTime(s.lastUpdate || s.updatedAt || s.lastRun)],
    ['下次执行', fmtTime(s.nextRun || s.next)],
    ['成功 / 失败', String(s.success || s.successCount || 0) + ' / ' + String(s.fail || s.failCount || 0)],
    ['消息', s.message || s.lastError || s.error || '-'],
  ];
}

function statusIP(s) {
  const st = s || {};
  const v4 = st.ip || st.currentIp || st.ipv4 || '';
  const v6 = st.ipv6 || '';
  const both = [v4, v6].filter((x) => x).join(' / ');
  return both || '-';
}

function statusLogs(st) {
  const s = st || {};
  const logs = s.logs || s.history || [];
  if (!logs.length) return emptyBox('暂无最近日志');
  return logView(logs.map((item) => {
    if (typeof item === 'string') return item;
    const ok = item.ok === false || item.success === false || item.error;
    return fmtTime(item.time || item.ts || item.at) + '  ' + (ok ? '[失败] ' : '[成功] ') + (item.message || item.error || item.ip || JSON.stringify(item));
  }), 200);
}

function openStatus(rule, st) {
  const view = el('div', {}, spinner('正在加载状态…'));
  const draw = (data) => {
    clear(view);
    view.appendChild(kv(statusPairs(data)));
    view.appendChild(el('div', { style: 'height:10px' }));
    view.appendChild(statusLogs(data));
  };
  draw(st);
  if (!st) loadStatus(rule.id).then(draw).catch((e) => { clear(view); view.appendChild(errorCard(e, () => openStatus(rule, null))); });
  openModal({ title: '运行状态 - ' + (rule.name || rule.id), body: view, actions: [{ label: '关闭', kind: 'ghost' }] });
}

async function loadStatus(id) {
  const data = await api.get('/ddns/status');
  const st = statusOf(data && (data.rules || data.status || data), id) || (data && data[id]);
  if (!st && data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data.status || data.rules || data;
    return statusOf(inner, id) || {};
  }
  return st || {};
}

export default {
  id: 'ddns',
  title: '动态域名',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M3 21l4-4M3 21h5v-5"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    const state = { q: '', rules: [], status: null, providers: [] };
    const bodyBox = el('div', {});
    const statusBox = el('div', {});

    async function toggle(rule, next) {
    const want = (next === undefined) ? !rule.enable : !!next;
      try {
        await api.post('/ddns/rules/' + encodeURIComponent(rule.id) + '/toggle');
      } catch (e) {
        try {
          await api.put('/ddns/rules/' + encodeURIComponent(rule.id), Object.assign({}, rule, { enable: want }));
        } catch (e2) {
          toast('切换失败：' + apiErr(e2), 'error');
          return false;
        }
      }
      toast(want ? '已启用' : '已停用', 'ok');
      load();
    }

    async function remove(rule) {
      const ok = await confirmDialog('确定删除 DDNS 规则「' + (rule.name || rule.id) + '」吗？');
      if (!ok) return;
      try {
        await api.del('/ddns/rules/' + encodeURIComponent(rule.id));
        toast('已删除', 'ok');
        load();
      } catch (e) {
        toast('删除失败：' + apiErr(e), 'error');
      }
    }

    async function runNow(rule) {
      const t = toast('正在执行「' + (rule.name || rule.id) + '」…', 'info');
      try {
        const res = await api.post('/ddns/rules/' + encodeURIComponent(rule.id) + '/run');
        const data = res || {};
        const ip = data.ip || data.currentIp || data.addr || (data.ipv4 ? data.ipv4 + (data.ipv6 ? ' / ' + data.ipv6 : '') : '');
        if (data.ok === false || data.success === false || data.error) {
          toast('执行失败：' + (data.error || data.message || '未知错误'), 'error');
        } else {
          toast('执行成功' + (ip ? '：当前 IP ' + ip : ''), 'ok');
        }
      } catch (e) {
        toast('执行失败：' + apiErr(e), 'error');
      }
      load();
    }

    const columns = [
      { title: '名称', render: (r) => el('div', {}, el('div', { text: r.name || r.id }), el('div', { class: 'muted mono', text: r.domain || '-' })) },
      { title: '提供商', render: (r) => badge(r.provider || '-') },
      { title: '子域名', render: (r) => chips(r.subDomains, 3) },
      { title: '类型', render: (r) => badge(r.recordType || 'A') },
      { title: '当前 IP', render: (r) => {
        const st = statusOf(state.status, r.id);
        const ip = st && (st.ip || st.currentIp || st.ipv4);
        return el('span', { class: 'mono', text: ip || '-' });
      } },
      { title: '上次更新', render: (r) => {
        const st = statusOf(state.status, r.id);
        return el('span', { class: 'muted', text: st ? dateAgo(st.lastUpdate || st.updatedAt || st.lastRun) : '-' });
      } },
      { title: '成功/失败', cls: 'num', render: (r) => {
        const st = statusOf(state.status, r.id) || {};
        return el('span', {}, badge(String(st.success || st.successCount || 0), 'ok'), el('span', { text: ' ' }), badge(String(st.fail || st.failCount || 0), (st.fail || st.failCount) ? 'err' : ''));
      } },
      { title: '状态', render: (r) => switchEl(!!r.enable, (next) => toggle(r, next)) },
      { title: '', cls: 'acts', render: (r) => el('span', {},
        iconBtn(runIcon(), { title: '立即执行', tag: 'run', onClick: () => runNow(r) }),
        iconBtn(logIcon(), { title: '状态与日志', tag: 'status', onClick: () => openStatus(r, statusOf(state.status, r.id)) }),
        iconBtn(editIcon(), { title: '编辑', tag: 'edit', onClick: () => openRuleForm(r, state.providers, ctx, load) }),
        iconBtn(trashIcon(), { title: '删除', tag: 'remove', onClick: () => remove(r) }),
      ) },
    ];

    function filtered() {
      const q = state.q.trim().toLowerCase();
      if (!q) return state.rules;
      return state.rules.filter((r) => [r.name, r.domain, r.provider, (r.subDomains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0);
    }

    function paint() {
      clear(bodyBox);
      const rows = filtered().map((r) => ({ raw: r, tag: r.id }));
      if (!rows.length) {
        bodyBox.appendChild(emptyBox(state.rules.length ? '没有符合条件的规则' : '还没有 DDNS 规则，点击右上角“新建规则”开始'));
        return;
      }
      bodyBox.appendChild(dataTable(columns, rows, '暂无规则'));
    }

    async function loadStatusBox() {
      clear(statusBox);
      statusBox.appendChild(spinner('正在加载状态…'));
      try {
        const data = await api.get('/ddns/status');
        state.status = data && (data.rules || data.status) ? (data.rules || data.status) : data;
        clear(statusBox);
        if (Array.isArray(state.status)) {
          if (!state.status.length) { statusBox.appendChild(emptyBox('暂无状态信息')); return; }
          statusBox.appendChild(el('div', { class: 'scroll' }, el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', { text: '规则' }), el('th', { text: '当前 IP' }), el('th', { text: '上次更新' }),
              el('th', { text: '成功' }), el('th', { text: '失败' }), el('th', { text: '消息' }))),
            el('tbody', {}, state.status.map((s) => el('tr', {},
              el('td', { text: s.name || s.id || s.ruleId || '-' }),
              el('td', { class: 'mono', text: s.ip || s.currentIp || '-' }),
              el('td', { text: fmtTime(s.lastUpdate || s.updatedAt || s.lastRun) }),
              el('td', { text: String(s.success || s.successCount || 0) }),
              el('td', { text: String(s.fail || s.failCount || 0) }),
              el('td', { class: 'muted', text: s.message || s.error || '-' }),
            ))),
          )));
          return;
        }
        if (!state.status || typeof state.status !== 'object') { statusBox.appendChild(emptyBox('暂无状态信息')); return; }
        const keys = Object.keys(state.status);
        if (!keys.length) { statusBox.appendChild(emptyBox('暂无状态信息')); return; }
        statusBox.appendChild(el('div', { class: 'scroll' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: '规则' }), el('th', { text: '当前 IP' }), el('th', { text: '上次更新' }),
            el('th', { text: '成功' }), el('th', { text: '失败' }), el('th', { text: '消息' }))),
          el('tbody', {}, keys.map((k) => {
            const s = state.status[k] || {};
            return el('tr', {},
              el('td', { text: s.name || k }),
              el('td', { class: 'mono', text: s.ip || s.currentIp || '-' }),
              el('td', { text: fmtTime(s.lastUpdate || s.updatedAt || s.lastRun) }),
              el('td', { text: String(s.success || s.successCount || 0) }),
              el('td', { text: String(s.fail || s.failCount || 0) }),
              el('td', { class: 'muted', text: s.message || s.error || '-' }),
            );
          })),
        )));
      } catch (e) {
        clear(statusBox);
        statusBox.appendChild(errorCard(e, () => loadStatusBox()));
      }
    }

    async function load() {
      clear(bodyBox);
      bodyBox.appendChild(spinner('正在加载 DDNS 规则…'));
      try {
        const data = await api.get('/ddns/rules');
        state.rules = unwrap(data, ['rules', 'items']);
      } catch (e) {
        clear(bodyBox);
        bodyBox.appendChild(errorCard(e, () => load()));
        return;
      }
      paint();
      loadStatusBox();
    }

    const search = input({ class: 'input pddns-search', placeholder: '搜索名称/域名' });
    search.addEventListener('input', debounce(() => { state.q = search.value; paint(); }, 200));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: 'DDNS 规则' }),
        el('span', { class: 'grow' }),
        search,
        el('button', { class: 'btn', type: 'button', text: '刷新状态', onclick: () => loadStatusBox() }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '新建规则', onclick: () => openRuleForm(null, state.providers, ctx, load) }),
      ),
      el('div', { class: 'card-body' }, bodyBox),
    ));
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { text: '运行状态' }), el('span', { class: 'grow' }), el('span', { class: 'muted', style: 'font-size:12px', text: '来自 /api/v1/ddns/status' })),
      el('div', { class: 'card-body' }, statusBox),
    ));

    loadDNSProviders().then((list) => { state.providers = list; });
    load();
    return () => { offStyle(); };
  },
};