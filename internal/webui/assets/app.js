// nunt 控制台外壳：登录、布局、hash 路由、页面懒加载、SSE 事件总线、主题。
import { api, setCsrf, onUnauthorized } from './lib/api.js';
import {
  el, toast, confirmDialog as uiConfirm, promptDialog, openModal,
  fmtBytes, fmtTime, escapeHtml, renderIcon, clear,
} from './lib/ui.js';

/* ------------------------------------------------------------------ 页面清单 */

const PAGES = [
  { id: 'dashboard', title: '概览', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>' },
  { id: 'web', title: 'Web 服务', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 3 2.6 15 0 18-2.6-3-2.6-15 0-18z"/></svg>' },
  { id: 'forward', title: '端口转发', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13"/><path d="M14 5l3 3-3 3"/><path d="M20 16H7"/><path d="M10 13l-3 3 3 3"/></svg>' },
  { id: 'ddns', title: '动态域名', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3v18"/></svg>' },
  { id: 'acme', title: '证书', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20l2-4 2 3 2-3 2 4"/></svg>' },
  { id: 'storage', title: '存储', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>' },
  { id: 'files', title: '文件', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 012-2h3.5l2 2H18a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/></svg>' },
  { id: 'waf', title: 'WAF', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>' },
  { id: 'task', title: '计划任务', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/></svg>' },
  { id: 'notify', title: '通知', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 19a2 2 0 004 0"/></svg>' },
  { id: 'logs', title: '日志', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>' },
  { id: 'settings', title: '设置', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2 2 2 0 11-4 0 1.7 1.7 0 00-2.9-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 15a2 2 0 010-4 1.7 1.7 0 001.2-2.9l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 4.1a2 2 0 014 0A1.7 1.7 0 0016.9 5.3l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 11a2 2 0 010 4z"/></svg>' },
];
const PAGE_MAP = new Map(PAGES.map((page) => [page.id, page]));
const DEFAULT_PAGE = 'dashboard';
const THEME_KEY = 'nunt.theme';

/* ------------------------------------------------------------------ 全局状态 */

const state = {
  ready: false,
  username: '',
  admin: false,
  mustChangePassword: false,
  info: null,
  infoError: null,
  modules: [],
  modulesError: null,
  sse: 'idle',
  theme: 'dark',
  pageId: '',
  navOpen: false,
};

const dom = {
  app: null,
  layout: null,
  sidebar: null,
  nav: null,
  mainBody: null,
  topTitle: null,
  topStatus: null,
  topMeta: null,
  sseStatus: null,
  content: null,
};

const subscribers = new Set();
let pendingHash = '';
let pendingHashTimer = null;

function markPendingHash(hash) {
  pendingHash = hash;
  if (pendingHashTimer) clearTimeout(pendingHashTimer);
  // 兜底：即使浏览器没有派发 hashchange（例如 hash 相同或事件被吞掉），标记也会过期。
  pendingHashTimer = setTimeout(clearPendingHash, 400);
}

function clearPendingHash() {
  pendingHash = '';
  if (pendingHashTimer) {
    clearTimeout(pendingHashTimer);
    pendingHashTimer = null;
  }
}
let cleanupCurrent = null;
let navToken = 0;
let sseSource = null;
let sseRetry = 0;
let sseTimer = null;

/* ------------------------------------------------------------------ 主题 */

function readStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'dark' || value === 'light') return value;
  } catch (err) { /* 隐私模式下忽略 */ }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch (err) { /* 忽略 */ }
  return 'dark';
}

function applyTheme(theme, persist) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, state.theme); } catch (err) { /* 忽略 */ }
  }
  const button = dom.topMeta ? dom.topMeta.querySelector('[data-theme-toggle]') : null;
  if (button) {
    button.title = state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    button.setAttribute('aria-label', button.title);
    clear(button);
    button.appendChild(state.theme === 'dark'
      ? renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>')
      : renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>'));
  }
}

/* ------------------------------------------------------------------ 上下文 */

function onSSE(handler) {
  if (typeof handler !== 'function') return () => {};
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

const ctx = {
  api,
  toast,
  confirm: (msg, options) => uiConfirm(msg, options),
  prompt: (msg, def) => promptDialog(msg, def),
  state,
  navigate,
  onSSE,
  fmtBytes,
  fmtTime,
  escapeHtml,
  theme: {
    get: () => state.theme,
    set: (value) => applyTheme(value, true),
  },
};

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  dom.app = document.getElementById('app');
  applyTheme(readStoredTheme(), false);
  onUnauthorized(() => {
    if (state.ready) {
      toast('登录状态已失效，请重新登录', 'warn');
      stopSSE();
      showLogin();
    }
  });
  window.addEventListener('hashchange', () => {
    // 应用自己发起的跳转（navigate / 登录后补默认页）已经同步触发了路由，
    // 这里只处理用户手动改 hash、浏览器前进后退等外部变化。
    if (pendingHash && location.hash === pendingHash) {
      clearPendingHash();
      return;
    }
    clearPendingHash();
    route().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.ready && !sseSource) connectSSE();
  });
  window.addEventListener('storage', (event) => {
    if (event && event.key === THEME_KEY && (event.newValue === 'dark' || event.newValue === 'light')) {
      applyTheme(event.newValue, false);
    }
  });

  state.ready = false;
  let session = null;
  try {
    session = await api.get('/api/v1/auth/session');
  } catch (err) {
    session = null;
  }
  if (session && session.username) {
    applySession(session);
    await afterLogin();
  } else {
    showLogin();
  }
}

function applySession(session) {
  state.username = String(session.username || '');
  state.admin = !!session.admin;
  state.mustChangePassword = !!session.mustChangePassword;
  setCsrf(session.csrf || '');
}

/* ------------------------------------------------------------------ 登录界面 */

function showLogin(message) {
  state.ready = false;
  state.pageId = '';
  // index.html 里的 #app 可能在运行期被替换（页面重载/重新挂载），每次都重新取一次。
  dom.app = document.getElementById('app');
  if (cleanupCurrent) {
    try { cleanupCurrent(); } catch (err) { /* 忽略 */ }
    cleanupCurrent = null;
  }
  clear(dom.app);
  document.body.classList.remove('modal-open');
  closeAllModals();

  const usernameInput = el('input', { class: 'input', name: 'username', autocomplete: 'username', placeholder: '用户名', required: true, autofocus: true });
  const passwordInput = el('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', placeholder: '密码', required: true });
  const alert = el('div', { class: 'login-alert hidden' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit', style: { width: '100%' } }, '登录');
  const spinner = el('span', { class: 'spinner hidden', style: { width: '14px', height: '14px', borderWidth: '2px' } });

  const form = el('form', { novalidate: true },
    alert,
    el('div', { class: 'field' }, el('label', null, '用户名'), usernameInput),
    el('div', { class: 'field' }, el('label', null, '密码'), passwordInput),
    el('div', { class: 'row', style: { marginTop: '4px' } }, submit, spinner),
  );

  function showError(text) {
    alert.textContent = text;
    alert.classList.remove('hidden');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alert.classList.add('hidden');
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      showError('请输入用户名和密码');
      return;
    }
    submit.disabled = true;
    spinner.classList.remove('hidden');
    try {
      const result = await api.post('/api/v1/auth/login', { username, password });
      setCsrf(result && result.csrf ? result.csrf : '');
      state.username = String((result && result.username) || username);
      state.mustChangePassword = !!(result && result.mustChangePassword);
      let session = null;
      try { session = await api.get('/api/v1/auth/session'); } catch (err) { session = null; }
      if (session) applySession(session);
      else state.admin = true;
      form.reset();
      await afterLogin();
    } catch (err) {
      showError(err && err.message ? err.message : '登录失败');
      passwordInput.value = '';
      passwordInput.focus();
    } finally {
      submit.disabled = false;
      spinner.classList.add('hidden');
    }
  });

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-body' },
      el('div', { class: 'login-brand' },
        el('span', { class: 'brand-mark' }, 'n'),
        el('span', { class: 'name' }, 'nunt'),
      ),
      form,
    ),
  );

  dom.app.appendChild(el('div', { class: 'login' },
    el('div', { class: 'login-card' },
      message ? el('div', { class: 'login-alert', style: { marginBottom: '12px' } }, message) : null,
      card,
      el('div', { class: 'login-foot' }, '轻量级反向代理与内网穿透控制台'),
    ),
  ));
  setTimeout(() => { try { usernameInput.focus(); } catch (err) { /* 忽略 */ } }, 0);
}

function closeAllModals() {
  for (const node of Array.from(document.querySelectorAll('.modal'))) node.remove();
}

/* ------------------------------------------------------------------ 登录之后 */

async function afterLogin() {
  if (state.mustChangePassword) {
    await forceChangePassword();
  }
  state.ready = true;
  renderShell();
  startSSE();
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    markPendingHash('#/' + DEFAULT_PAGE);
    location.hash = pendingHash;
  }
  await route();
  await loadInfo();
}

function forceChangePassword() {
  return new Promise((resolve) => {
    const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const again = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const error = el('div', { class: 'field error hidden' });
    const form = el('div', null,
      el('div', { class: 'notice' }, '当前账号要求修改初始密码后才能继续使用控制台。'),
      el('div', { class: 'field' }, el('label', null, '当前密码'), current),
      el('div', { class: 'field' }, el('label', null, '新密码（至少 8 位）'), next),
      el('div', { class: 'field' }, el('label', null, '确认新密码'), again),
      error,
    );
    const modal = openModal({
      title: '修改密码',
      body: form,
      onEscape: false,
      actions: [
        {
          label: '退出登录',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            await logout();
            modal.close();
            resolve();
          },
        },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async () => {
            error.classList.add('hidden');
            if (next.value.length < 8) {
              error.textContent = '新密码至少需要 8 位';
              error.classList.remove('hidden');
              return;
            }
            if (next.value !== again.value) {
              error.textContent = '两次输入的新密码不一致';
              error.classList.remove('hidden');
              return;
            }
            modal.setBusy(true);
            try {
              await api.post('/api/v1/auth/password', { current: current.value, new: next.value });
              state.mustChangePassword = false;
              toast('密码已更新，请使用新密码重新登录', 'ok');
              modal.close();
              await logout();
              resolve();
            } catch (err) {
              error.textContent = err && err.message ? err.message : '修改失败';
              error.classList.remove('hidden');
            } finally {
              modal.setBusy(false);
            }
          },
        },
      ],
      onClose: () => resolve(),
    });
  });
}

async function logout() {
  try {
    await api.post('/api/v1/auth/logout', {});
  } catch (err) { /* 即使失败也要回到登录页 */ }
  setCsrf('');
  state.username = '';
  state.admin = false;
  state.info = null;
  stopSSE();
  if (location.hash) location.hash = '';
  showLogin();
}

/* ------------------------------------------------------------------ 外壳布局 */

function renderShell() {
  dom.app = document.getElementById('app');
  clear(dom.app);
  dom.nav = el('nav', { class: 'nav', 'aria-label': '主导航' });

  const sidebar = el('aside', { class: 'sidebar' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand-mark' }, 'n'),
      el('span', null, 'nunt', el('span', { class: 'brand-sub' }, '控制台')),
    ),
    dom.nav,
    el('div', { class: 'sidebar-foot' },
      el('div', { class: 'row' },
        el('span', { class: 'muted mono', 'data-version': '1' }, '—'),
        el('span', { class: 'spacer', style: { flex: '1' } }),
      ),
    ),
  );

  const menuBtn = el('button', {
    class: 'icon-btn menu-btn', type: 'button', title: '展开导航', 'aria-label': '展开导航',
    on: { click: () => dom.layout.classList.toggle('nav-open') },
  }, renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'));

  dom.topTitle = el('div', { class: 'title' }, '概览');
  dom.sseStatus = statusBadge('连接中', 'warn');
  const themeBtn = el('button', { class: 'icon-btn', type: 'button', 'data-theme-toggle': '1', 'data-compact-hide': '1' });
  themeBtn.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
    toast(state.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  });
  const passwordBtn = el('button', {
    class: 'icon-btn', type: 'button', title: '修改密码', 'aria-label': '修改密码', 'data-compact-hide': '1',
    on: { click: () => openChangePassword() },
  }, renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>'));
  const logoutBtn = el('button', {
    class: 'icon-btn', type: 'button', title: '退出登录', 'aria-label': '退出登录',
    on: {
      click: async () => {
        if (await uiConfirm('确定要退出登录吗？', { danger: true, okLabel: '退出登录' })) await logout();
      },
    },
  }, renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/></svg>'));

  dom.topMeta = el('div', { class: 'meta' }, dom.sseStatus);
  const topbar = el('header', { class: 'topbar' },
    menuBtn,
    dom.topTitle,
    el('div', { class: 'spacer' }),
    el('div', { class: 'meta' },
      el('span', { class: 'mono', 'data-version': '1' }, '—'),
      el('span', null, state.username),
    ),
    dom.topMeta,
    themeBtn,
    passwordBtn,
    logoutBtn,
  );

  dom.content = el('section', { class: 'content', id: 'content', tabindex: '-1' });
  const skipLink = el('a', { class: 'skip-link', href: '#content' }, '跳到主要内容');
  dom.mainBody = el('div', { class: 'main' }, topbar, dom.content);
  const backdrop = el('button', { class: 'sidebar-backdrop', type: 'button', 'aria-label': '关闭导航', on: { click: () => dom.layout.classList.remove('nav-open') } });
  dom.layout = el('div', { class: 'layout' }, skipLink, sidebar, dom.mainBody, backdrop);
  dom.app.appendChild(dom.layout);

  applyTheme(state.theme, false);
  renderNav();
  applyInfoToShell();
}

function statusBadge(text, kind) {
  return el('span', { class: 'status' + (kind ? ' ' + kind : '') }, el('span', { class: 'dot' }), el('span', { class: 'label' }, text));
}

function setStatus(node, text, kind) {
  if (!node) return;
  node.className = 'status' + (kind ? ' ' + kind : '');
  const label = node.querySelector('.label');
  if (label) label.textContent = text;
}

function renderNav() {
  if (!dom.nav) return;
  clear(dom.nav);
  for (const page of PAGES) {
    const button = el('button', {
      class: 'nav-item' + (page.id === state.pageId ? ' active' : ''),
      type: 'button',
      'data-page': page.id,
      title: page.title,
    }, renderIcon(page.icon), el('span', { class: 'nav-text' }, page.title));
    button.addEventListener('click', () => {
      dom.layout.classList.remove('nav-open');
      navigate(page.id);
    });
    dom.nav.appendChild(button);
  }
}

function applyInfoToShell() {
  const version = state.info && state.info.version ? state.info.version : '—';
  for (const node of Array.from(document.querySelectorAll('[data-version]'))) {
    node.textContent = version === '—' ? '—' : 'v' + version;
    node.title = state.info && state.info.commit ? '提交 ' + state.info.commit : '版本信息';
  }
}

async function loadInfo(force) {
  if (state.info && !force) {
    // 页面可能已经填好了信息，这里只负责把它同步到外壳。
    if (state.ready) applyInfoToShell();
    return state.info;
  }
  try {
    const info = await api.get('/api/v1/system/info');
    state.info = info || {};
    state.infoError = null;
  } catch (err) {
    state.infoError = err;
  }
  if (state.ready) applyInfoToShell();
  return state.info;
}

/* ------------------------------------------------------------------ 路由 */

function parseHash() {
  let raw = String(location.hash || '').replace(/^#\/?/, '');
  const qIndex = raw.indexOf('?');
  let query = '';
  if (qIndex >= 0) {
    query = raw.slice(qIndex + 1);
    raw = raw.slice(0, qIndex);
  }
  const id = raw.replace(/\/+$/, '');
  const params = new URLSearchParams(query);
  return { id, params };
}

function navigate(id, params) {
  const target = PAGE_MAP.has(id) ? id : DEFAULT_PAGE;
  let hash = '#/' + target;
  if (params) {
    const search = new URLSearchParams();
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value === undefined || value === null || value === '') continue;
      search.append(key, String(value));
    }
    const qs = search.toString();
    if (qs) hash += '?' + qs;
  }
  if (location.hash === hash) {
    route().catch(() => {});
    return;
  }
  markPendingHash(hash);
  location.hash = hash;
  // 不等待 hashchange：立刻渲染，用户点击后没有任何延迟。
  route().catch(() => {});
}

async function route() {
  if (!state.ready) return;
  const { id, params } = parseHash();
  const pageId = PAGE_MAP.has(id) ? id : DEFAULT_PAGE;
  const meta = PAGE_MAP.get(pageId);
  const token = ++navToken;

  if (cleanupCurrent) {
    try { cleanupCurrent(); } catch (err) { /* 页面清理失败不应阻塞切换 */ }
    cleanupCurrent = null;
  }
  clear(dom.content);
  const loading = el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', null, '正在加载…'));
  dom.content.appendChild(loading);

  state.pageId = pageId;
  if (dom.topTitle) dom.topTitle.textContent = meta.title;
  if (dom.nav) {
    for (const item of Array.from(dom.nav.querySelectorAll('.nav-item'))) {
      item.classList.toggle('active', item.dataset.page === pageId);
    }
  }
  document.title = meta.title + ' · nunt';

  let module = null;
  try {
    module = await import('./pages/' + pageId + '.js');
  } catch (err) {
    module = null;
  }
  if (token !== navToken) return;

  const page = module && module.default ? module.default : null;
  if (!page) {
    clear(dom.content);
    dom.content.appendChild(el('div', { class: 'empty' },
      renderIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v5"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/><path d="M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>'),
      el('div', { class: 'empty-title' }, '页面“' + meta.title + '”暂时不可用'),
      el('div', { class: 'muted' }, '该页面的前端模块还未提供（内部错误：无法加载 pages/' + pageId + '.js）。'),
      el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => route() } }, '重试'),
    ));
    return;
  }

  if (page.title && dom.topTitle) dom.topTitle.textContent = page.title;

  const root = el('div', { class: 'page page-' + pageId });
  clear(dom.content);
  dom.content.appendChild(root);

  try {
    const cleanup = await page.mount(root, Object.assign({}, ctx, { params, pageId }));
    if (token !== navToken) {
      if (typeof cleanup === 'function') {
        try { cleanup(); } catch (err) { /* 忽略 */ }
      }
      return;
    }
    cleanupCurrent = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    if (token !== navToken) return;
    clear(root);
    root.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'empty-title' }, '页面渲染失败'),
      el('div', { class: 'muted' }, err && err.message ? err.message : String(err)),
      el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => route() } }, '重新加载'),
    ));
  }
}

/* ------------------------------------------------------------------ SSE */

function startSSE() {
  if (typeof window.EventSource !== 'function') {
    setStatus(dom.sseStatus, '不支持实时推送', 'warn');
    return;
  }
  if (!sseSource) connectSSE();
}

function connectSSE() {
  if (sseSource || !state.ready) return;
  setStatus(dom.sseStatus, sseRetry > 0 ? '正在重连…' : '连接中…', 'warn');
  let source;
  try {
    source = new EventSource('/api/v1/events', { withCredentials: true });
  } catch (err) {
    scheduleReconnect();
    return;
  }
  sseSource = source;
  state.sse = 'connecting';

  source.addEventListener('open', () => {
    if (source !== sseSource) return;
    sseRetry = 0;
    state.sse = 'open';
    setStatus(dom.sseStatus, '实时推送已连接', 'ok');
  });

  source.addEventListener('message', (event) => {
    if (source !== sseSource) return;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      payload = { type: 'log', data: { msg: event.data } };
    }
    dispatchSSE(payload);
  });

  source.addEventListener('error', () => {
    if (source !== sseSource) return;
    try { source.close(); } catch (err) { /* 忽略 */ }
    sseSource = null;
    state.sse = 'closed';
    setStatus(dom.sseStatus, '实时推送已断开', 'err');
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (sseTimer || !state.ready) return;
  const delay = Math.min(30000, 1500 * Math.pow(1.6, sseRetry));
  sseRetry += 1;
  sseTimer = setTimeout(() => {
    sseTimer = null;
    connectSSE();
  }, delay);
  if (sseRetry === 1 || sseRetry % 5 === 0) setStatus(dom.sseStatus, '实时推送已断开，正在重连…', 'err');
}

function stopSSE() {
  if (sseTimer) {
    clearTimeout(sseTimer);
    sseTimer = null;
  }
  if (sseSource) {
    try { sseSource.close(); } catch (err) { /* 忽略 */ }
    sseSource = null;
  }
  sseRetry = 0;
  state.sse = 'idle';
}

function dispatchSSE(payload) {
  if (!payload || typeof payload !== 'object') return;
  for (const handler of Array.from(subscribers)) {
    try {
      handler(payload);
    } catch (err) {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  }
  if (payload.type === 'modules' && payload.data) {
    state.modules = Array.isArray(payload.data) ? payload.data : state.modules;
  }
  if (payload.type === 'auth') {
    toast('账号信息已变更，请重新登录', 'warn');
    logout();
  }
}

/* ------------------------------------------------------------------ 修改密码 */

function openChangePassword() {
  const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const again = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const error = el('div', { class: 'field error hidden' });
  const modal = openModal({
    title: '修改密码',
    body: el('div', null,
      el('div', { class: 'field' }, el('label', null, '当前密码'), current),
      el('div', { class: 'field' }, el('label', null, '新密码（至少 8 位）'), next),
      el('div', { class: 'field' }, el('label', null, '确认新密码'), again),
      error,
    ),
    actions: [
      { label: '取消' },
      {
        label: '保存',
        kind: 'primary',
        close: false,
        onClick: async () => {
          error.classList.add('hidden');
          if (next.value.length < 8) {
            error.textContent = '新密码至少需要 8 位';
            error.classList.remove('hidden');
            return;
          }
          if (next.value !== again.value) {
            error.textContent = '两次输入的新密码不一致';
            error.classList.remove('hidden');
            return;
          }
          modal.setBusy(true);
          try {
            await api.post('/api/v1/auth/password', { current: current.value, new: next.value });
            toast('密码已更新，请重新登录', 'ok');
            modal.close();
            await logout();
          } catch (err) {
            error.textContent = err && err.message ? err.message : '修改失败';
            error.classList.remove('hidden');
          } finally {
            modal.setBusy(false);
          }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ 导出给页面 */

export { api, ctx, state, onSSE, navigate };

boot().catch((err) => {
  const app = document.getElementById('app');
  if (app) {
    clear(app);
    app.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'empty-title' }, '控制台初始化失败'),
      el('div', { class: 'muted' }, err && err.message ? err.message : String(err)),
    ));
  }
});
