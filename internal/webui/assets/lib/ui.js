// nunt 控制台通用 UI 工具：DOM 构造、提示、弹窗、表格、表单。
//
// 这里的所有渲染默认走 textContent，绝不用 innerHTML 拼接数据，
// 避免把后端返回的字符串（主机名、文件名、日志内容）当成 HTML 执行。
// 只有页面模块提供的 24x24 SVG 图标字符串会被解析，且经过标签/属性白名单过滤。

/* ------------------------------------------------------------------ 基础工具 */

/** escapeHtml 转义 HTML 特殊字符。 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** fmtBytes 人类可读的字节数。 */
export function fmtBytes(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (!isFinite(num)) return '—';
  const neg = num < 0;
  let value = Math.abs(num);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  let text;
  if (i === 0) text = String(Math.round(value));
  else text = value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
  return (neg ? '-' : '') + text + ' ' + units[i];
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** fmtTime 本地时间文本；数字按秒或毫秒自动识别。 */
export function fmtTime(t) {
  if (t === null || t === undefined || t === '') return '—';
  let date;
  if (t instanceof Date) {
    date = t;
  } else if (typeof t === 'number') {
    date = new Date(t < 1e12 ? t * 1000 : t);
  } else {
    const text = String(t);
    date = new Date(text);
    if (isNaN(date.getTime())) {
      const num = Number(text);
      if (!isNaN(num) && text.trim() !== '') date = new Date(num < 1e12 ? num * 1000 : num);
    }
  }
  if (!date || isNaN(date.getTime())) return String(t);
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  );
}

/** fmtDuration 秒数 → “3 天 4 小时 5 分”。 */
export function fmtDuration(seconds) {
  const total = Number(seconds);
  if (!isFinite(total) || total < 0) return '—';
  const s = Math.floor(total);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  if (hours > 0) return hours + ' 小时 ' + mins + ' 分';
  if (mins > 0) return mins + ' 分 ' + secs + ' 秒';
  return secs + ' 秒';
}

/* ------------------------------------------------------------------ DOM 构造 */

function applyAttrs(node, attrs) {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      const text = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      if (text) node.setAttribute('class', text);
    } else if (key === 'style' && value && typeof value === 'object') {
      for (const prop of Object.keys(value)) {
        try {
          const name = prop.indexOf('-') >= 0 ? prop : prop.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
          node.style.setProperty(name, String(value[prop]));
        } catch (err) { /* 忽略非法样式 */ }
      }
    } else if (key === 'dataset' && value && typeof value === 'object') {
      for (const prop of Object.keys(value)) node.dataset[prop] = String(value[prop]);
    } else if (key === 'value' && 'value' in node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')) {
      node.value = value === true ? '' : String(value);
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'multiple' || key === 'required' || key === 'autofocus') {
      if (value) node.setAttribute(key, '');
      else node.removeAttribute(key);
      if (key === 'checked') node.checked = !!value;
      if (key === 'disabled') node.disabled = !!value;
      if (key === 'multiple') node.multiple = !!value;
    } else if (key === 'text') {
      node.textContent = value === null || value === undefined ? '' : String(value);
    } else if (key === 'html') {
      throw new Error('el(): 不支持 html 属性，请使用 textContent 或 renderIcon');
    } else if (key === 'on' && value && typeof value === 'object') {
      for (const eventName of Object.keys(value)) node.addEventListener(eventName, value[eventName]);
    } else if (/^on[a-z]+$/.test(key) && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

/**
 * el 创建元素：el('div', {class: 'card'}, '文本', childNode)
 * children 可以是节点、字符串、数字、数组，null/undefined/false 会被忽略。
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(node, child);
      continue;
    }
    if (child instanceof Node) {
      node.appendChild(child);
      continue;
    }
    node.appendChild(document.createTextNode(String(child)));
  }
}

/** frag 创建一个文档片段。 */
export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** clear 清空元素。 */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** text 创建纯文本节点。 */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

/* ------------------------------------------------------------------ 图标 */

const ICON_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const ICON_ATTRS = new Set([
  'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'points', 'fill-rule', 'clip-rule', 'opacity', 'class', 'transform',
]);

/**
 * renderIcon 把页面模块提供的 SVG 字符串转成安全元素；非法输入返回占位方块。
 */
export function renderIcon(svg) {
  const fallback = el('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'aria-hidden': 'true' },
    el('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
  );
  if (typeof svg !== 'string' || svg.indexOf('<') < 0) return fallback;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  } catch (err) {
    return fallback;
  }
  if (!doc || doc.getElementsByTagName('parsererror').length > 0) return fallback;
  const root = doc.documentElement;
  if (!root || String(root.nodeName).toLowerCase() !== 'svg') return fallback;
  const out = el('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' });
  for (const attr of Array.from(root.attributes)) {
    const name = attr.name.toLowerCase();
    if (ICON_ATTRS.has(name)) out.setAttribute(name, attr.value);
  }
  let count = 0;
  for (const child of Array.from(root.children)) {
    if (count > 64) break;
    const node = cloneIconNode(child);
    if (node) {
      out.appendChild(node);
      count += 1;
    }
  }
  if (count === 0) return fallback;
  return out;
}

function cloneIconNode(src) {
  const tag = String(src.nodeName).toLowerCase();
  if (!ICON_TAGS.has(tag) || tag === 'svg') return null;
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const attr of Array.from(src.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ICON_ATTRS.has(name)) continue;
    if (name === 'class') continue;
    node.setAttribute(name, attr.value);
  }
  for (const child of Array.from(src.children)) {
    const nested = cloneIconNode(child);
    if (nested) node.appendChild(nested);
  }
  return node;
}

/* ------------------------------------------------------------------ 提示 */

const TOAST_TYPES = new Set(['ok', 'warn', 'err', 'info']);
let toastHost = null;

function ensureHost(className) {
  let host = document.querySelector('.' + className);
  if (!host) {
    host = el('div', { class: className, role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

/** toast 右下…右上角提示，type: ok | warn | err | info。 */
export function toast(msg, type) {
  const kind = TOAST_TYPES.has(type) ? type : 'info';
  toastHost = ensureHost('toast-host');
  const node = el('div', { class: 'toast ' + kind }, String(msg === undefined || msg === null ? '' : msg));
  toastHost.appendChild(node);
  const timer = setTimeout(() => {
    node.classList.add('hide');
    setTimeout(() => node.remove(), 220);
  }, kind === 'err' ? 6000 : 3200);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
  return node;
}

/* ------------------------------------------------------------------ 弹窗 */

/**
 * openModal 打开对话框。
 * options: { title, body, actions: [{label, kind, onClick, close}], wide, onClose, onMount }
 * 返回 { root, card, body, footer, close(), setBusy(bool) }。
 */
export function openModal(options) {
  const opts = options || {};
  const bodyNode = el('div', { class: 'modal-body' });
  if (opts.body instanceof Node) bodyNode.appendChild(opts.body);
  else if (typeof opts.body === 'string') bodyNode.textContent = opts.body;

  const footerNode = el('div', { class: 'modal-footer' });
  const card = el('div', { class: 'modal-card' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
  card.setAttribute('aria-labelledby', titleId);

  const closeBtn = el('button', {
    class: 'icon-btn', type: 'button', title: '关闭', 'aria-label': '关闭',
    on: { click: () => close() },
  }, renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'));

  const header = el('div', { class: 'modal-header' },
    el('span', { id: titleId }, String(opts.title || '')),
    el('span', { class: 'spacer' }),
    closeBtn,
  );

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
    if (typeof opts.onClose === 'function') {
      try { opts.onClose(); } catch (err) { /* 回调异常不影响关闭 */ }
    }
  }

  function onKey(event) {
    if (event.key === 'Escape' && opts.onEscape !== false) {
      event.preventDefault();
      close();
    }
  }

  const api0 = {
    root,
    card,
    body: bodyNode,
    footer: footerNode,
    buttons: {},
    close,
    setBusy(busy) {
      for (const btn of footerNode.querySelectorAll('button')) btn.disabled = !!busy;
    },
  };

  for (const action of opts.actions || []) {
    if (!action) continue;
    if (action.spacer) {
      footerNode.appendChild(el('span', { class: 'spacer' }));
      continue;
    }
    const kind = action.kind === 'primary' ? 'btn btn-primary'
      : action.kind === 'danger' ? 'btn btn-danger'
        : action.kind === 'ghost' ? 'btn btn-ghost' : 'btn';
    const btn = el('button', { class: kind, type: 'button', disabled: !!action.disabled }, String(action.label || ''));
    btn.addEventListener('click', async () => {
      if (typeof action.onClick !== 'function') {
        close();
        return;
      }
      try {
        const result = await action.onClick(api0);
        if (result !== false && action.close !== false) close();
      } catch (err) {
        /* 由调用方决定如何提示 */
      }
    });
    footerNode.appendChild(btn);
    api0.buttons[String(action.label || '')] = btn;
  }

  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.classList.add('modal-open');
  document.body.appendChild(root);

  const first = card.querySelector('input, select, textarea, button.btn-primary');
  if (first) {
    try { first.focus(); } catch (err) { /* 忽略 */ }
  }

  if (typeof opts.onMount === 'function') {
    try { opts.onMount(api0); } catch (err) { /* 忽略 */ }
  }
  return api0;
}

/** confirmDialog 确认框，返回 Promise<boolean>。 */
export function confirmDialog(msg, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const modal = openModal({
      title: opts.title || '请确认',
      body: el('div', null, el('p', { style: { margin: '0' } }, String(msg === undefined ? '' : msg)),
        opts.hint ? el('p', { class: 'muted', style: { margin: '8px 0 0', fontSize: '12px' } }, String(opts.hint)) : null),
      actions: [
        { label: opts.cancelLabel || '取消', onClick: () => finish(false) },
        { label: opts.okLabel || '确定', kind: opts.danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
    const danger = modal.footer.querySelector('.btn-danger');
    if (danger) danger.focus();
  });
}

/** promptDialog 单行输入框，返回 Promise<string|null>。 */
export function promptDialog(msg, def, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const input = el('input', {
      class: 'input',
      type: opts.type || 'text',
      value: def === undefined || def === null ? '' : String(def),
      placeholder: opts.placeholder || '',
    });
    const form = el('div', null,
      el('div', { class: 'field' }, el('label', null, String(msg === undefined ? '' : msg)), input),
    );
    const submit = () => finish(input.value);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
        if (modal) modal.close();
      }
    });
    const modal = openModal({
      title: opts.title || '输入',
      body: form,
      actions: [
        { label: '取消', onClick: () => finish(null) },
        { label: opts.okLabel || '确定', kind: 'primary', onClick: () => { submit(); } },
      ],
      onClose: () => finish(null),
    });
  });
}

/* ------------------------------------------------------------------ 表格 */

function cellContent(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Node) return value;
  if (Array.isArray(value)) {
    const span = el('span', { class: 'row' });
    for (const item of value) {
      const node = cellContent(item);
      if (node instanceof Node) span.appendChild(node);
      else span.appendChild(document.createTextNode(String(node)));
    }
    return span;
  }
  if (typeof value === 'function') {
    try { return cellContent(value()); } catch (err) { return ''; }
  }
  return String(value);
}

/**
 * renderTable 渲染表格。
 * config: { columns: [{key, title|label, render, width, align, className}], rows: [], empty, onPage, page }
 * 没有 columns 时：rows 为对象数组则按键自动成列；rows 为数组的数组则按位置取值。
 */
export function renderTable(container, config) {
  const cfg = config || {};
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return null;
  clear(host);

  let columns = cfg.columns;
  const rows = Array.isArray(cfg.rows) ? cfg.rows : [];
  if (!columns || !columns.length) {
    if (rows.length && !Array.isArray(rows[0]) && typeof rows[0] === 'object') {
      columns = Object.keys(rows[0]).map((key) => ({ key, title: key }));
    } else {
      const width = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
      columns = [];
      for (let i = 0; i < width; i += 1) columns.push({ key: i, title: '#' + (i + 1) });
    }
  }

  if (!rows.length) {
    const message = cfg.empty === undefined ? '暂无数据' : cfg.empty;
    if (message) host.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-title' }, String(message))));
    return null;
  }

  const thead = el('thead', null, el('tr', null, columns.map((col) => {
    const th = el('th', null, String(col.title === undefined ? (col.label || col.key || '') : col.title));
    if (col.width) th.style.width = typeof col.width === 'number' ? col.width + 'px' : String(col.width);
    if (col.align) th.style.textAlign = col.align;
    return th;
  })));
  const tbody = el('tbody', null, rows.map((row, index) => el('tr', null, columns.map((col) => {
    let value;
    if (typeof col.render === 'function') value = col.render(row, index);
    else if (Array.isArray(row)) value = row[col.key];
    else value = row ? row[col.key] : '';
    const td = el('td', { class: col.className || null }, cellContent(value));
    if (col.align) td.style.textAlign = col.align;
    return td;
  }))));

  const table = el('table', { class: 'table' }, thead, tbody);
  host.appendChild(table);

  if (cfg.onPage) {
    const page = Math.max(1, Number(cfg.page) || 1);
    const nav = el('div', { class: 'pager' },
      el('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, on: { click: () => cfg.onPage(page - 1) } }, '上一页'),
      el('span', null, '第 ' + page + ' 页'),
      el('button', { class: 'btn btn-sm', type: 'button', disabled: !cfg.hasNext, on: { click: () => cfg.onPage(page + 1) } }, '下一页'),
    );
    host.appendChild(nav);
  }
  return table;
}

/* ------------------------------------------------------------------ 表单 */

/**
 * formGrid 生成字段表单。
 * fields: [{ name, label, type, value, options, placeholder, hint, min, max, step, rows, required, wide, disabled, onChange }]
 * type: text | password | number | url | email | textarea | select | switch | checkbox | tags | kv | html
 * 返回值带 read() / set(name, value) / get(name) / node / fields。
 */
export function formGrid(fields, options) {
  const opts = options || {};
  const list = Array.isArray(fields) ? fields : [];
  const grid = el('div', { class: opts.class || 'grid' });
  const controls = new Map();
  const wrappers = new Map();

  for (const field of list) {
    if (!field) continue;
    const name = String(field.name || '');
    const type = field.type || 'text';
    const wrapper = el('div', { class: 'field' + (field.wide ? ' wide' : '') });
    if (field.wide) wrapper.style.gridColumn = '1 / -1';
    if (field.label !== false && field.label !== undefined) {
      wrapper.appendChild(el('label', null, String(field.label)));
    }
    let control = null;
    let read = null;
    let write = null;

    const readonly = !!field.readonly;
    const disabled = !!field.disabled;

    if (type === 'html') {
      control = field.node instanceof Node ? field.node : el('div', null, String(field.value === undefined ? '' : field.value));
      read = () => null;
      write = () => {};
    } else if (type === 'textarea') {
      control = el('textarea', { class: 'input', rows: field.rows || 4, placeholder: field.placeholder || null, disabled, readonly, on: field.onChange ? { input: field.onChange } : null });
      control.value = field.value === undefined || field.value === null ? '' : String(field.value);
      read = () => control.value;
      write = (value) => { control.value = value === undefined || value === null ? '' : String(value); };
    } else if (type === 'select') {
      control = el('select', { class: 'select', disabled, on: field.onChange ? { change: field.onChange } : null });
      const choices = Array.isArray(field.options) ? field.options : [];
      const multiple = !!field.multiple;
      if (multiple) control.multiple = true;
      for (const choice of choices) {
        const value = typeof choice === 'object' && choice !== null ? choice.value : choice;
        const label = typeof choice === 'object' && choice !== null ? (choice.label === undefined ? choice.value : choice.label) : choice;
        const option = el('option', { value: value === undefined || value === null ? '' : String(value) }, String(label));
        control.appendChild(option);
      }
      const current = field.value === undefined || field.value === null ? '' : (Array.isArray(field.value) ? field.value.map(String) : [String(field.value)]);
      for (const option of Array.from(control.options)) option.selected = current.indexOf(option.value) >= 0;
      read = () => (multiple ? Array.from(control.selectedOptions).map((o) => o.value) : control.value);
      write = (value) => {
        const next = Array.isArray(value) ? value.map(String) : [value === undefined || value === null ? '' : String(value)];
        for (const option of Array.from(control.options)) option.selected = next.indexOf(option.value) >= 0;
      };
    } else if (type === 'switch' || type === 'checkbox') {
      const input = el('input', { type: 'checkbox', disabled, on: field.onChange ? { change: field.onChange } : null });
      input.checked = !!field.value;
      if (type === 'switch') {
        control = el('label', { class: 'switch' }, input, el('span', { class: 'track' }), el('span', null, String(field.text || '')));
      } else {
        control = el('label', { class: 'check' }, input, el('span', null, String(field.text || '')));
      }
      read = () => input.checked;
      write = (value) => { input.checked = !!value; };
      controls.set('__input__' + name, input);
    } else if (type === 'tags') {
      const input = el('input', { class: 'input', placeholder: field.placeholder || '用逗号或换行分隔', disabled });
      const value = Array.isArray(field.value) ? field.value.join(', ') : (field.value || '');
      input.value = String(value);
      control = input;
      read = () => input.value.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
      write = (next) => { input.value = Array.isArray(next) ? next.join(', ') : String(next === undefined || next === null ? '' : next); };
    } else if (type === 'kv') {
      const editor = createKVEditor(field.value, field);
      control = editor.node;
      read = () => editor.read();
      write = (value) => editor.set(value);
    } else {
      const input = el('input', {
        class: 'input',
        type: type === 'password' ? 'password' : (type === 'number' ? 'number' : (type === 'url' ? 'url' : (type === 'email' ? 'email' : 'text'))),
        placeholder: field.placeholder || null,
        disabled,
        readonly,
        autocomplete: field.autocomplete || 'off',
        min: field.min === undefined ? null : field.min,
        max: field.max === undefined ? null : field.max,
        step: field.step === undefined ? null : field.step,
        on: field.onChange ? { input: field.onChange } : null,
      });
      control = input;
      control.value = field.value === undefined || field.value === null ? '' : String(field.value);
      read = () => (type === 'number' ? (control.value === '' ? null : Number(control.value)) : control.value);
      write = (value) => { control.value = value === undefined || value === null ? '' : String(value); };
    }

    wrapper.appendChild(control);
    if (field.hint) wrapper.appendChild(el('div', { class: 'hint' }, String(field.hint)));
    grid.appendChild(wrapper);
    if (name) {
      controls.set(name, { read, write, control, field });
      wrappers.set(name, wrapper);
    }
  }

  const api0 = {
    node: grid,
    fields: list,
    get(name) {
      const entry = controls.get(name);
      return entry ? entry.read() : undefined;
    },
    set(name, value) {
      const entry = controls.get(name);
      if (entry) entry.write(value);
    },
    read() {
      const out = {};
      for (const [name, entry] of controls) {
        if (name.startsWith('__input__')) continue;
        out[name] = entry.read();
      }
      return out;
    },
    input(name) {
      const entry = controls.get('__input__' + name) || controls.get(name);
      return entry ? (entry.control || null) : null;
    },
    wrapper(name) {
      return wrappers.get(name) || null;
    },
    toggle(name, visible) {
      const wrapper = wrappers.get(name);
      if (wrapper) wrapper.classList.toggle('hidden', !visible);
    },
    error(message) {
      const old = grid.querySelector('.form-error');
      if (old) old.remove();
      if (!message) return;
      const node = el('div', { class: 'form-error', style: { gridColumn: '1 / -1', color: 'var(--err)', fontSize: '13px' } }, String(message));
      grid.insertBefore(node, grid.firstChild);
    },
  };
  return api0;
}

function createKVEditor(value, field) {
  const list = el('div', { class: 'kv-editor' });
  const addRow = (key, val) => {
    const keyInput = el('input', { class: 'input', placeholder: '名称', autocomplete: 'off' });
    const valueInput = el('input', { class: 'input', placeholder: '值', autocomplete: 'off' });
    keyInput.value = key === undefined || key === null ? '' : String(key);
    valueInput.value = val === undefined || val === null ? '' : String(val);
    const row = el('div', { class: 'kv-row' }, keyInput, valueInput,
      el('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': '删除', on: { click: () => row.remove() } },
        renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>')));
    list.appendChild(row);
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) addRow(key, value[key]);
  } else if (Array.isArray(value)) {
    for (const item of value) addRow(item && item.key, item && item.value);
  }
  const add = el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => addRow('', '') } }, '+ 添加一项');
  const node = el('div', null, list, add);
  return {
    node,
    read() {
      const out = {};
      for (const row of Array.from(list.children)) {
        const inputs = row.querySelectorAll('input');
        const key = inputs[0] ? inputs[0].value.trim() : '';
        const val = inputs[1] ? inputs[1].value : '';
        if (key) out[key] = val;
      }
      return out;
    },
    set(next) {
      clear(list);
      if (next && typeof next === 'object') {
        for (const key of Object.keys(next)) addRow(key, next[key]);
      }
    },
  };
}

/* ------------------------------------------------------------------ 其它 */

/** setBusy 按钮忙碌状态（用克隆节点保存/恢复原内容，不使用 innerHTML），返回恢复函数。 */
export function setBusy(btn, busy) {
  if (!btn) return () => {};
  if (!busy) {
    btn.disabled = false;
    return () => {};
  }
  const saved = Array.from(btn.childNodes).map((node) => node.cloneNode(true));
  btn.disabled = true;
  btn.dataset.busy = '1';
  clear(btn);
  btn.appendChild(el('span', { class: 'spinner', style: { width: '13px', height: '13px', borderWidth: '2px' } }));
  return () => {
    btn.disabled = false;
    delete btn.dataset.busy;
    clear(btn);
    for (const node of saved) btn.appendChild(node);
  };
}

/** downloadText 触发浏览器下载。 */
export function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default {
  el,
  toast,
  confirmDialog,
  promptDialog,
  openModal,
  fmtBytes,
  fmtTime,
  fmtDuration,
  escapeHtml,
  renderTable,
  formGrid,
  renderIcon,
  setBusy,
  downloadText,
  clear,
};
