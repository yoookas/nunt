// nunt 控制台外壳：登录、布局、hash 路由、页面懒加载、SSE 事件总线、主题。
//
// 阶段 1：外壳与登录页改用 Shoelace 组件（sl-drawer / sl-dropdown / sl-menu / sl-dialog /
// sl-badge / sl-icon-button / sl-input / sl-button / sl-alert / sl-card），自研部分用 Lit 写成
// light DOM（NuntElement.createRenderRoot() 返回 this），外观全部来自 style.css 的 token 映射。
// 路由、页面清单、动态 import、ctx 契约与 lib/api.js 与迁移前保持一致。
import { api, setCsrf, onUnauthorized } from './lib/api.js';
import {
  NuntElement, html, nothing, define, toast, confirmDialog, openDialog, promptDialog, formGrid,
  emptyState, loadingState, errorCard, infoVersionText, errorMessage,
} from './lib/kit.js';
import { renderIcon, fmtBytes, fmtTime, escapeHtml } from './lib/ui.js';

/* ------------------------------------------------------------------ 页面清单（保持不变） */

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
// 会话提示：未登录时 /api/v1/auth/session 会返回 401，浏览器网络层会把 401 记成一条
// console 错误。没登录过的浏览器直接渲染登录页、不做探测；登录成功后写这个标记，
// 之后刷新才会去恢复会话（详见 boot()）。
const SESSION_KEY = 'nunt.session';
const NARROW_QUERY = '(max-width: 900px)';

/* ------------------------------------------------------------------ 全局状态（字段与迁移前一致） */

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
  shell: null,
  nav: null,
  navSlot: null,
  drawerNavSlot: null,
  drawer: null,
  content: null,
  menu: null,
};

const subscribers = new Set();
let pendingHash = '';
let pendingHashTimer = null;
let cleanupCurrent = null;
let navToken = 0;
let sseSource = null;
let sseRetry = 0;
let sseTimer = null;
let narrowMedia = null;

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

/* ------------------------------------------------------------------ 主题（html 上切换 sl-theme-*） */

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

/** applyTheme：主题 = <html> 上的 sl-theme-dark / sl-theme-light（Shoelace 的设计 token 由此切换）。 */
function applyTheme(theme, persist) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  root.classList.toggle('sl-theme-dark', state.theme === 'dark');
  root.classList.toggle('sl-theme-light', state.theme === 'light');
  // 兼容：老页面/自定义样式里可能还在用 html[data-theme="light"]。
  root.setAttribute('data-theme', state.theme);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, state.theme); } catch (err) { /* 忽略 */ }
  }
  if (dom.shell) dom.shell.theme = state.theme;
}

function hasSessionHint() {
  try { return localStorage.getItem(SESSION_KEY) === '1'; } catch (err) { return true; }
}

function setSessionHint(on) {
  try {
    if (on) localStorage.setItem(SESSION_KEY, '1');
    else localStorage.removeItem(SESSION_KEY);
  } catch (err) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ 上下文（语义不变） */

function onSSE(handler) {
  if (typeof handler !== 'function') return () => {};
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

const ctx = {
  api,
  toast,
  confirm: (msg, options) => confirmDialog(msg, options),
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


/* ------------------------------------------------------------------ 登录页 */

class NuntLogin extends NuntElement {
  static properties = {
    errorText: { type: String },
    notice: { type: String },
    busy: { type: Boolean },
  };

  constructor() {
    super();
    this.errorText = '';
    this.notice = '';
    this.busy = false;
  }

  firstUpdated() {
    const input = this.querySelector('sl-input[name="username"]');
    if (input && typeof input.focus === 'function') {
      try { input.focus(); } catch (err) { /* 忽略 */ }
    }
  }

  field(name) {
    return this.querySelector('sl-input[name="' + name + '"]');
  }

  async submit() {
    const usernameInput = this.field('username');
    const passwordInput = this.field('password');
    const username = usernameInput ? String(usernameInput.value || '').trim() : '';
    const password = passwordInput ? String(passwordInput.value || '') : '';
    if (!username || !password) {
      this.errorText = '请输入用户名和密码';
      return;
    }
    this.busy = true;
    this.errorText = '';
    try {
      const result = await api.post('/api/v1/auth/login', { username, password });
      setCsrf(result && result.csrf ? result.csrf : '');
      state.username = String((result && result.username) || username);
      state.mustChangePassword = !!(result && result.mustChangePassword);
      setSessionHint(true);
      let session = null;
      try { session = await api.get('/api/v1/auth/session'); } catch (err) { session = null; }
      if (session) applySession(session);
      else state.admin = true;
      await afterLogin();
    } catch (err) {
      this.errorText = errorMessage(err, '登录失败');
      if (passwordInput) {
        passwordInput.value = '';
        try { passwordInput.focus(); } catch (err2) { /* 忽略 */ }
      }
    } finally {
      this.busy = false;
    }
  }

  render() {
    return html`<main class="login-main">
      <div class="login-card">
        ${this.notice ? html`<sl-alert variant="warning" open class="login-notice">${this.notice}</sl-alert>` : nothing}
        <sl-card>
          <div class="login-brand">
            <span class="brand-mark" aria-hidden="true">n</span>
            <h1 class="name">nunt</h1>
          </div>
          <form class="login-form" novalidate
            @submit=${(event) => { event.preventDefault(); this.submit(); }}
            @keydown=${(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              this.submit();
            }}>
            <sl-alert class=${'login-alert' + (this.errorText ? '' : ' hidden')} variant="danger" ?open=${!!this.errorText}>
              <sl-icon slot="icon" name="exclamation-octagon" aria-hidden="true"></sl-icon>
              ${this.errorText}
            </sl-alert>
            <sl-input name="username" label="用户名" autocomplete="username" placeholder="用户名" required></sl-input>
            <sl-input name="password" type="password" label="密码" autocomplete="current-password" placeholder="密码" password-toggle required></sl-input>
            <sl-button class="login-submit" type="submit" variant="primary" ?loading=${this.busy} ?disabled=${this.busy}>登录</sl-button>
          </form>
        </sl-card>
        <p class="login-foot">轻量级反向代理与内网穿透控制台</p>
      </div>
    </main>`;
  }
}

define('nunt-login', NuntLogin);

/* ------------------------------------------------------------------ 外壳 */

const SSE_STATES = {
  open: { variant: 'success', text: '实时推送已连接' },
  connecting: { variant: 'warning', text: '实时推送连接中…' },
  retry: { variant: 'warning', text: '实时推送已断开，正在重连…' },
  closed: { variant: 'danger', text: '实时推送已断开' },
  unsupported: { variant: 'warning', text: '浏览器不支持实时推送' },
  idle: { variant: 'neutral', text: '实时推送未启用' },
};

class NuntShell extends NuntElement {
  static properties = {
    pageId: { attribute: false },
    pageTitle: { type: String },
    username: { type: String },
    version: { type: String },
    versionTitle: { type: String },
    sse: { type: String },
    theme: { type: String },
  };

  constructor() {
    super();
    this.pageId = '';
    this.pageTitle = '';
    this.username = '';
    this.version = '—';
    this.versionTitle = '版本信息';
    this.sse = 'connecting';
    this.theme = 'dark';
  }

  firstUpdated() {
    const menuBtn = this.querySelector('#menuBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => openDrawer());
    const themeBtn = this.querySelector('#themeBtn');
    if (themeBtn) themeBtn.addEventListener('click', () => toggleTheme());
    const menu = this.querySelector('#userMenu sl-menu');
    if (menu) {
      menu.addEventListener('sl-select', (event) => {
        const value = event.detail && event.detail.item ? event.detail.item.value : '';
        if (value === 'password') openChangePassword();
        else if (value === 'logout') confirmLogout();
      });
    }
    const dropdown = this.querySelector('#userMenu');
    if (dropdown && typeof dropdown.addEventListener === 'function') {
      // sl-select 之后下拉要收起来（Shoelace 的 sl-menu 默认会关，但显式关一次更稳）。
      dropdown.addEventListener('sl-after-hide', () => { /* 无操作，保留钩子 */ });
    }
    const drawer = this.querySelector('#navDrawer');
    if (drawer) {
      drawer.addEventListener('sl-after-hide', () => {
        const link = dom.nav ? dom.nav.querySelector('.app-nav-item[aria-current="page"]') : null;
        if (link && typeof link.focus === 'function' && narrowMedia && narrowMedia.matches) {
          try { link.focus(); } catch (err) { /* 忽略 */ }
        }
      });
    }
  }

  render() {
    const sse = SSE_STATES[this.sse] || SSE_STATES.idle;
    const dark = this.theme === 'dark';
    return html`
      <a class="skip-link" href="#content">跳到主要内容</a>
      <div class="layout">
        <aside class="app-sidebar">
          <div class="app-brand">
            <span class="brand-mark" aria-hidden="true">n</span>
            <span class="app-brand-text">
              <span class="app-brand-name">nunt</span>
              <span class="brand-sub">控制台</span>
            </span>
          </div>
          <div class="app-sidebar-nav" id="navSlot"></div>
          <div class="app-sidebar-foot">
            <span class="mono" data-version="1" title=${this.versionTitle}>${this.version}</span>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <sl-icon-button class="menu-btn" id="menuBtn" name="list-ul" label="展开导航"></sl-icon-button>
            <h1 class="title">${this.pageTitle}</h1>
            <span class="spacer"></span>
            <span class="topbar-meta">
              <span class="mono" data-version="1">${this.version}</span>
            </span>
            <sl-badge class=${'sse-badge sse-' + this.sse} pill variant=${sse.variant} role="status" aria-live="polite">${sse.text}</sl-badge>
            <sl-icon-button id="themeBtn" name=${dark ? 'sun' : 'moon'}
              label=${dark ? '切换到浅色主题' : '切换到深色主题'}></sl-icon-button>
            <sl-dropdown id="userMenu" placement="bottom-end" distance="6">
              <sl-button slot="trigger" size="small" outline class="topbar-user">
                <sl-icon slot="prefix" name="person" aria-hidden="true"></sl-icon>${this.username || '账户'}<sl-icon slot="suffix" name="chevron-down" aria-hidden="true"></sl-icon>
              </sl-button>
              <sl-menu>
                <sl-menu-item value="password"><sl-icon slot="prefix" name="key" aria-hidden="true"></sl-icon>修改密码</sl-menu-item>
                <sl-menu-item value="logout"><sl-icon slot="prefix" name="box-arrow-right" aria-hidden="true"></sl-icon>退出登录</sl-menu-item>
              </sl-menu>
            </sl-dropdown>
          </header>
          <main class="content" id="content" tabindex="-1"></main>
        </div>
      </div>
      <sl-drawer id="navDrawer" label="主导航" placement="start" class="nav-drawer">
        <div class="app-sidebar-nav" id="drawerNavSlot"></div>
      </sl-drawer>`;
  }
}

define('nunt-shell', NuntShell);

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  dom.app = document.getElementById('app');
  applyTheme(readStoredTheme(), false);
  if (window.matchMedia) {
    narrowMedia = window.matchMedia(NARROW_QUERY);
    const onChange = () => syncNavPlacement();
    if (typeof narrowMedia.addEventListener === 'function') narrowMedia.addEventListener('change', onChange);
    else if (typeof narrowMedia.addListener === 'function') narrowMedia.addListener(onChange);
  }
  onUnauthorized(() => {
    if (state.ready) {
      toast('登录状态已失效，请重新登录', 'warn');
      stopSSE();
      setSessionHint(false);
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
  // 没有会话提示（这个浏览器从没登录过）时不去探测 /auth/session：后端会回 401，
  // 而浏览器网络层会把 401 记成一条 console 错误。直接渲染登录页即可。
  if (!hasSessionHint()) {
    showLogin();
    return;
  }
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
    setSessionHint(false);
    showLogin();
  }
}

function applySession(session) {
  state.username = String(session.username || '');
  state.admin = !!session.admin;
  state.mustChangePassword = !!session.mustChangePassword;
  setCsrf(session.csrf || '');
}

function clearNode(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
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
  clearNode(dom.app);
  const login = document.createElement('nunt-login');
  if (message) login.notice = String(message);
  dom.app.appendChild(login);
  dom.shell = null;
}

/* ------------------------------------------------------------------ 登录之后 */

async function afterLogin() {
  if (state.mustChangePassword) {
    await forceChangePassword();
  }
  state.ready = true;
  await renderShell();
  startSSE();
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    markPendingHash('#/' + DEFAULT_PAGE);
    location.hash = pendingHash;
  }
  await route();
  await loadInfo();
}

/* ------------------------------------------------------------------ 外壳布局 */

function buildNav() {
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  nav.setAttribute('aria-label', '主导航');
  for (const page of PAGES) {
    const link = document.createElement('a');
    link.className = 'app-nav-item';
    link.href = '#/' + page.id;
    link.dataset.page = page.id;
    link.title = page.title;
    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(renderIcon(page.icon));
    const text = document.createElement('span');
    text.className = 'nav-text';
    text.textContent = page.title;
    link.appendChild(icon);
    link.appendChild(text);
    link.addEventListener('click', () => {
      closeDrawer();
      if (location.hash === link.getAttribute('href')) route().catch(() => {});
    });
    nav.appendChild(link);
  }
  return nav;
}

function markActiveNav() {
  if (!dom.nav) return;
  for (const link of Array.from(dom.nav.querySelectorAll('.app-nav-item'))) {
    if (link.dataset.page === state.pageId) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function syncNavPlacement() {
  const narrow = !!(narrowMedia && narrowMedia.matches);
  const target = narrow ? dom.drawerNavSlot : dom.navSlot;
  if (dom.nav && target && dom.nav.parentElement !== target) target.appendChild(dom.nav);
  if (!narrow) closeDrawer();
}

function openDrawer() {
  if (!dom.drawer) return;
  state.navOpen = true;
  try { dom.drawer.show(); } catch (err) { /* 忽略 */ }
}

function closeDrawer() {
  if (!dom.drawer) return;
  state.navOpen = false;
  try { dom.drawer.hide(); } catch (err) { /* 忽略 */ }
}

async function renderShell() {
  dom.app = document.getElementById('app');
  clearNode(dom.app);
  const shell = document.createElement('nunt-shell');
  shell.pageTitle = PAGE_MAP.has(state.pageId) ? PAGE_MAP.get(state.pageId).title : '控制台';
  shell.username = state.username;
  shell.theme = state.theme;
  shell.sse = state.sse === 'idle' ? 'connecting' : state.sse;
  applyInfoToShell(shell);
  dom.app.appendChild(shell);
  dom.shell = shell;
  await shell.updateComplete;
  dom.navSlot = shell.querySelector('#navSlot');
  dom.drawerNavSlot = shell.querySelector('#drawerNavSlot');
  dom.drawer = shell.querySelector('#navDrawer');
  dom.content = shell.querySelector('#content');
  if (!dom.nav) dom.nav = buildNav();
  syncNavPlacement();
  markActiveNav();
}

function applyInfoToShell(shell) {
  const node = shell || dom.shell;
  if (!node) return;
  const info = state.info || {};
  node.version = infoVersionText(info);
  node.versionTitle = info.commit ? '提交 ' + String(info.commit) : '版本信息';
}

async function loadInfo(force) {
  if (state.info && !force) {
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

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark', true);
  toast(state.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
}

function setSSE(status) {
  state.sse = status;
  if (dom.shell) dom.shell.sse = status;
}

async function confirmLogout() {
  if (await confirmDialog('确定要退出登录吗？', { danger: true, okLabel: '退出登录' })) await logout();
}

async function logout() {
  try {
    await api.post('/api/v1/auth/logout', {});
  } catch (err) { /* 即使失败也要回到登录页 */ }
  setCsrf('');
  setSessionHint(false);
  state.username = '';
  state.admin = false;
  state.info = null;
  stopSSE();
  if (location.hash) location.hash = '';
  showLogin();
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

function actionButton(label, onClick) {
  const button = document.createElement('sl-button');
  button.setAttribute('size', 'small');
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
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
  if (!dom.content) return;
  clearNode(dom.content);
  dom.content.appendChild(loadingState('正在加载…'));

  state.pageId = pageId;
  if (dom.shell) dom.shell.pageTitle = meta.title;
  markActiveNav();
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
    clearNode(dom.content);
    dom.content.appendChild(emptyState('页面“' + meta.title + '”暂时不可用', {
      icon: 'exclamation-triangle',
      hint: '该页面的前端模块还未提供（内部错误：无法加载 pages/' + pageId + '.js）。',
      action: actionButton('重试', () => route()),
    }));
    return;
  }

  if (page.title && dom.shell) dom.shell.pageTitle = page.title;

  const root = document.createElement('div');
  root.className = 'page page-' + pageId;
  clearNode(dom.content);
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
    clearNode(root);
    root.appendChild(errorCard(err, {
      title: '页面渲染失败',
      retryLabel: '重新加载',
      onRetry: () => route(),
    }));
  }
}

/* ------------------------------------------------------------------ SSE */

function startSSE() {
  if (typeof window.EventSource !== 'function') {
    setSSE('unsupported');
    return;
  }
  if (!sseSource) connectSSE();
}

function connectSSE() {
  if (sseSource || !state.ready) return;
  setSSE(sseRetry > 0 ? 'retry' : 'connecting');
  let source;
  try {
    source = new EventSource('/api/v1/events', { withCredentials: true });
  } catch (err) {
    scheduleReconnect();
    return;
  }
  sseSource = source;

  source.addEventListener('open', () => {
    if (source !== sseSource) return;
    sseRetry = 0;
    setSSE('open');
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
    setSSE('closed');
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
  if (sseRetry === 1 || sseRetry % 5 === 0) setSSE('retry');
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
  setSSE('idle');
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

function passwordFields() {
  return formGrid([
    { name: 'current', label: '当前密码', type: 'password', autocomplete: 'current-password' },
    { name: 'next', label: '新密码（至少 8 位）', type: 'password', autocomplete: 'new-password' },
    { name: 'again', label: '确认新密码', type: 'password', autocomplete: 'new-password' },
  ]);
}

function openChangePassword() {
  const form = passwordFields();
  openDialog({
    title: '修改密码',
    body: form.node,
    width: '460px',
    actions: [
      { label: '取消' },
      {
        label: '保存',
        kind: 'primary',
        close: false,
        onClick: async (dlg, button) => {
          form.clearErrors();
          const values = form.read();
          if (!values.next || String(values.next).length < 8) {
            form.fieldError('next', '新密码至少需要 8 位');
            return;
          }
          if (values.next !== values.again) {
            form.fieldError('again', '两次输入的新密码不一致');
            return;
          }
          dlg.setBusy(true, button);
          try {
            await api.post('/api/v1/auth/password', { current: values.current, new: values.next });
            toast('密码已更新，请重新登录', 'ok');
            dlg.close();
            await logout();
          } catch (err) {
            form.error(errorMessage(err, '修改失败'));
          } finally {
            dlg.setBusy(false, button);
          }
        },
      },
    ],
  });
}

function forceChangePassword() {
  return new Promise((resolve) => {
    const form = passwordFields();
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = '当前账号要求修改初始密码后才能继续使用控制台。';
    const body = document.createElement('div');
    body.appendChild(notice);
    body.appendChild(form.node);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    openDialog({
      title: '修改密码',
      body,
      width: '460px',
      closeOnEscape: false,
      onClose: finish,
      actions: [
        {
          label: '退出登录',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            await logout();
            finish();
          },
        },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            if (!values.next || String(values.next).length < 8) {
              form.fieldError('next', '新密码至少需要 8 位');
              return;
            }
            if (values.next !== values.again) {
              form.fieldError('again', '两次输入的新密码不一致');
              return;
            }
            dlg.setBusy(true, button);
            try {
              await api.post('/api/v1/auth/password', { current: values.current, new: values.next });
              state.mustChangePassword = false;
              toast('密码已更新，请使用新密码重新登录', 'ok');
              dlg.close();
              await logout();
              finish();
            } catch (err) {
              form.error(errorMessage(err, '修改失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  });
}

/* ------------------------------------------------------------------ 导出给页面 */

export { api, ctx, state, onSSE, navigate };

boot().catch((err) => {
  const app = document.getElementById('app');
  if (app) {
    clearNode(app);
    app.appendChild(errorCard(err, { title: '控制台初始化失败' }));
  }
});
