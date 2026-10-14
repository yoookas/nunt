// nunt 前端页面模块：waf.js
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
// WAF：引擎配置 + 规则列表 + 拦截日志 + 请求测试
// ---------------------------------------------------------------------------
const MODE_LABEL = { detect: '检测模式', block: '拦截模式' };
const PAGE_CSS = [
  '.pwaf-panel{margin-bottom:12px}',
  '.pwaf-scroll{max-height:300px;overflow:auto;border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:8px}',
  '.pwaf-rule{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px;border-bottom:1px solid rgba(127,127,127,.08)}',
  '.pwaf-rule span.pwaf-id{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted,#98a2b3);min-width:70px}',
  '.pwaf-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pwaf-search{width:190px}',
  '.pwaf-test{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:start}',
  '@media (max-width:760px){.pwaf-test{grid-template-columns:1fr}}',
  '.pwaf-result{margin-top:10px}',
  '.pwaf-states{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px}',
  '.pwaf-state{border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;background:var(--bg-soft,rgba(127,127,127,.06))}',
  '.pwaf-state .k{font-size:12px;color:var(--muted,#98a2b3)}',
  '.pwaf-state .v{font-size:17px;font-weight:600;line-height:1.1}',
  '.pwaf-state .s{font-size:11px;color:var(--muted,#98a2b3)}',
  '.pwaf-state.zero{opacity:.55}',
  '.pwaf-coverage{font-size:12px;margin-left:6px}',
  '.pwaf-warn{border-left:3px solid var(--warn,#d98b00)}',
  '.pwaf-err{border-left:3px solid var(--err,#e5484d)}',
  '.pwaf-sub{margin-top:12px}',
  '.pwaf-sub-title{font-size:13px;font-weight:600;margin:0 0 6px}',
  '.pwaf-hit-tag{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted,#98a2b3)}',
  '.pwaf-compat{font-size:12px;color:var(--muted,#98a2b3);margin-top:10px;line-height:1.6}',
  '.pwaf-filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
  '.pwaf-grpc{display:flex;flex-wrap:wrap;gap:6px}',
  '.pwaf-grpc-item{display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--border,#2a2f3a);border-radius:999px;padding:3px 10px;background:var(--bg-soft,rgba(127,127,127,.06));font-size:12px}',
  '.pwaf-grpc-item .k{color:var(--muted,#98a2b3)}',
  '.pwaf-grpc-item .v{font-weight:600;font-variant-numeric:tabular-nums}',
  '.pwaf-grpc-item.miss .v{font-weight:400;color:var(--muted,#98a2b3)}',
  '.pwaf-label{font-size:12px;color:var(--muted,#98a2b3);margin-top:2px}',
].join(String.fromCharCode(10));

function levelOptions(value, dflt) {
  return selectEl([1, 2, 3, 4].map((n) => ({ value: String(n), label: 'PL' + n })), String(value || dflt || 1));
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

function logColumns() {
  return [
    { title: '时间', render: (l) => el('span', { text: fmtTime(l.time || l.ts || l.at) }) },
    { title: '动作', render: (l) => { const act = (l.action || l.disruption || (l.blocked ? 'block' : 'detect')); return badge(String(act).toUpperCase(), String(act).indexOf('block') >= 0 || l.blocked ? 'err' : 'warn'); } },
    { title: '客户端', render: (l) => el('span', { class: 'mono', text: l.ip || l.clientIp || l.remoteAddr || '-' }) },
    { title: '请求', render: (l) => el('span', { class: 'mono', text: (l.method || '-') + ' ' + (l.path || l.uri || l.url || '-') }) },
    { title: '规则', render: (l) => chips(ruleIdsOf(l), 3) },
    { title: '说明', render: (l) => el('span', { class: 'muted', text: l.message || l.msg || l.reason || '-' }) },
  ];
}

function ruleIdsOf(l) {
  const v = l.rules || l.ruleIds || l.matched || l.ruleId || l.rule;
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? (x.id || x.ruleId || JSON.stringify(x)) : x));
  return [v];
}

// ---------------------------------------------------------------------------
// 请求体检查策略（PLAN-waf-body-policy.md §2 / §3 / §5）
//
// 字段名与后端 model.WAFConfig 冻结的 JSON tag 一致：
//   enforcementMode   observe | enforce（默认 observe）
//   defaultBodyPolicy full | peek | skip | grpc（默认 full）
//   peekBytes         默认 65536
//   peekTimeoutMs     默认 250
//   notifyBodyRatio   非 full 占比告警阈值，0–1（默认 0 = 关闭）
//
// 后端接口尚未落地这些字段时，本页面读取会退回到「未设置」并在页面上给出
// 明确提示，不会白屏；保存时也不会把后端不认识的值写回去（见 savePolicy）。
// ---------------------------------------------------------------------------

const POLICY_DEFAULTS = { enforcementMode: 'observe', defaultBodyPolicy: 'full', peekBytes: 65536, peekTimeoutMs: 250, notifyBodyRatio: 0 };
// 与 internal/config/validate.go 的边界一致：超出范围保存会被后端拒绝，
// 前端先拦一次并给出中文提示（defaultWAFPeekBytes / maxWAFPeekBytes、
// notifyBodyRatio 的 [0,1] 等）。
const POLICY_LIMITS = {
  peekBytes: { min: 0, max: 4 * 1024 * 1024, low: 1024 },
  peekTimeoutMs: { min: 0, max: 10000, low: 50 },
  notifyBodyRatio: { min: 0, max: 1 },
};

// 执行模式：observe 只记录「本应拒绝」，不真的拒绝。
const ENFORCEMENT_OPTIONS = [
  { value: 'observe', label: '观察模式（observe）：只记录，不拒绝' },
  { value: 'enforce', label: '强制模式（enforce）：真的拒绝' },
];
const ENFORCEMENT_LABEL = { observe: '观察', enforce: '强制' };

// 全局默认策略只允许 full | peek | skip | grpc（grpc 会按 gRPC 首消息路径处理）。
const DEFAULT_POLICY_OPTIONS = [
  { value: 'full', label: '全量（full，fail-closed：形态上无法完整检查就拒绝）' },
  { value: 'peek', label: '偷看（peek，只检查前 PeekBytes 字节）' },
  { value: 'skip', label: '跳过（skip，只查 URI / 请求头）' },
  { value: 'grpc', label: 'gRPC（grpc，Content-Type 为 application/grpc* 时走首消息路径）' },
];
const DEFAULT_POLICY_SHORT = { full: '全量 full', peek: '偷看 peek', skip: '跳过 skip', grpc: 'gRPC grpc' };

// bodyState 的完整取值集合（缺项的按 0 展示，便于确认后端是否在计数）。
const BODY_STATE_KEYS = [
  { key: 'full', label: '全量检查', desc: '完整检查后转发' },
  { key: 'peeked', label: '部分检查', desc: '读满 PeekBytes / 超时' },
  { key: 'skipped', label: '声明跳过', desc: '只查 URI / 请求头' },
  { key: 'grpc-unary', label: 'gRPC 单消息', desc: '首消息 + EOF 完成判定' },
  { key: 'grpc-stream', label: 'gRPC 流式', desc: '只查首消息 + 帧校验' },
  { key: 'grpc-server-first', label: '服务端先说话', desc: '首消息等待超时后放行' },
  { key: 'frame-error', label: '帧错误', desc: '畸形 / 超长 / 截断帧' },
];
const BODY_STATE_ALIASES = {
  full: ['full', 'fullBody'],
  peeked: ['peeked', 'peek'],
  skipped: ['skipped', 'skip'],
  'grpc-unary': ['grpc-unary', 'grpcUnary', 'grpc_unary'],
  'grpc-stream': ['grpc-stream', 'grpcStream', 'grpc_stream'],
  'grpc-server-first': ['grpc-server-first', 'grpcServerFirst', 'grpc_server_first', 'serverFirst'],
  'frame-error': ['frame-error', 'frameError', 'frame_error', 'frameErrors'],
};
const NON_FULL_STATES = ['peeked', 'skipped', 'grpc-stream', 'grpc-server-first', 'frame-error'];

// FIELD_ALIASES 是「同一个语义字段的多种后端命名」兜底表：后端把字段放在
// config / stats / policy 任意一层、或换个写法时都能读到（命中未知命名会在
// 页面上注明，避免误以为数据缺失）。
const FIELD_ALIASES = {
  enforcementMode: ['enforcementMode', 'EnforcementMode', 'mode'],
  defaultBodyPolicy: ['defaultBodyPolicy', 'DefaultBodyPolicy', 'bodyPolicy'],
  peekBytes: ['peekBytes', 'PeekBytes', 'peekSize', 'peekLimit'],
  peekTimeoutMs: ['peekTimeoutMs', 'PeekTimeoutMS', 'PeekTimeoutMs', 'peekTimeout'],
  notifyBodyRatio: ['notifyBodyRatio', 'NotifyBodyRatio'],
  bodyState: ['bodyState', 'bodyStates', 'bodyStateCounts', 'bodyStateDist', 'bodyStateDistribution'],
  wouldReject: ['wouldReject', 'wouldRejects', 'wouldRejectSamples', 'wouldRejectList', 'wouldRejectItems', 'wouldRejectRecent', 'wouldRejectLog', 'wouldRejectCount'],
  undeclared: ['undeclaredRoutes', 'undeclaredBodyPolicyRoutes', 'undeclaredBodyPolicy', 'undeclared', 'missingBodyPolicy', 'routesWithoutBodyPolicy', 'unclaimedRoutes', 'inheritedRoutes'],
};

// COUNTER_FIELDS 是 stats.* 里请求体与拒绝计数的契约名（附 snake_case 兜底）。
// 只有真正的数字才会命中：根级 wouldReject 是样例数组，不能被当成计数。
const COUNTER_FIELDS = {
  bodyRequests: ['bodyRequests', 'body_requests'],
  bodyFull: ['bodyFull', 'body_full'],
  bodyNonFull: ['bodyNonFull', 'body_non_full'],
  bodyNonFullRatio: ['bodyNonFullRatio', 'body_non_full_ratio'],
  wouldReject: ['wouldReject', 'would_reject'],
  refused: ['refused'],
  wouldRejectKept: ['wouldRejectKept', 'would_reject_kept'],
  wouldRejectLimit: ['wouldRejectLimit', 'would_reject_limit'],
};

// GRPC_COUNTER_FIELDS 是 stats.grpc* 的契约名。
const GRPC_COUNTER_FIELDS = {
  grpcRequests: ['grpcRequests', 'grpc_requests'],
  grpcUnary: ['grpcUnary', 'grpc_unary'],
  grpcStream: ['grpcStream', 'grpc_stream'],
  grpcServerFirst: ['grpcServerFirst', 'grpc_server_first'],
  grpcFrameErrors: ['grpcFrameErrors', 'grpc_frame_errors'],
  grpcSecondMessage: ['grpcSecondMessage', 'grpc_second_message'],
  grpcMessages: ['grpcMessages', 'grpc_messages'],
  grpcCompressed: ['grpcCompressed', 'grpc_compressed'],
};

// GRPC_METRIC_KEYS 是策略卡片里 gRPC 统计行的展示项（缺失时显示 —）。
const GRPC_METRIC_KEYS = [
  { key: 'grpcRequests', label: 'requests', desc: '识别为 gRPC 的请求数' },
  { key: 'grpcUnary', label: 'unary', desc: '单消息（unary）请求数' },
  { key: 'grpcStream', label: 'stream', desc: '流式（stream）请求数' },
  { key: 'grpcServerFirst', label: 'server-first', desc: '服务端先说话、首消息等待超时的请求数' },
  { key: 'grpcFrameErrors', label: 'frame-errors', desc: '解析 gRPC 帧失败的请求数' },
  { key: 'grpcSecondMessage', label: 'second-message', desc: '单消息路由上出现第二条消息的次数' },
  { key: 'grpcMessages', label: 'messages', desc: '已解析的 gRPC 消息总数' },
  { key: 'grpcCompressed', label: 'compressed', desc: '带压缩标志的 gRPC 消息数' },
];

// REJECT_FILTERS 按 Violation.enforced 给样例分组：true=实际拒绝，false=观察期只记录。
const REJECT_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'enforced', label: '实际拒绝（enforced=true）' },
  { id: 'observe', label: '观察期本应拒绝（enforced=false）' },
  { id: 'unknown', label: '未返回 enforced' },
];

// BODY_STATE_LABEL 把 bodyState / policy 的取值翻成中文短标签。
const BODY_STATE_LABEL = {
  full: '全量',
  peeked: '部分',
  skipped: '跳过',
  'grpc-unary': 'gRPC 单消息',
  'grpc-stream': 'gRPC 流式',
  'grpc-server-first': '服务端先说话',
  'frame-error': '帧错误',
};

function bodyStateChip(value) {
  const key = String(value || '').trim();
  if (!key) return el('span', { class: 'muted', text: '-' });
  const kind = (key === 'full' || key === 'grpc-unary') ? 'ok' : ((key === 'skipped' || key === 'frame-error') ? 'err' : 'warn');
  return badge(BODY_STATE_LABEL[key] || key, kind);
}

// routeOf 拼出「域名 + 路径」，后端 Violation 里这两项是分开的。
function routeOf(s) {
  const host = s.host || '';
  const uri = s.path || s.uri || s.url || '';
  if (!host) return uri;
  return host + uri;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function pickAlias(root, key) {
  const names = FIELD_ALIASES[key] || [key];
  const hosts = [root, root && root.policy, root && root.stats, root && root.status, root && root.extra];
  for (const host of hosts) {
    for (const name of names) {
      if (isPlainObject(host) && host[name] !== undefined && host[name] !== null) return { value: host[name], field: name };
    }
  }
  return { value: undefined, field: '' };
}

// pickAliasWhere 与 pickAlias 相同，但只接受满足 accept 的值。用于同一字段名
// 在不同层承载不同类型的情况（例如 wouldReject 既是计数也是样例数组）。
function pickAliasWhere(root, key, accept) {
  const names = FIELD_ALIASES[key] || [key];
  const hosts = [root, root && root.policy, root && root.stats, root && root.status, root && root.extra];
  for (const host of hosts) {
    for (const name of names) {
      if (isPlainObject(host) && host[name] !== undefined && host[name] !== null && accept(host[name])) {
        return { value: host[name], field: name };
      }
    }
  }
  return { value: undefined, field: '' };
}

function parseAliasedInt(root, key) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const n = Number(hit.value);
  return { value: isFinite(n) && n >= 0 ? Math.trunc(n) : null, field: hit.field };
}

// parseAliasedFloat 读浮点策略字段（notifyBodyRatio 是 0–1 的比例，不能截断成整数）。
function parseAliasedFloat(root, key) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const n = Number(hit.value);
  return { value: isFinite(n) ? n : null, field: hit.field };
}

function parseAliasedEnum(root, key, allowed) {
  const hit = pickAlias(root, key);
  if (hit.value === undefined) return { value: null, field: '' };
  const text = String(hit.value).trim();
  return { value: allowed.indexOf(text) >= 0 ? text : null, field: hit.field };
}

// normalizeBodyState 兼容三种形状：{full: 12} / [{state,count}] / {full:{count}}。
function normalizeBodyState(raw) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) continue;
      const name = item.state || item.name || item.key || item.bodyState || item.type;
      const value = numLike(item.count !== undefined ? item.count : (item.value !== undefined ? item.value : (item.total !== undefined ? item.total : item.n)));
      if (name !== undefined && name !== null && name !== '') out[String(name)] = value;
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const value = raw[key];
      if (isPlainObject(value)) {
        const inner = numLike(value.count !== undefined ? value.count : (value.value !== undefined ? value.value : value.total));
        if (inner !== null) out[key] = inner;
        continue;
      }
      const n = numLike(value);
      if (n !== null) out[key] = n;
    }
  }
  return out;
}

function numLike(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// statNumber 只接受数字或纯数字字符串：stats.wouldReject 是计数，而响应根级的
// wouldReject 是样例数组，用类型区分两者，避免把数组读成 0。
function statNumber(hosts, names) {
  for (const host of hosts) {
    if (!isPlainObject(host)) continue;
    for (const name of names) {
      const raw = host[name];
      if (typeof raw === 'number' && isFinite(raw)) return { value: raw, field: name };
      if (typeof raw === 'string' && raw.trim() !== '' && isFinite(Number(raw))) return { value: Number(raw), field: name };
    }
  }
  return { value: null, field: '' };
}

// readCounters 按契约名表读一组计数，返回 { key: { value, field } }。
function readCounters(hosts, table) {
  const out = {};
  for (const key of Object.keys(table)) out[key] = statNumber(hosts, table[key]);
  return out;
}

// fmtCount 缺值时显示占位符（gRPC 计数在无流量时是 0，也可能是后端整体未返回）。
function fmtCount(value, missing) {
  return (value === null || value === undefined) ? (missing || '—') : String(value);
}

// bodyStateValue 按别名表取某个状态的计数。
function bodyStateValue(map, key) {
  for (const name of (BODY_STATE_ALIASES[key] || [key])) {
    if (map[name] !== undefined) return map[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) return map[k];
    }
  }
  return null;
}

// normalizeSamples 兼容三种形状：数组 / {items|samples|list} / 单条对象。
function normalizeSamples(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x && typeof x === 'object');
  if (isPlainObject(raw)) {
    for (const key of ['items', 'samples', 'list', 'entries', 'recent', 'records']) {
      if (Array.isArray(raw[key])) return raw[key].filter((x) => x && typeof x === 'object');
    }
    if (raw.rule || raw.path || raw.uri || raw.reason) return [raw];
  }
  return [];
}


// GRPC_STATUS_HINT 是 gRPC 状态码的中文含义。后端 Violation.grpcStatus 直接给出
// 数值，前端只负责显示，不再按 policy 猜；请求体检查最常返回 7 = PERMISSION_DENIED
// 与 8 = RESOURCE_EXHAUSTED（见 internal/modules/waf/grpc.go 的映射），其它值显示数字。
const GRPC_STATUS_HINT = {
  0: 'OK（成功，无错误）',
  1: 'CANCELLED（调用已被取消）',
  2: 'UNKNOWN（未知错误）',
  3: 'INVALID_ARGUMENT（参数无效）',
  4: 'DEADLINE_EXCEEDED（超过截止时间）',
  5: 'NOT_FOUND（目标不存在）',
  6: 'ALREADY_EXISTS（已存在）',
  7: 'PERMISSION_DENIED（拒绝访问：请求被 WAF 拦下）',
  8: 'RESOURCE_EXHAUSTED（资源耗尽：请求体过大 / 帧畸形截断）',
  9: 'FAILED_PRECONDITION（前置条件不满足）',
  10: 'ABORTED（操作被中止）',
  11: 'OUT_OF_RANGE（超出有效范围）',
  12: 'UNIMPLEMENTED（服务端未实现）',
  13: 'INTERNAL（服务端内部错误）',
  14: 'UNAVAILABLE（服务不可用）',
  15: 'DATA_LOSS（数据丢失）',
  16: 'UNAUTHENTICATED（未认证）',
};

// REJECT_REASON_LABEL 把 Violation.reason（决策行）翻成中文说明。
const REJECT_REASON_LABEL = {
  'content-length-unknown': 'Content-Length 未知：无法确认能完整检查请求体',
  'grpc-second-message': 'gRPC 出现第二个消息：单消息路由只接受一条',
  'grpc-encoding-unsupported': 'gRPC 压缩编码不支持',
  'grpc-frame-error': 'gRPC 帧错误：畸形 / 超长 / 截断',
  'rule-match': '命中 WAF 规则',
};

function grpcStatusOf(s) {
  const raw = (s && s.grpcStatus !== undefined && s.grpcStatus !== null) ? s.grpcStatus : (s ? s.grpcCode : undefined);
  const n = numLike(raw);
  return n === null ? null : Math.trunc(n);
}

function grpcStatusMeaning(code) {
  return GRPC_STATUS_HINT[code] || ('未知 gRPC 状态码 ' + code);
}

// sampleEnforced 直接读 Violation.enforced：true=实际拒绝，false=观察期只记录。
// 后端未返回该字段时才退回 action / blocked 推断，并在界面上标注是推断值。
function sampleEnforced(s) {
  const raw = s ? s.enforced : undefined;
  if (raw === true || raw === false) return { value: raw, inferred: false };
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return { value: true, inferred: false };
    if (t === 'false' || t === '0' || t === 'no') return { value: false, inferred: false };
  }
  const act = String((s && (s.action || s.disruption)) || '').toLowerCase();
  if (act) return { value: act.indexOf('block') >= 0 || act === 'deny', inferred: true };
  if (s && s.blocked !== undefined && s.blocked !== null) return { value: !!s.blocked, inferred: true };
  return { value: null, inferred: true };
}

// rejectStatusCell 渲染「本应返回」：
//   grpcStatus > 0 → HTTP <status> + grpc-status <code>，hover / 小字给出中文含义
//   grpcStatus = 0 → 只显示 HTTP status
//   字段缺失       → 退回旧的 policy=grpc* 推断分支，并标注为推断
function rejectStatusCell(s) {
  const statusRaw = (s && s.status !== undefined && s.status !== null && s.status !== '') ? s.status
    : ((s && s.statusCode !== undefined && s.statusCode !== null && s.statusCode !== '') ? s.statusCode : null);
  const statusText = statusRaw === null ? '' : String(statusRaw);
  const code = grpcStatusOf(s);
  if (code !== null && code > 0) {
    const meaning = grpcStatusMeaning(code);
    return el('div', { title: 'grpc-status ' + code + ' = ' + meaning },
      badge((statusText ? 'HTTP ' + statusText + ' + ' : '') + 'grpc-status ' + code, 'warn'),
      el('div', { class: 'pwaf-label', text: meaning }));
  }
  if (code === null) {
    const policy = String((s && s.policy) || '');
    if (policy.indexOf('grpc') === 0) {
      // 旧字段兜底：后端还没返回 grpcStatus 时按 policy 推断（第二消息 13，首消息违规 7）。
      const inferred = (s && s.secondMessage) ? 13 : 7;
      const meaning = grpcStatusMeaning(inferred);
      return el('div', { title: '后端未返回 grpcStatus，按 policy=' + policy + ' 推断：' + meaning },
        badge((statusText ? 'HTTP ' + statusText + ' + ' : '') + 'grpc-status ' + inferred + '（推断）', 'warn'),
        el('div', { class: 'pwaf-label', text: meaning }));
    }
  }
  if (statusRaw === null) return el('span', { class: 'muted', text: '-' });
  return badge(statusText, 'warn');
}

export default {
  id: 'waf',
  title: 'WAF 防护',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l1.8 1.8L15 9.5"/></svg>',
  async mount(root, ctx) {
    const api = wrapAPI(ctx && ctx.api);
    const offStyle = pageStyle(root, PAGE_CSS);
    const formBox = el('div', {}, spinner('正在加载 WAF 配置…'));
    const rulesBox = el('div', {});
    const logsBox = el('div', {});
    const testResult = el('div', { class: 'pwaf-result' });
    const policyBox = el('div', {}, spinner('正在加载请求体检查策略…'));
    let stopLogs = null;
    const state = {
      config: null,
      rules: [],
      logs: [],
      ruleQuery: '',
      policy: null,
      policyStats: null,
      fallback: {},
      compatNotes: [],
      webRules: null,
      webRulesError: null,
      rejectCount: 0,
      refusedCount: 0,
      rejectFilter: 'all',
    };
    const policyF = {};

    // 配置表单控件
    const f = {};
    function buildForm(cfg) {
      const c = cfg || {};
      f.enable = checkEl('启用 WAF', !!c.enable);
      f.mode = selectEl([{ value: 'detect', label: '检测模式（只记录不拦截）' }, { value: 'block', label: '拦截模式' }], c.mode || 'detect');
      f.useCrs = checkEl('使用内置 CRS 规则集', c.useCrs !== false);
      f.pl = levelOptions(c.paranoiaLevel, 1);
      f.executingPl = levelOptions(c.executingLevel || c.paranoiaLevel || 1, 1);
      f.inbound = input({ type: 'number', min: '0', value: String(c.inboundThreshold || 5) });
      f.outbound = input({ type: 'number', min: '0', value: String(c.outboundThreshold || 4) });
      f.bodyLimit = input({ type: 'number', min: '0', value: String(c.bodyLimitKb || 0), placeholder: '0 表示默认' });
      f.logOnly = checkEl('仅记录（不返回 403）', !!c.logOnly);
      f.adminProtect = checkEl('保护后台管理接口', c.adminProtect !== false);
      f.extra = textarea({ rows: '4', placeholder: '追加的 SecLang 规则，例如：' + LF + 'SecRule ARGS "@contains evil" "id:100001,phase:2,deny,status:403,msg:自定义规则"' , value: c.extraRules || '' });
      clear(formBox);
      formBox.appendChild(el('div', { class: 'grid' },
        field('总开关', f.enable),
        field('模式', f.mode),
        field('内置 CRS', f.useCrs),
        field('仅记录', f.logOnly),
        field('保护后台', f.adminProtect),
        field('CRS 等级 (PL)', f.pl, '等级越高越严格，误报也越多'),
        field('执行等级', f.executingPl),
        field('入站阈值', f.inbound, '异常分数达到该值触发'),
        field('出站阈值', f.outbound),
        field('请求体限制 (KB)', f.bodyLimit),
      ));
      formBox.appendChild(fieldSet('附加规则', [field('SecLang 规则片段', f.extra, '保存后立即重新编译规则集', true)]));
    }

    async function saveConfig() {
      if (!state.config) { toast('配置尚未加载完成', 'warn'); return; }
      const payload = Object.assign({}, state.config, {
        enable: checked(f.enable),
        mode: val(f.mode) || 'detect',
        useCrs: checked(f.useCrs),
        paranoiaLevel: numOf(f.pl, 1),
        executingLevel: numOf(f.executingPl, 1),
        inboundThreshold: numOf(f.inbound, 5),
        outboundThreshold: numOf(f.outbound, 4),
        bodyLimitKb: numOf(f.bodyLimit, 0),
        logOnly: checked(f.logOnly),
        adminProtect: checked(f.adminProtect),
        extraRules: val(f.extra),
      });
      if (state.rules.length) {
        payload.disabledRules = state.rules.filter((it) => it.node && !it.node.checked).map((it) => it.id);
      }
      try {
        await api.put('/waf/config', payload);
        toast('配置已保存', 'ok');
        loadConfig();
      } catch (e) {
        toast('保存失败：' + apiErr(e), 'error');
      }
    }

    async function loadConfig() {
      clear(formBox);
      formBox.appendChild(spinner('正在加载 WAF 配置…'));
      try {
        const data = await api.get('/waf/config');
        state.config = (data && data.config) ? data.config : (data || {});
        buildForm(state.config);
      } catch (e) {
        clear(formBox);
        formBox.appendChild(errorCard(e, () => loadConfig()));
      }
    }

    function paintRules() {
      clear(rulesBox);
      const disabled = (state.config && state.config.disabledRules) || [];
      const q = state.ruleQuery.trim().toLowerCase();
      const list = state.rules.filter((it) => !q || (wafRuleTitle(it) + ' ' + wafRuleId(it)).toLowerCase().indexOf(q) >= 0);
      if (!state.rules.length) {
        rulesBox.appendChild(emptyBox('未获取到规则文件列表（可能未启用 CRS 或模块未实现该接口）'));
        return;
      }
      if (!list.length) { rulesBox.appendChild(emptyBox('没有匹配的规则')); return; }
      const scroll = el('div', { class: 'pwaf-scroll' });
      for (const item of list) {
        const box = el('input', { type: 'checkbox' });
        box.checked = disabled.indexOf(item.id) < 0;
        item.node = box;
        const cnt = wafRuleCount(item);
        scroll.appendChild(el('label', { class: 'pwaf-rule' },
          box,
          el('span', { class: 'pwaf-id', text: item.id }),
          el('span', { text: wafRuleTitle(item) }),
          el('span', { class: 'spacer', style: 'flex:1' }),
          cnt !== undefined ? badge(String(cnt) + ' 条') : null,
        ));
      }
      rulesBox.appendChild(scroll);
      rulesBox.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px', text: '取消勾选表示禁用该规则文件 / 规则组，保存后写入 disabledRules 并重新编译。' }));
    }

    async function loadRules() {
      clear(rulesBox);
      rulesBox.appendChild(spinner('正在加载规则列表…'));
      try {
        const data = await api.get('/waf/rules');
        state.rules = unwrap(data, ['rules', 'items', 'files', 'groups']).map((it) => ({
          id: wafRuleId(it),
          title: wafRuleTitle(it),
          raw: it,
          node: null,
        })).filter((it) => it.id);
        paintRules();
      } catch (e) {
        clear(rulesBox);
        rulesBox.appendChild(errorCard(e, () => loadRules()));
      }
    }

    async function loadLogs() {
      try {
        const data = await api.get('/waf/logs', { limit: 200 });
        state.logs = unwrap(data, ['logs', 'items']);
        clear(logsBox);
        logsBox.appendChild(dataTable(logColumns(), state.logs.map((l, i) => ({ raw: l, tag: String(i) })), '暂无拦截日志'));
      } catch (e) {
        clear(logsBox);
        logsBox.appendChild(errorCard(e, () => loadLogs()));
      }
    }

    async function runTest() {
      const method = val(testMethod);
      const url = val(testURL);
      const body = val(testBody);
      if (!url) { toast('请填写要测试的 URL', 'warn'); return; }
      clear(testResult);
      testResult.appendChild(spinner('正在检测…'));
      try {
        const res = await api.post('/waf/test', { method: method || 'GET', url, body, path: url });
        const data = res || {};
        const blocked = !!(data.blocked || data.interrupted || data.action === 'block' || data.disruption);
        clear(testResult);
        testResult.appendChild(el('div', { class: 'bar' },
          blocked ? badge('已被拦截', 'err') : badge('未拦截', 'ok'),
          el('span', { class: 'muted', text: data.message || data.msg || '' }),
        ));
        const ids = ruleIdsOf(data);
        testResult.appendChild(el('div', { style: 'height:8px' }));
        testResult.appendChild(kv([
          ['命中规则数', String(ids.length || (data.matchedCount || 0))],
          ['规则 ID', ids.length ? chips(ids, 12) : '-'],
          ['异常分数', data.score !== undefined ? String(data.score) : (data.anomalyScore !== undefined ? String(data.anomalyScore) : '-')],
          ['动作', data.action || data.disruption || '-'],
          ['HTTP 状态', data.status !== undefined ? String(data.status) : '-'],
        ]));
      } catch (e) {
        clear(testResult);
        testResult.appendChild(errorCard(e, () => runTest()));
      }
    }

    /* ---------------------------------------------------------------- 策略面板 */

    // refreshWebRules 取一次 Web 规则，用于「未声明 bodyPolicy 的路由」列表。
    async function refreshWebRules() {
      try {
        const data = await api.get('/web/rules');
        state.webRules = unwrap(data, ['rules', 'items']);
        state.webRulesError = null;
      } catch (e) {
        state.webRules = null;
        state.webRulesError = e;
      }
    }

    // readPolicy 从 GET /waf/config 的返回里解析策略字段，命中未知命名时记录提示。
    function readPolicy(root, fallback) {
      const f = { mode: false, policy: false, peekBytes: false, peekTimeoutMs: false, notifyBodyRatio: false };
      const enforce = parseAliasedEnum(root, 'enforcementMode', ['observe', 'enforce']);
      const dflt = parseAliasedEnum(root, 'defaultBodyPolicy', ['full', 'peek', 'skip', 'grpc']);
      const bytes = parseAliasedInt(root, 'peekBytes');
      const timeout = parseAliasedInt(root, 'peekTimeoutMs');
      const ratio = parseAliasedFloat(root, 'notifyBodyRatio');
      f.mode = enforce.value === null;
      f.policy = dflt.value === null;
      f.peekBytes = bytes.value === null;
      f.peekTimeoutMs = timeout.value === null;
      // notifyBodyRatio 的零值带 omitempty：后端在 0（关闭）时不会回传该字段，
      // 因此这里的「缺失」同时覆盖「后端确实没有该字段」与「当前就是 0」，界面上
      // 按 0 显示并注明后端未返回；保存时始终提交输入值（见 savePolicy）。
      f.notifyBodyRatio = ratio.value === null;
      const notes = [];
      if (enforce.field && enforce.field !== 'enforcementMode') notes.push('enforcementMode ← ' + enforce.field);
      if (dflt.field && dflt.field !== 'defaultBodyPolicy') notes.push('defaultBodyPolicy ← ' + dflt.field);
      if (bytes.field && bytes.field !== 'peekBytes') notes.push('peekBytes ← ' + bytes.field);
      if (timeout.field && timeout.field !== 'peekTimeoutMs') notes.push('peekTimeoutMs ← ' + timeout.field);
      if (ratio.field && ratio.field !== 'notifyBodyRatio') notes.push('notifyBodyRatio ← ' + ratio.field);
      return {
        values: {
          enforcementMode: enforce.value === null ? fallback.enforcementMode : enforce.value,
          defaultBodyPolicy: dflt.value === null ? fallback.defaultBodyPolicy : dflt.value,
          peekBytes: bytes.value === null ? fallback.peekBytes : bytes.value,
          peekTimeoutMs: timeout.value === null ? fallback.peekTimeoutMs : timeout.value,
          notifyBodyRatio: ratio.value === null ? fallback.notifyBodyRatio : ratio.value,
        },
        fallback: f,
        notes: notes,
      };
    }

    // readPolicyStats 解析 bodyState 分布、拒绝计数、gRPC 指标、wouldReject 样例与
    // 未声明路由列表。
    //
    // wouldReject 的情况特殊：后端把「计数」放在 stats.wouldReject（数字），
    // 把「样例数组」放在响应根 wouldReject（[]Violation，最新在前）。
    // statNumber 只认数字、sampleHit 只认数组/对象，两者不会互相遮蔽。
    function readPolicyStats(root) {
      const bodyHit = pickAlias(root, 'bodyState');
      const sampleHit = pickAliasWhere(root, 'wouldReject', (v) => Array.isArray(v) || isPlainObject(v));
      const undeclaredHit = pickAlias(root, 'undeclared');
      // 计数优先从 stats 层读，其次 config / 根级，最后才是解包后的内层对象。
      const hosts = [root && root.stats, root && root.config, root, root && root.policy, root && root.status, root && root.extra];
      const counters = readCounters(hosts, COUNTER_FIELDS);
      const grpc = readCounters(hosts, GRPC_COUNTER_FIELDS);
      const states = normalizeBodyState(bodyHit.value);
      const samples = normalizeSamples(sampleHit.value);
      let rejectCount = counters.wouldReject.value;
      if (rejectCount === null) {
        // 没有独立计数时：对象样例用它的 count/total，否则退回样例条数。
        const inner = isPlainObject(sampleHit.value)
          ? numLike(sampleHit.value.count !== undefined ? sampleHit.value.count : sampleHit.value.total) : null;
        rejectCount = inner === null ? samples.length : Math.max(inner, samples.length);
      }
      let refused = counters.refused.value;
      if (refused === null) {
        // 旧后端没有 stats.refused 时，用样例里 enforced=true 的条数兜底（只是样例内计数）。
        refused = samples.filter((s) => sampleEnforced(s).value === true).length;
      }
      return {
        states,
        samples,
        counters,
        grpc,
        rejectCount: rejectCount,
        refusedCount: refused,
        undeclaredFromConfig: Array.isArray(undeclaredHit.value) ? undeclaredHit.value.filter(Boolean) : [],
        undeclaredField: undeclaredHit.field,
        fields: {
          bodyState: bodyHit.field,
          wouldReject: counters.wouldReject.field || sampleHit.field,
          wouldRejectSamples: sampleHit.field,
          refused: counters.refused.field,
          undeclared: undeclaredHit.field,
        },
      };
    }

    function sumStates(states) {
      let total = 0;
      for (const name of Object.keys(states)) {
        const v = numLike(states[name]);
        if (v !== null) total += v;
      }
      return total;
    }

    function nonFullCount(states) {
      let n = 0;
      for (const key of NON_FULL_STATES) {
        const v = bodyStateValue(states, key);
        if (v !== null) n += v;
      }
      return n;
    }

    // undeclaredRoutes 直接使用后端字段 undeclaredRoutes（routeView：id/name/path/
    // type/waf）；只有该字段整体缺失时才退回从 GET /web/rules 推导（enable 且
    // bodyPolicy 为空的规则即未声明）。列表会标注当前用的是哪种来源。
    function undeclaredRoutes(stats) {
      const s = stats || {};
      if (s.undeclaredFromConfig && s.undeclaredFromConfig.length) {
        return {
          source: 'config',
          list: s.undeclaredFromConfig.map((item, i) => {
            if (isPlainObject(item)) {
              return {
                id: String(item.id || item.ruleId || item.name || ('#' + (i + 1))),
                name: String(item.name || item.rule || item.path || ''),
                path: String(item.path || item.uri || '/'),
                type: String(item.type || ''),
                waf: (item.waf === undefined || item.waf === null) ? true : !!item.waf,
              };
            }
            return { id: String(item), name: '', path: '/', type: '', waf: true };
          }),
        };
      }
      if (s.undeclaredField) {
        // 字段存在但是空数组：后端明确表示没有未声明的路由，不必再去推导。
        return { list: [], source: 'config-empty' };
      }
      if (state.webRules) {
        return {
          source: 'webRules',
          list: state.webRules
            .filter((r) => r && r.enable !== false && !String(r.bodyPolicy || '').trim())
            .map((r) => ({
              id: String(r.id || ''),
              name: String(r.name || ''),
              path: String(r.path || '/'),
              type: String(r.type || ''),
              waf: r.waf !== false,
            })),
        };
      }
      return { list: [], source: state.webRulesError ? 'error' : 'none' };
    }

    // undeclaredSourceNote 说明未声明路由列表来自后端字段还是前端推导。
    function undeclaredSourceNote(source) {
      if (source === 'config') return '来源：后端 GET /api/v1/waf/config 的 undeclaredRoutes 字段（元素含 id / name / path / type / waf）。';
      if (source === 'config-empty') return '来源：后端 undeclaredRoutes 字段（本次为空，表示没有未声明 bodyPolicy 的启用路由）。';
      if (source === 'webRules') return '来源：后端未返回 undeclaredRoutes 字段，此处由 GET /web/rules 推导（enable 且 bodyPolicy 为空的规则），仅供参考。';
      if (source === 'error') return '来源：后端未返回 undeclaredRoutes 字段，且 GET /web/rules 读取失败，无法列出未声明路由。';
      return '来源：既没有 undeclaredRoutes 字段，也拿不到 GET /web/rules，暂时无法列出未声明路由。';
    }

    function policyEmptyCard(title, detail) {
      return el('div', { class: 'notice' },
        el('div', { style: { fontWeight: '600' }, text: title }),
        el('div', { text: detail }),
      );
    }

    function infoCard(title, lines) {
      const box = el('div', { class: 'notice' });
      box.appendChild(el('div', { style: { fontWeight: '600' }, text: title }));
      for (const line of lines) box.appendChild(el('div', { text: line }));
      return box;
    }

    function paintPolicy() {
      clear(policyBox);
      const cfg = state.policy;
      if (!cfg) {
        policyBox.appendChild(spinner('正在加载请求体检查策略…'));
        return;
      }
      const controlGrid = el('div', { class: 'grid' });
      const modeSel = selectEl(ENFORCEMENT_OPTIONS, cfg.enforcementMode);
      const defaultSel = selectEl(DEFAULT_POLICY_OPTIONS, cfg.defaultBodyPolicy);
      const peekBytes = input({ type: 'number', min: '0', max: String(POLICY_LIMITS.peekBytes.max), step: '1024', value: String(cfg.peekBytes), placeholder: '65536' });
      const peekTimeout = input({ type: 'number', min: '0', max: String(POLICY_LIMITS.peekTimeoutMs.max), step: '50', value: String(cfg.peekTimeoutMs), placeholder: '250' });
      const warnBox = el('div', { class: 'pwaf-sub' });
      policyF.mode = modeSel;
      policyF.defaultPolicy = defaultSel;
      policyF.peekBytes = peekBytes;
      policyF.peekTimeoutMs = peekTimeout;

      function markMissing(node, missing, fallbackValue) {
        if (!missing) return;
        node.style.borderColor = 'var(--warn,#d98b00)';
        node.title = '后端返回里没有这个字段，界面显示的是默认值 ' + fallbackValue + '；保存前请确认后端已实现';
      }
      // modeHint / peekHintField 必须在 sync* 之前建好（它们会被同步函数写入）。
      const modeHint = el('div', { class: 'hint' });
      const peekHintField = el('div', { class: 'hint' });
      markMissing(modeSel, cfg.__fallback.mode, POLICY_DEFAULTS.enforcementMode);
      markMissing(defaultSel, cfg.__fallback.policy, POLICY_DEFAULTS.defaultBodyPolicy);
      markMissing(peekBytes, cfg.__fallback.peekBytes, POLICY_DEFAULTS.peekBytes);
      markMissing(peekTimeout, cfg.__fallback.peekTimeoutMs, POLICY_DEFAULTS.peekTimeoutMs);

      function syncModeHint() {
        const mode = val(modeSel) || 'observe';
        clear(modeHint);
        modeHint.appendChild(el('span', mode === 'observe'
          ? '观察模式（observe）：只记录「本应拒绝」，请求照常放行——用于上线前扫出漏声明的路由。'
          : '强制模式（enforce）：形态上无法完整检查的请求会被真的拒绝（例如 Content-Length 未知的请求返回 411）。'));
      }
      function syncPeekHint() {
        const bytes = numOf(peekBytes, POLICY_DEFAULTS.peekBytes);
        const ms = numOf(peekTimeout, POLICY_DEFAULTS.peekTimeoutMs);
        peekHintField.textContent = 'peek 策略读满 ' + fmtBytes(bytes) + ' 或空闲 ' + ms +
          'ms 就先检查已到达的部分，其余字节流式透传（bodyState=peeked）；只有声明了 peek 的路由会用到这两个参数。';
      }
      modeSel.addEventListener('change', () => { syncModeHint(); paintPolicyWarnings(warnBox, modeSel, defaultSel); });
      defaultSel.addEventListener('change', () => paintPolicyWarnings(warnBox, modeSel, defaultSel));
      peekBytes.addEventListener('input', syncPeekHint);
      peekTimeout.addEventListener('input', syncPeekHint);
      syncModeHint();
      syncPeekHint();

      controlGrid.appendChild(el('div', { class: 'field' }, el('label', { text: '执行模式' }), modeSel, modeHint));
      const defField = el('div', { class: 'field' }, el('label', { text: '默认请求体策略（未声明 bodyPolicy 的路由使用）' }), defaultSel,
        el('div', { class: 'hint', text: '默认 full 是 fail-closed：攻击者只能通过改变请求形态落到「拒绝」，不存在自动降级为部分检查的路径。' }));
      controlGrid.appendChild(defField);
      controlGrid.appendChild(el('div', { class: 'field' }, el('label', { text: 'PeekBytes（peek 检查的字节数）' }), peekBytes));
      controlGrid.appendChild(el('div', { class: 'field' }, el('label', { text: 'PeekTimeoutMS（空闲超时，毫秒）' }), peekTimeout));
      policyBox.appendChild(controlGrid);
      policyBox.appendChild(peekHintField);
      paintPolicyWarnings(warnBox, modeSel, defaultSel);
      policyBox.appendChild(warnBox);
      policyBox.appendChild(paintBodyStates());
      policyBox.appendChild(paintRejectCounters());
      policyBox.appendChild(paintGRPCStats());
      paintRejects();
      paintUndeclared();
    }

    function paintPolicyWarnings(host, modeSel, defaultSel) {
      clear(host);
      const missing = [];
      if (state.fallback.mode) missing.push('enforcementMode');
      if (state.fallback.policy) missing.push('defaultBodyPolicy');
      if (state.fallback.peekBytes) missing.push('peekBytes');
      if (state.fallback.peekTimeoutMs) missing.push('peekTimeoutMs');
      if (missing.length) {
        host.appendChild(policyEmptyCard('后端尚未返回这些字段：' + missing.join('、'),
          '界面按 PLAN-waf-body-policy.md §2 的默认值显示（observe / full / 65536 / 250）。' +
          '这种情况下「保存策略」不会把这些字段写回配置，避免把默认值当成你的选择落盘；' +
          '等后端把字段加进 model.WAFConfig 后自动生效。'));
        host.appendChild(el('div', { style: { height: '8px' } }));
      }
      if ((val(modeSel) || 'observe') === 'enforce') {
        const would = numLike(state.rejectCount);
        const refused = numLike(state.refusedCount);
        host.appendChild(infoCard('当前是强制模式（enforce）：不符合策略的请求会被拒绝',
          ['确认「未声明 bodyPolicy 的路由」已经补齐；下面列出它们，点「去 Web 规则页设置」可以逐个声明。',
            '观察期累计「本应拒绝」（enforced=false）：' + fmtCount(would, '0') + ' 条；已实际拒绝（enforced=true）：' + fmtCount(refused, '0') + ' 条（切换前请确认已看完）。']));
        host.appendChild(el('div', { style: { height: '8px' } }));
      }
    }

    // countedValue 从解析好的 counters 里取值（后端未返回该字段时为 null）。
    function countedValue(key) {
      const counters = (state.policyStats && state.policyStats.counters) || {};
      return counters[key] ? counters[key].value : null;
    }

    function paintBodyStates() {
      const stats = state.policyStats || { states: {} };
      const states = stats.states || {};
      // 总数与非 full 计数优先用后端字段（stats.bodyRequests / bodyNonFull /
      // bodyNonFullRatio），缺失时按 bodyStates 分布自行求和。
      const totalRaw = countedValue('bodyRequests');
      const fullRaw = countedValue('bodyFull');
      const nonFullRaw = countedValue('bodyNonFull');
      const ratioRaw = countedValue('bodyNonFullRatio');
      const total = totalRaw === null ? sumStates(states) : totalRaw;
      const nonFull = nonFullRaw === null ? nonFullCount(states) : nonFullRaw;
      const ratio = ratioRaw === null ? (total ? nonFull / total : 0) : ratioRaw;
      const pct = Math.round(ratio * 1000) / 10;
      const box = el('div', { class: 'pwaf-sub' });
      const title = el('div', { class: 'row', style: { marginBottom: '6px' } },
        el('span', { class: 'pwaf-sub-title', text: 'bodyState 分布' }),
        el('span', { class: 'pwaf-coverage muted', text: total ? ('总样本 ' + total + '，非 full 占比 ' + pct + '%') : '暂无样本' }));
      box.appendChild(title);
      if (!total) {
        box.appendChild(emptyBox('暂无 bodyState 计数（可能还没有流量，或后端尚未暴露该字段）'));
      } else {
        const grid = el('div', { class: 'pwaf-states' });
        for (const item of BODY_STATE_KEYS) {
          const value = bodyStateValue(states, item.key);
          const count = value === null ? 0 : value;
          const card = el('div', { class: 'pwaf-state' + (count ? '' : ' zero'), title: item.key + '：' + item.desc },
            el('span', { class: 'k', text: item.label }),
            el('span', { class: 'v', text: String(count) }),
            el('span', { class: 's', text: item.key + (value === null ? '（后端未返回）' : '') }),
          );
          grid.appendChild(card);
        }
        box.appendChild(grid);
        box.appendChild(el('div', { class: 'pwaf-compat', text: '后端计数：bodyRequests ' + fmtCount(totalRaw) +
          '，bodyFull ' + fmtCount(fullRaw) +
          '，bodyNonFull ' + fmtCount(nonFullRaw) +
          '，bodyNonFullRatio ' + (ratioRaw === null ? '—' : (Math.round(ratioRaw * 1000) / 10 + '%')) }));
        if (nonFull > 0) {
          box.appendChild(el('div', { class: 'hint', style: { marginTop: '6px' }, text: '非 full 的请求表示检查存在缺口（peek 只覆盖前若干字节，skip / grpc-stream 只覆盖首消息或请求头）；这些请求仍然会被 WAF 的 URI / 请求头检查覆盖。' }));
        }
      }
      return box;
    }

    // paintRejectCounters 展示 stats.refused（enforced=true，真的拒绝）与
    // stats.wouldReject（enforced=false，观察期只记录）两个计数，并给出环形缓冲的
    // 容量提示（wouldRejectKept / wouldRejectLimit）。
    function paintRejectCounters() {
      const refused = countedValue('refused');
      const would = countedValue('wouldReject');
      const kept = countedValue('wouldRejectKept');
      const limit = countedValue('wouldRejectLimit');
      const box = el('div', { class: 'pwaf-sub' });
      box.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } },
        el('span', { class: 'pwaf-sub-title', text: '拒绝计数' }),
        el('span', { class: 'pwaf-coverage muted', text: 'stats.refused / stats.wouldReject' })));
      const grid = el('div', { class: 'pwaf-states' });
      grid.appendChild(el('div', { class: 'pwaf-state', title: 'enforced=true：请求真的被拒绝（stats.refused）' },
        el('span', { class: 'k', text: '实际拒绝' }),
        el('span', { class: 'v', text: fmtCount(refused, '0') }),
        el('span', { class: 's', text: 'enforced=true' })));
      grid.appendChild(el('div', { class: 'pwaf-state', title: 'enforced=false：观察期只记录，请求照常放行（stats.wouldReject）' },
        el('span', { class: 'k', text: '观察期本应拒绝' }),
        el('span', { class: 'v', text: fmtCount(would, '0') }),
        el('span', { class: 's', text: 'enforced=false' })));
      grid.appendChild(el('div', { class: 'pwaf-state', title: '环形缓冲里保留的样例数 / 缓冲上限（stats.wouldRejectKept / stats.wouldRejectLimit）' },
        el('span', { class: 'k', text: '样例缓存' }),
        el('span', { class: 'v', text: fmtCount(kept) + ' / ' + fmtCount(limit) }),
        el('span', { class: 's', text: 'wouldRejectKept / Limit' })));
      box.appendChild(grid);
      if (kept !== null && limit !== null && limit > 0 && kept >= limit) {
        box.appendChild(el('div', { class: 'hint', style: { marginTop: '6px' }, text: '样例缓存已写满：更早的拒绝记录已被覆盖，但上面的计数仍是累计值。' }));
      }
      return box;
    }

    // paintGRPCStats 展示 stats.grpc* 一行（requests / unary / stream / server-first /
    // frame-errors / second-message / messages / compressed），缺失时显示 —。
    function paintGRPCStats() {
      const grpc = (state.policyStats && state.policyStats.grpc) || {};
      const value = (key) => (grpc[key] ? grpc[key].value : null);
      const any = GRPC_METRIC_KEYS.some((item) => value(item.key) !== null);
      const box = el('div', { class: 'pwaf-sub' });
      box.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } },
        el('span', { class: 'pwaf-sub-title', text: 'gRPC 统计' }),
        el('span', { class: 'pwaf-coverage muted', text: any ? 'stats.grpc*（requests 为 0 表示还没有 gRPC 流量）' : '后端未返回 gRPC 计数（stats.grpc*）' })));
      const grid = el('div', { class: 'pwaf-grpc' });
      for (const item of GRPC_METRIC_KEYS) {
        const v = value(item.key);
        grid.appendChild(el('span', { class: 'pwaf-grpc-item' + (v === null ? ' miss' : ''), title: item.desc + '（stats.' + item.key + '）' },
          el('span', { class: 'k', text: item.label }),
          el('span', { class: 'v', text: fmtCount(v) })));
      }
      box.appendChild(grid);
      return box;
    }

    // paintRejects 渲染「拒绝样例」分区。样例表按 Violation.enforced 分组：
    //   enforced=true  → 实际拒绝（强制模式真的拒绝了请求）
    //   enforced=false → 观察期本应拒绝（observe 只记录，请求照常放行）
    // 表格同时给出一列判定标签，可用上方按钮按分组筛选。
    function paintRejects() {
      const box = el('div', { class: 'pwaf-sub' });
      renderRejects(box);
      policyBox.appendChild(box);
    }

    // renderRejects 只重画样例分区（切换分组筛选时不重建整张卡片）。
    function renderRejects(box) {
      clear(box);
      const stats = state.policyStats || { samples: [] };
      const samples = stats.samples || [];
      const groups = { all: samples, enforced: [], observe: [], unknown: [] };
      for (const s of samples) {
        const v = sampleEnforced(s).value;
        if (v === true) groups.enforced.push(s);
        else if (v === false) groups.observe.push(s);
        else groups.unknown.push(s);
      }
      const active = groups[state.rejectFilter] ? state.rejectFilter : 'all';
      state.rejectFilter = active;
      const refused = numLike(stats.refusedCount);
      const would = numLike(stats.rejectCount);
      const kept = countedValue('wouldRejectKept');
      const limit = countedValue('wouldRejectLimit');
      const summary = '实际拒绝 refused ' + fmtCount(refused, '0') + '（enforced=true）｜' +
        '观察期本应拒绝 wouldReject ' + fmtCount(would, '0') + '（enforced=false）｜' +
        '样例 ' + samples.length + ' 条' +
        ((kept === null && limit === null) ? '' : '，样例缓存 ' + fmtCount(kept) + ' / ' + fmtCount(limit));
      box.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } },
        el('span', { class: 'pwaf-sub-title', text: '拒绝样例（按 enforced 分组）' }),
        el('span', { class: 'pwaf-coverage muted', text: summary })));
      const filters = el('div', { class: 'pwaf-filters', style: { marginBottom: '8px' } });
      for (const item of REJECT_FILTERS) {
        const n = groups[item.id].length;
        filters.appendChild(el('button', {
          class: 'btn btn-sm' + (active === item.id ? ' btn-primary' : ''),
          type: 'button',
          text: item.label + '（' + n + '）',
          onclick: () => { state.rejectFilter = item.id; renderRejects(box); },
        }));
      }
      box.appendChild(filters);
      if (!samples.length) {
        box.appendChild(emptyBox(numLike(stats.rejectCount)
          ? '后端返回了计数 ' + stats.rejectCount + '，但没有样例详情；请确认响应根级的 wouldReject 数组（[]Violation）是否一起返回'
          : '暂无拒绝记录：观察模式下本应被拒绝的请求记为 enforced=false，强制模式下真的被拒绝的记为 enforced=true'));
        return;
      }
      const rows = groups[active];
      if (!rows.length) { box.appendChild(emptyBox('该分组下没有样例')); return; }
      const cols = [
        { title: '判定', render: (s) => enforcedCell(s) },
        { title: '规则', render: (s) => el('div', {},
          el('div', { text: s.rule || s.ruleName || s.ruleId || s.site || '-' }),
          el('div', { class: 'pwaf-hit-tag', text: routeOf(s) })) },
        { title: '请求', render: (s) => el('span', { class: 'mono pwaf-hit-tag', text: (s.method ? s.method + ' ' : '') + (s.uri || s.path || s.url || '-') }) },
        { title: '原因', render: (s) => reasonCell(s) },
        { title: '策略 / 状态', render: (s) => el('div', { class: 'row' },
          bodyStateChip(String(s.policy || s.bodyPolicy || '')),
          s.bodyState ? bodyStateChip(String(s.bodyState)) : null) },
        { title: '本应返回', render: (s) => rejectStatusCell(s) },
        { title: '客户端', render: (s) => el('span', { class: 'mono', text: s.clientIp || s.ip || s.remoteAddr || '-' }) },
        { title: '时间', render: (s) => el('span', { text: fmtTime(s.time || s.ts || s.at || s.timestamp) }) },
      ];
      box.appendChild(dataTable(cols, rows.map((s, i) => ({ raw: s, tag: String(i) })), '暂无样例'));
    }

    // enforcedCell 直接按 Violation.enforced 标注样例属于哪一组。
    function enforcedCell(s) {
      const e = sampleEnforced(s);
      if (e.value === true) return el('div', {}, badge('实际拒绝', 'err'),
        el('div', { class: 'pwaf-label', text: e.inferred ? 'enforced=true（按 action 推断）' : 'enforced=true' }));
      if (e.value === false) return el('div', {}, badge('观察期记录', 'warn'),
        el('div', { class: 'pwaf-label', text: e.inferred ? 'enforced=false（按 action 推断）' : 'enforced=false' }));
      return el('div', {}, badge('未知', 'warn'), el('div', { class: 'pwaf-label', text: '后端未返回 enforced' }));
    }

    // reasonCell 显示 Violation.reason（决策行），带中文含义；message 是给客户端看的文案。
    function reasonCell(s) {
      const reason = String(s.reason || s.msg || '').trim();
      const message = String(s.message || '').trim();
      const box = el('div', {}, el('div', { class: 'muted', text: reason || message || '-' }));
      const label = REJECT_REASON_LABEL[reason];
      if (label) box.appendChild(el('div', { class: 'pwaf-label', text: label }));
      if (message && message !== reason) box.appendChild(el('div', { class: 'pwaf-label', text: message }));
      return box;
    }

    // rejectRuleIds 统计 wouldReject 样例里出现过的规则名（每个记条数），
    // 用来标注「这条路由已经产生过本应拒绝的流量」。
    function rejectRuleIds() {
      const map = {};
      for (const s of (state.policyStats && state.policyStats.samples) || []) {
        const name = s.rule || s.ruleName || s.ruleId || s.site || '';
        if (!name) continue;
        map[name] = (map[name] || 0) + 1;
      }
      return map;
    }

    function paintUndeclared() {
      const found = undeclaredRoutes(state.policyStats || {});
      const hits = rejectRuleIds();
      const offCount = found.list.filter((r) => r.waf === false).length;
      const inherit = DEFAULT_POLICY_SHORT[(state.policy && state.policy.defaultBodyPolicy) || 'full'] || 'full';
      const box = el('div', { class: 'pwaf-sub' });
      const jump = el('button', {
        class: 'btn btn-sm', type: 'button', text: '去 Web 规则页设置',
        onclick: () => {
          if (typeof ctx.navigate === 'function') ctx.navigate('web');
          else { location.hash = '#/web'; }
        },
      });
      box.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } },
        el('span', { class: 'pwaf-sub-title', text: '未声明 bodyPolicy 的路由' }),
        el('span', { class: 'pwaf-coverage muted', text: found.list.length + ' 条（继承全局默认策略 ' + inherit + '）' }),
        el('span', { class: 'spacer', style: { flex: '1 1 auto' } }),
        found.list.length ? jump : null));
      if (found.source === 'error') {
        box.appendChild(errorCard(state.webRulesError, () => loadPolicy()));
      } else if (!found.list.length) {
        box.appendChild(emptyBox(found.source === 'none'
          ? '既没有 undeclaredRoutes 字段，也读不到 GET /web/rules，暂时无法判断哪些路由未声明策略'
          : '所有 Web 规则都已显式声明 bodyPolicy（或当前没有启用的规则）'));
      } else {
        const cols = [
          { title: '名称', render: (r) => el('div', {}, el('div', { text: r.name || r.id || '-' }), el('div', { class: 'muted mono', text: r.id || '' })) },
          { title: '路径', render: (r) => el('span', { class: 'mono', text: r.path || '/' }) },
          { title: '类型', render: (r) => el('span', { class: 'muted', text: r.type || '—' }) },
          { title: 'WAF 开关', render: (r) => (r.waf ? badge('已开启', 'ok') : badge('未开启', 'warn')) },
          { title: '当前继承', render: () => badge(inherit) },
          { title: '拒绝样例', render: (r) => (hits[r.id] || hits[r.name]
            ? badge(hits[r.id] || hits[r.name], 'warn')
            : el('span', { class: 'muted', text: '—' })) },
          { title: '', render: (r) => el('button', { class: 'btn btn-sm', type: 'button', text: '去设置', onclick: () => goToRule(r.id) }) },
        ];
        if (offCount) box.appendChild(el('div', { class: 'hint', text: '其中 ' + offCount + ' 条规则的 WAF 开关是关闭的，这些路由不会进入请求体检查。' }));
        box.appendChild(dataTable(cols, found.list.map((r) => ({ raw: r, tag: r.id })), '暂无未声明的路由'));
      }
      box.appendChild(el('div', { class: 'pwaf-compat', text: undeclaredSourceNote(found.source) }));
      policyBox.appendChild(box);
    }

    // goToRule 跳转到 Web 规则页并聚焦该规则（#/web?rule=<id>）。
    function goToRule(id) {
      if (!id) return;
      if (typeof ctx.navigate === 'function') ctx.navigate('web', { rule: id });
      else { location.hash = '#/web?rule=' + encodeURIComponent(id); }
    }

    // loadPolicy 读取 GET /waf/config 并渲染策略面板。
    async function loadPolicy() {
      clear(policyBox);
      policyBox.appendChild(spinner('正在加载请求体检查策略…'));
      state.compatNotes = [];
      let root = null;
      let data = null;
      try {
        data = await api.get('/waf/config');
        root = (data && data.config) ? data.config : (data || {});
        const read = readPolicy(root, POLICY_DEFAULTS);
        state.fallback = read.fallback;
        state.compatNotes = read.notes;
        state.policy = Object.assign({}, read.values, { __fallback: read.fallback });
        state.policyStats = readPolicyStats(data);
        state.rejectCount = state.policyStats.rejectCount;
        state.refusedCount = state.policyStats.refusedCount;
      } catch (e) {
        state.policy = null;
        clear(policyBox);
        policyBox.appendChild(errorCard(e, () => loadPolicy()));
        return;
      }
      // 未声明路由优先用后端 undeclaredRoutes 字段；只有该字段整体缺失（不是空数组）
      // 时才去 GET /web/rules 推导兜底，页面上会注明当前用的是哪种来源。
      if (!state.policyStats.undeclaredField && !state.webRules && !state.webRulesError) {
        await refreshWebRules();
        state.policyStats = readPolicyStats(data);
      }
      paintPolicy();
      // 兼容读取的痕迹要留在页面上：命中非契约命名时明确写出来，避免误判成「后端没实现」。
      const notes = [];
      if (state.compatNotes.length) notes.push('字段兼容读取：' + state.compatNotes.join('，'));
      const sf = state.policyStats.fields;
      if (sf.bodyState && sf.bodyState !== 'bodyState' && sf.bodyState !== 'bodyStates') notes.push('bodyStates ← ' + sf.bodyState);
      if (sf.wouldReject && sf.wouldReject !== 'wouldReject') notes.push('wouldReject 计数 ← ' + sf.wouldReject);
      if (sf.wouldRejectSamples && sf.wouldRejectSamples !== 'wouldReject') notes.push('wouldReject 样例 ← ' + sf.wouldRejectSamples);
      if (sf.refused && sf.refused !== 'refused') notes.push('refused 计数 ← ' + sf.refused);
      if (sf.undeclared && sf.undeclared !== 'undeclaredRoutes') notes.push('未声明路由 ← ' + sf.undeclared);
      const source = '数据来源：GET /api/v1/waf/config —— config.enforcementMode / defaultBodyPolicy / peekBytes / peekTimeoutMs；' +
        'stats.bodyStates / bodyRequests / bodyFull / bodyNonFull / bodyNonFullRatio、stats.refused / wouldReject / wouldRejectKept / wouldRejectLimit、' +
        'stats.grpc*；响应根级 wouldReject 样例（含 enforced / grpcStatus / reason / bodyState）与 undeclaredRoutes。';
      policyBox.appendChild(el('div', { class: 'pwaf-compat', text: notes.length ? source + notes.join('；') : source }));
    }

    // reloadPolicy 用于定时刷新：正在面板里编辑时跳过这一轮，避免把用户
    // 输了一半的值刷掉（页面每 15 秒自动刷新一次数据）。
    function reloadPolicy() {
      const active = document.activeElement;
      if (active && policyBox.contains(active)) return;
      return loadPolicy();
    }

    // savePolicy 把四项策略写回 /waf/config；后端未返回的字段不写，避免覆盖。
    async function savePolicy() {
      if (!state.config) { toast('配置尚未加载完成', 'warn'); return; }
      if (!state.policy) { toast('策略尚未加载完成', 'warn'); return; }
      const nextMode = val(policyF.mode) || 'observe';
      const prevMode = state.policy.enforcementMode || 'observe';
      const nextDefault = val(policyF.defaultPolicy) || 'full';
      const nextBytes = numOf(policyF.peekBytes, POLICY_DEFAULTS.peekBytes);
      const nextTimeout = numOf(policyF.peekTimeoutMs, POLICY_DEFAULTS.peekTimeoutMs);
      const byteLimit = POLICY_LIMITS.peekBytes;
      const timeLimit = POLICY_LIMITS.peekTimeoutMs;
      if (nextBytes < byteLimit.min || nextBytes > byteLimit.max) {
        toast('PeekBytes 必须在 ' + byteLimit.min + ' – ' + fmtBytes(byteLimit.max) + ' 之间（后端校验会拒绝超范围的值）', 'warn');
        return;
      }
      if (nextTimeout < timeLimit.min || nextTimeout > timeLimit.max) {
        toast('PeekTimeoutMS 必须在 ' + timeLimit.min + ' – ' + timeLimit.max + ' 毫秒之间', 'warn');
        return;
      }
      if (nextBytes > 0 && nextBytes < byteLimit.low) {
        toast('PeekBytes 只有 ' + nextBytes + ' 字节，检查覆盖会很小；确认无误再保存', 'warn');
      }
      if (nextMode !== prevMode) {
        const ok = await confirmDialog(nextMode === 'enforce'
          ? '切换到强制模式（enforce）后，形态上无法完整检查的请求会被真的拒绝（例如 Content-Length 未知的请求返回 411）。确认已补齐所有路由的 bodyPolicy 声明？'
          : '切回观察模式（observe）：只记录「本应拒绝」，不真的拒绝任何请求。');
        if (!ok) { paintPolicy(); return; }
      }
      const payload = Object.assign({}, state.config);
      const fallback = state.fallback || {};
      if (!fallback.mode) payload.enforcementMode = nextMode;
      if (!fallback.policy) payload.defaultBodyPolicy = nextDefault;
      if (!fallback.peekBytes) payload.peekBytes = nextBytes;
      if (!fallback.peekTimeoutMs) payload.peekTimeoutMs = nextTimeout;
      try {
        await api.put('/waf/config', payload);
        toast('请求体检查策略已保存', 'ok');
        loadConfig();
        loadPolicy();
      } catch (e) {
        toast('保存失败：' + apiErr(e), 'error');
      }
    }

    const testMethod = selectEl(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m })), 'GET');
    const testURL = input({ placeholder: '/admin?id=1 union select 1 或完整 URL' });
    const testBody = textarea({ rows: '2', placeholder: '请求体（POST/PUT 时填写）' });

    const rq = input({ class: 'input pwaf-search', placeholder: '搜索规则文件…' });
    rq.addEventListener('input', debounce(() => { state.ruleQuery = rq.value; paintRules(); }, 200));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: 'WAF 配置' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: 'GET/PUT /api/v1/waf/config' }),
        el('button', { class: 'btn', type: 'button', text: '重新加载', onclick: () => { loadConfig(); } }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '保存配置', onclick: () => saveConfig() }),
      ),
      el('div', { class: 'card-body pwaf-panel' }, formBox),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '请求体检查策略' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: { 'font-size': '12px' }, text: 'GET/PUT /api/v1/waf/config' }),
        el('span', { class: 'muted', style: { 'font-size': '12px' }, text: '每 15 秒自动刷新' }),
        el('button', { class: 'btn', type: 'button', text: '刷新数据', onclick: () => { refreshWebRules().then(() => loadPolicy()); } }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '保存策略', onclick: () => savePolicy() }),
      ),
      el('div', { class: 'card-body pwaf-panel' }, policyBox),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '规则文件 / 规则组' }),
        el('span', { class: 'grow' }),
        rq,
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadRules() }),
      ),
      el('div', { class: 'card-body' }, rulesBox),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '请求测试' }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-primary', type: 'button', text: '测试', onclick: () => runTest() }),
      ),
      el('div', { class: 'card-body' },
        el('div', { class: 'pwaf-test' },
          testMethod,
          el('div', {}, testURL, el('div', { style: 'height:6px' }), testBody),
        ),
        testResult,
      ),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '拦截日志' }),
        el('span', { class: 'grow' }),
        el('span', { class: 'muted', style: 'font-size:12px', text: '每 10 秒自动刷新' }),
        el('button', { class: 'btn', type: 'button', text: '刷新', onclick: () => loadLogs() }),
      ),
      el('div', { class: 'card-body' }, logsBox),
    ));

    loadConfig();
    loadRules();
    loadLogs();
    loadPolicy();
    stopLogs = makePoller(() => loadLogs(), 10000);
    const stopPolicy = makePoller(() => reloadPolicy(), 15000);
    return () => { if (stopLogs) stopLogs(); if (stopPolicy) stopPolicy(); offStyle(); };
  },
};
