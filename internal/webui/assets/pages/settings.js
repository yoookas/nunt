// 设置页：系统参数、用户、API Token、在线会话、配置导入导出。
//
// 阶段 2 迁移：标签页换成 sl-tab-group，表单/表格/对话框/提示/状态块全部走 lib/kit.js。
// 数据流与迁移前一致：同一批接口、同一批字段名、同样的校验文案与提示语义。
// 组件按需加载：只引本页用到的入口（kit 不再注册任何 sl-* 组件，见 lib/components/core.js）。
import '../lib/components/feedback.js';
import '../lib/components/form.js';
import '../lib/components/tabs.js';
import {
  NuntElement, html, nothing, define, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
} from '../lib/kit.js';

const THEMES = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const TABS = [
  { id: 'basic', label: '基础设置' },
  { id: 'users', label: '用户' },
  { id: 'tokens', label: 'API Token' },
  { id: 'sessions', label: '在线会话' },
  { id: 'config', label: '配置导入导出' },
];

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.psettings-tabs::part(tabs){background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius);padding:6px 8px;margin-bottom:16px}',
  '.psettings-tabs::part(body){padding:0}',
  '.psettings-note{margin:0 0 12px;font-size:13px}',
  '.psettings-actions{margin-top:14px}',
  '.psettings-json{margin:0;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto}',
  '.psettings-notice{padding:10px 12px;border-radius:var(--radius-sm);background:var(--warn-soft);border:1px solid color-mix(in srgb, var(--warn) 35%, transparent);color:var(--sl-color-warning-800);font-size:13px;margin-bottom:12px}',  // warning-800：warning-600/700 在 --warn-soft 上分别只有 3.0/4.3:1（同 style.css 的 .notice）
  // 切换成功后的常驻提示：toast 会自动消失，而「旧端口已经关闭」这件事需要一直可见。
  '.psettings-switched{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-radius:var(--radius-sm);background:var(--ok-soft);border:1px solid color-mix(in srgb, var(--ok) 35%, transparent);color:var(--text);font-size:13px;margin-bottom:12px}',
  '.psettings-switched a,.psettings-toast-link{color:var(--accent);font-weight:600;text-decoration:underline}',
  '.psettings-toast-link{margin-left:8px}',
  '.psettings-token{display:block;padding:12px;border-radius:var(--radius-sm);background:var(--bg-soft);border:1px dashed var(--line-strong);font-family:var(--sl-font-mono);font-size:13px;word-break:break-all;user-select:all}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/**
 * splitList 把「逗号/分号/空白分隔」的文本拆成数组（提交体形状与迁移前完全一致）。
 *
 * 阶段 2 时这两个字段用的是普通文本框：当时 kit 的 nunt-tags 内层 sl-input 没有可访问名称，
 * 会被 axe 判 label-title-only/serious，而 kit.js 在那一批不允许改。
 * 阶段 3 给 nunt-tags 补上了 label（转交给内部 sl-input），两个字段因此换回 nunt-tags ——
 * 回车/逗号/分号/换行都能加标签，值仍然是同一个字符串数组。
 */
function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value === undefined || value === null ? '' : value)
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * adminListenURL 把监听地址换算成「同一主机、新端口」的浏览器地址。
 *
 * 换端口时主机不变（监听通配地址时就是浏览器当前的主机名），所以只替换端口。
 * 地址解析不出来时返回空串，界面退化为只显示文本，不给出可能错误的链接。
 */
function adminListenURL(listen) {
  const match = /:([0-9]+)\s*$/.exec(String(listen === undefined || listen === null ? '' : listen).trim());
  if (!match) return '';
  const loc = window.location;
  const host = loc.hostname || 'localhost';
  return loc.protocol + '//' + host + ':' + match[1] + '/';
}

/** downloadText 触发浏览器下载（与 lib/ui.js 的实现一致，迁移后不再依赖它）。 */
function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ 页面 */

class SettingsPage extends NuntElement {
  static properties = {
    activeTab: { type: String },
    basicLoading: { type: Boolean },
    basicError: { attribute: false },
    basicForm: { attribute: false },
    listenInfo: { attribute: false },
    switchedTo: { type: String },
    switchedAddr: { type: String },
    users: { attribute: false },
    usersLoading: { type: Boolean },
    usersError: { attribute: false },
    tokens: { attribute: false },
    tokensLoading: { type: Boolean },
    tokensError: { attribute: false },
    sessions: { attribute: false },
    sessionsLoading: { type: Boolean },
    sessionsError: { attribute: false },
    configBusy: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.activeTab = 'basic';
    this.basicLoading = false;
    this.basicError = null;
    this.basicForm = null;
    this.systemSettings = null;
    this.listenInfo = null;
    // 监听地址切换成功后，「旧端口已关闭」的提示要一直留在页面上。
    this.switchedTo = '';
    this.switchedAddr = '';
    this.users = [];
    this.usersLoading = false;
    this.usersError = null;
    this.tokens = [];
    this.tokensLoading = false;
    this.tokensError = null;
    this.sessions = [];
    this.sessionsLoading = false;
    this.sessionsError = null;
    this.configBusy = '';
    this.dialogs = new Set();
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadTab(this.activeTab);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：断开后不再写 state，并关掉本页打开的对话框。 */
  dispose() {
    this.disposed = true;
    for (const dialog of Array.from(this.dialogs)) {
      try { dialog.close(); } catch (err) { /* 忽略 */ }
    }
    this.dialogs.clear();
    this.remove();
  }

  /** openPageDialog 打开对话框并登记，页面卸载时统一关闭（避免对话框挂到 body 上泄漏）。 */
  openPageDialog(options) {
    const api = openDialog(options);
    this.dialogs.add(api);
    if (api.dialog) api.dialog.addEventListener('sl-after-hide', () => this.dialogs.delete(api));
    return api;
  }

  setTab(id) {
    if (!id || id === this.activeTab) return;
    this.activeTab = id;
    this.loadTab(id);
  }

  loadTab(id) {
    if (id === 'basic') this.loadBasic(false);
    else if (id === 'users') this.loadUsers();
    else if (id === 'tokens') this.loadTokens();
    else if (id === 'sessions') this.loadSessions();
    // config 标签是纯本地按钮，不取数（与迁移前一致）。
  }

  /* ---------------------------------------------------------------- 基础设置 */

  /**
   * adminListenHint 生成「管理监听地址」字段的提示。
   *
   * 环境变量覆盖只影响运行时（不写回 config.json），此时修改这一项不会改变
   * 实际端口；提示里点名具体的环境变量并给出实际生效值，避免用户误以为保存即生效。
   * 没有环境变量时，保存会真的移动监听器（后端先绑新地址、成功后才关旧地址）。
   */
  adminListenHint() {
    const info = this.listenInfo;
    if (info && info.adminListenSource === 'env') {
      const source = info.adminListenEnv || 'NUNT_ADMIN_LISTEN / NUNT_ADMIN_PORT';
      const effective = info.adminListen ? '（实际生效 ' + String(info.adminListen) + '）' : '';
      return '当前监听地址由环境变量 ' + source + ' 指定' + effective + '，此字段已禁用；'
        + '如需调整请移除该环境变量并重启服务（保留环境变量时保存修改会被拒绝）。';
    }
    return '保存后立即生效，无需重启：服务先在新地址上监听成功，再关闭旧地址；端口被占用时保留旧监听并提示原因。';
  }

  buildBasicForm(data) {
    const envControlled = !!(this.listenInfo && this.listenInfo.adminListenSource === 'env');
    return formGrid([
      {
        name: 'adminListen',
        label: '管理监听地址',
        value: data.adminListen || '',
        placeholder: ':8080 或 127.0.0.1:8080',
        hint: this.adminListenHint(),
        disabled: envControlled,
      },
      { name: 'baseUrl', label: '外部访问地址', value: data.baseUrl || '', placeholder: 'https://admin.example.com', hint: '用于生成回跳链接，可留空' },
      { name: 'logLevel', label: '日志级别', type: 'select', value: data.logLevel || 'info', options: LOG_LEVELS },
      { name: 'sessionTtlHours', label: '会话有效期（小时）', type: 'number', value: data.sessionTtlHours || 24, min: 1, max: 720 },
      { name: 'loginMaxFail', label: '登录失败次数上限', type: 'number', value: data.loginMaxFail || 5, min: 1, max: 100 },
      { name: 'loginLockMinutes', label: '锁定时长（分钟）', type: 'number', value: data.loginLockMin || 15, min: 1, max: 1440 },
      { name: 'trustProxy', label: '信任反向代理', type: 'switch', value: !!data.trustProxy, text: '使用 X-Forwarded-For 识别客户端 IP' },
      { name: 'checkUpdate', label: '检查更新', type: 'switch', value: data.checkUpdate !== false, text: '启动时检查新版本' },
      { name: 'theme', label: '默认主题', type: 'select', value: data.theme || 'dark', options: THEMES, hint: '仅作为新设备的默认值，本机选择保存在浏览器中' },
      {
        name: 'adminAllowIps',
        label: '管理端 IP 白名单',
        type: 'tags',
        value: splitList(data.adminAllowIps),
        wide: true,
        placeholder: '输入 IP 或 CIDR 后按回车添加',
        hint: '留空表示不限制；支持单个地址与 CIDR，回车 / 逗号 / 分号都能添加',
      },
    ]);
  }

  async loadBasic(force) {
    if (!force && this.systemSettings) {
      this.basicForm = this.buildBasicForm(this.systemSettings);
      this.basicError = null;
      return;
    }
    this.basicLoading = true;
    try {
      // 监听地址来源只在 /system/info 里（settings 返回的是配置文件内容）。
      // 取不到 info 时不影响设置页，只是不显示环境变量提示。
      const [data, info] = await Promise.all([
        this.ctx.api.get('/api/v1/system/settings'),
        this.ctx.api.get('/api/v1/system/info').catch(() => null),
      ]);
      if (this.disposed) return;
      this.systemSettings = data || {};
      this.listenInfo = info || null;
      this.basicForm = this.buildBasicForm(this.systemSettings);
      this.basicError = null;
    } catch (err) {
      if (this.disposed) return;
      this.basicError = err;
    } finally {
      if (!this.disposed) this.basicLoading = false;
    }
  }

  async saveBasic() {
    const form = this.basicForm;
    if (!form) return;
    form.clearErrors();
    const values = form.read();
    const payload = {
      adminListen: String(values.adminListen || '').trim(),
      adminAllowIps: splitList(values.adminAllowIps),
      trustProxy: !!values.trustProxy,
      logLevel: values.logLevel || 'info',
      sessionTtlHours: Number(values.sessionTtlHours) || 24,
      loginMaxFail: Number(values.loginMaxFail) || 5,
      loginLockMinutes: Number(values.loginLockMinutes) || 15,
      theme: values.theme || 'dark',
      checkUpdate: !!values.checkUpdate,
      baseUrl: String(values.baseUrl || '').trim(),
    };
    // 保存前的实际监听地址：优先用 system/info（真实生效值），取不到时退回
    // 设置里的值，至少能判断「这次保存有没有换端口」。
    const previousListen = String(
      (this.listenInfo && this.listenInfo.adminListen)
      || (this.systemSettings && this.systemSettings.adminListen)
      || '',
    );
    this.configBusy = 'basic';
    try {
      const result = await this.ctx.api.put('/api/v1/system/settings', payload);
      if (this.disposed) return;
      this.systemSettings = result || payload;
      // 后端返回的 adminListen 是「保存后真正生效的地址」：环境变量覆盖时它
      // 仍是实际端口，正常保存时它已经等于新端口。
      const effective = result && result.adminListen ? String(result.adminListen) : payload.adminListen;
      this.listenInfo = Object.assign({}, this.listenInfo || {}, result ? {
        adminListen: result.adminListen,
        adminListenConfig: result.adminListenConfig,
        adminListenSource: result.adminListenSource,
        adminListenEnv: result.adminListenEnv,
      } : { adminListen: effective, adminListenConfig: effective });
      this.basicForm = this.buildBasicForm(this.systemSettings);
      this.ctx.theme.set(payload.theme);
      if (result && result.adminListenSource === 'env') {
        toast('设置已保存；监听地址仍由环境变量控制，未改变', 'warn');
      } else if (effective && previousListen && effective !== previousListen) {
        this.notifyListenSwitched(effective);
      } else {
        toast('设置已保存', 'ok');
      }
    } catch (err) {
      if (this.disposed) return;
      // 后端的 message（例如「端口 3133 已被占用…」）原样展示：表单内保留
      // role=alert 的错误块，同时弹一条 toast，长表单里也能立刻看到。
      const message = errorMessage(err, '保存失败');
      form.error(message);
      toast(message, 'err');
    } finally {
      if (!this.disposed) this.configBusy = '';
    }
  }

  /**
   * notifyListenSwitched：保存后监听地址真的变了。
   *
   * toast 只活几秒，而「当前页面还挂在旧地址上」是持续状态，所以同时把链接
   * 留在系统参数卡片里（renderBasic 的 switchedTo），刷新页面后自然消失。
   */
  notifyListenSwitched(listen) {
    const addr = String(listen || '');
    const url = adminListenURL(addr);
    this.switchedAddr = addr;
    this.switchedTo = url;
    const alert = toast('管理后台已切换到 ' + addr + '，当前页面仍在旧地址', 'ok');
    // toast 默认 3.2 秒，给操作者留出点击「用新地址打开」的时间。
    alert.duration = 15000;
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.className = 'psettings-toast-link';
      link.textContent = '用新地址打开';
      alert.appendChild(link);
    }
  }

  renderBasic() {
    let body = nothing;
    if (this.basicError) {
      body = html`<nunt-error .error=${this.basicError} heading="无法读取系统设置" .onRetry=${() => { this.systemSettings = null; this.loadBasic(true); }}></nunt-error>`;
    } else if (this.basicForm) {
      body = html`${this.basicForm.node}
        <div class="row psettings-actions">
          <sl-button variant="primary" ?loading=${this.configBusy === 'basic'} @click=${() => this.saveBasic()}>保存设置</sl-button>
        </div>`;
    } else {
      body = html`<nunt-loading text="正在读取系统设置…"></nunt-loading>`;
    }
    // 切换成功后旧端口已经关闭，页面上的接口调用都会失败：把「用新地址打开」
    // 作为常驻提示放在表单上方，而不是只依赖会自动消失的 toast。
    const switched = this.switchedTo
      ? html`<div class="psettings-switched" role="status">
          <span>管理后台已切换到 <code class="mono">${this.switchedAddr}</code>，当前页面仍在旧地址。</span>
          <a href=${this.switchedTo}>用新地址打开</a>
        </div>`
      : nothing;
    return html`<section class="card">
      <div class="card-header">
        <h2>系统参数</h2>
        <span class="spacer"></span>
        <span class="sub">监听地址保存后立即生效</span>
      </div>
      <div class="card-body">${switched}${body}</div>
    </section>`;
  }

  /* ---------------------------------------------------------------- 用户 */

  async loadUsers() {
    this.usersLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/auth/users');
      if (this.disposed) return;
      this.users = Array.isArray(data) ? data : [];
      this.usersError = null;
    } catch (err) {
      if (this.disposed) return;
      this.usersError = err;
    } finally {
      if (!this.disposed) this.usersLoading = false;
    }
  }

  userColumns() {
    return [
      { key: 'username', title: '用户名', sort: (row) => (row ? row.username || '' : ''), render: (row) => html`<span>${String(row.username || '')}</span>` },
      { key: 'role', title: '角色', width: 90, render: (row) => html`<sl-badge pill variant="neutral">${String(row.role || 'admin')}</sl-badge>` },
      {
        key: 'enabled',
        title: '状态',
        width: 150,
        sort: (row) => (row && row.enabled ? 1 : 0),
        render: (row) => html`<span class="row">
          ${row.enabled ? html`<sl-badge pill variant="success">已启用</sl-badge>` : html`<sl-badge pill variant="neutral">已停用</sl-badge>`}
          ${row.mustChangePassword ? html`<sl-badge pill variant="warning">待改密</sl-badge>` : nothing}
        </span>`,
      },
      { key: 'lastLogin', title: '最近登录', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.lastLogin)}</span>` },
      { key: 'createdAt', title: '创建时间', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.createdAt)}</span>` },
      {
        title: '操作',
        actions: true,
        width: 150,
        render: (row) => html`
          <sl-button size="small" @click=${() => this.openUserEditor(row)}>编辑</sl-button>
          <sl-button size="small" variant="danger" outline @click=${() => this.removeUser(row)}>删除</sl-button>`,
      },
    ];
  }

  renderUsers() {
    return html`<section class="card">
      <div class="card-header">
        <h2>用户</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.loadUsers()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openUserEditor(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建用户
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="用户列表"
          .columns=${this.userColumns()} .rows=${this.users} .loading=${this.usersLoading}
          .error=${this.usersError} .onRetry=${() => this.loadUsers()}
          .rowKey=${(row) => (row && row.id) || (row && row.username)}
          empty="暂无用户" emptyHint="点右上角「新建用户」创建第一个账号。"></nunt-table>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <p class="muted psettings-note">后端当前创建的账号均为管理员角色；密码修改后该用户的其它会话会立即失效。</p>
      </div>
    </section>`;
  }

  openUserEditor(row) {
    const isNew = !row;
    const form = formGrid([
      { name: 'username', label: '用户名', value: row ? row.username : '' },
      {
        name: 'password',
        label: isNew ? '密码（至少 8 位）' : '重置密码（留空表示不修改）',
        type: 'password',
        value: '',
        autocomplete: 'new-password',
      },
      { name: 'enabled', label: '启用', type: 'switch', value: row ? !!row.enabled : true, text: '允许登录' },
    ]);
    this.openPageDialog({
      title: isNew ? '新建用户' : '编辑用户：' + row.username,
      body: form.node,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            const username = String(values.username || '').trim();
            const password = String(values.password || '');
            if (!username) {
              form.fieldError('username', '请填写用户名');
              return;
            }
            if (isNew && password.length < 8) {
              form.fieldError('password', '密码至少需要 8 位');
              return;
            }
            if (!isNew && password && password.length < 8) {
              form.fieldError('password', '密码至少需要 8 位');
              return;
            }
            const payload = { username, password, enabled: !!values.enabled };
            dlg.setBusy(true, button);
            try {
              if (isNew) await this.ctx.api.post('/api/v1/auth/users', payload);
              else await this.ctx.api.put('/api/v1/auth/users/' + encodeURIComponent(row.id), payload);
              if (this.disposed) return;
              toast('已保存', 'ok');
              dlg.close();
              this.loadUsers();
            } catch (err) {
              form.error(errorMessage(err, '保存失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  }

  async removeUser(row) {
    const ok = await confirmDialog('确定要删除用户「' + row.username + '」吗？该用户的会话会立即失效。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/auth/users/' + encodeURIComponent(row.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      this.loadUsers();
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '删除失败'), 'err');
    }
  }

  /* ---------------------------------------------------------------- API Token */

  async loadTokens() {
    this.tokensLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/auth/tokens');
      if (this.disposed) return;
      this.tokens = Array.isArray(data) ? data : [];
      this.tokensError = null;
    } catch (err) {
      if (this.disposed) return;
      this.tokensError = err;
    } finally {
      if (!this.disposed) this.tokensLoading = false;
    }
  }

  tokenColumns() {
    return [
      { key: 'name', title: '名称', sort: (row) => (row ? row.name || '' : ''), render: (row) => html`<span>${String(row.name || '')}</span>` },
      {
        key: 'scopes',
        title: '权限范围',
        render: (row) => (Array.isArray(row.scopes) && row.scopes.length
          ? html`<span class="row">${row.scopes.map((scope) => html`<sl-tag size="small">${String(scope)}</sl-tag>`)}</span>`
          : html`<span class="muted">默认</span>`),
      },
      { key: 'enabled', title: '状态', width: 100, sort: (row) => (row && row.enabled ? 1 : 0), render: (row) => html`<sl-badge pill variant=${row.enabled ? 'success' : 'neutral'}>${row.enabled ? '有效' : '已停用'}</sl-badge>` },
      { key: 'lastUsed', title: '最近使用', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.lastUsed)}</span>` },
      { key: 'createdAt', title: '创建时间', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.createdAt)}</span>` },
      {
        title: '操作',
        actions: true,
        width: 100,
        render: (row) => html`<sl-button size="small" variant="danger" outline @click=${() => this.removeToken(row)}>删除</sl-button>`,
      },
    ];
  }

  renderTokens() {
    return html`<section class="card">
      <div class="card-header">
        <h2>API Token</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.loadTokens()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openTokenEditor()}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建 Token
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="API Token 列表"
          .columns=${this.tokenColumns()} .rows=${this.tokens} .loading=${this.tokensLoading}
          .error=${this.tokensError} .onRetry=${() => this.loadTokens()}
          .rowKey=${(row) => (row && row.id) || (row && row.name)}
          empty="还没有创建 API Token" emptyHint="点右上角「新建 Token」生成一个。"></nunt-table>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <p class="muted psettings-note">Token 仅在创建时完整显示一次，请立即复制保存；服务端只保存摘要。</p>
      </div>
    </section>`;
  }

  openTokenEditor() {
    const form = formGrid([
      { name: 'name', label: '名称', value: '', placeholder: '例如：监控脚本' },
      {
        name: 'scopes',
        label: '权限范围',
        type: 'tags',
        value: [],
        placeholder: '输入范围后按回车添加',
        hint: '留空表示默认权限；例如 read、write，回车 / 逗号都能添加',
      },
    ]);
    this.openPageDialog({
      title: '新建 API Token',
      body: form.node,
      actions: [
        { label: '取消' },
        {
          label: '创建',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            if (!values.name || !String(values.name).trim()) {
              form.fieldError('name', '请填写名称');
              return;
            }
            dlg.setBusy(true, button);
            try {
              const result = await this.ctx.api.post('/api/v1/auth/tokens', {
                name: String(values.name).trim(),
                scopes: splitList(values.scopes),
              });
              if (this.disposed) return;
              dlg.close();
              this.showTokenOnce(result && result.token ? String(result.token) : '', values.name);
              this.loadTokens();
            } catch (err) {
              form.error(errorMessage(err, '创建失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  }

  showTokenOnce(token, name) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(token);
        toast('已复制到剪贴板', 'ok');
      } catch (err) {
        toast('复制失败，请手动选择文本', 'err');
      }
    };
    this.openPageDialog({
      title: 'Token 已创建：' + name,
      body: html`<div class="psettings-notice">请立即复制并妥善保存，关闭本窗口后将无法再次查看。</div>
        <div class="psettings-token">${token || '（后端未返回令牌）'}</div>`,
      actions: [
        { label: '关闭' },
        { label: '复制令牌', kind: 'primary', close: false, onClick: copy },
      ],
    });
  }

  async removeToken(row) {
    const ok = await confirmDialog('确定要删除 Token「' + row.name + '」吗？使用它的客户端会立即失效。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/auth/tokens/' + encodeURIComponent(row.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      this.loadTokens();
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '删除失败'), 'err');
    }
  }

  /* ---------------------------------------------------------------- 在线会话 */

  async loadSessions() {
    this.sessionsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/auth/sessions');
      if (this.disposed) return;
      this.sessions = Array.isArray(data) ? data : [];
      this.sessionsError = null;
    } catch (err) {
      if (this.disposed) return;
      this.sessionsError = err;
    } finally {
      if (!this.disposed) this.sessionsLoading = false;
    }
  }

  sessionColumns() {
    return [
      {
        key: 'username',
        title: '用户',
        sort: (row) => (row ? row.username || '' : ''),
        render: (row) => html`<span class="row"><span>${String(row.username || '')}</span>
          ${row.current ? html`<sl-badge pill variant="success">当前会话</sl-badge>` : nothing}</span>`,
      },
      { key: 'ip', title: '来源 IP', width: 160, render: (row) => html`<span class="mono muted">${String(row.ip || '')}</span>` },
      {
        key: 'userAgent',
        title: '客户端',
        render: (row) => html`<span class="muted">${String(row.userAgent || '').slice(0, 90)}</span>`,
      },
      { key: 'createdAt', title: '登录时间', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.createdAt)}</span>` },
      { key: 'expiresAt', title: '过期时间', width: 180, render: (row) => html`<span class="muted">${fmtTime(row.expiresAt)}</span>` },
    ];
  }

  renderSessions() {
    return html`<section class="card">
      <div class="card-header">
        <h2>在线会话</h2>
        <span class="spacer"></span>
        <sl-button size="small" @click=${() => this.loadSessions()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="在线会话列表"
          .columns=${this.sessionColumns()} .rows=${this.sessions} .loading=${this.sessionsLoading}
          .error=${this.sessionsError} .onRetry=${() => this.loadSessions()}
          .rowKey=${(row) => (row && row.ip) + '|' + (row && row.createdAt)}
          empty="当前没有其它在线会话"></nunt-table>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <p class="muted psettings-note">接口只返回当前有效的会话；如需强制下线，可修改该用户密码或重启服务。</p>
      </div>
    </section>`;
  }

  /* ---------------------------------------------------------------- 配置导入导出 */

  async exportConfig() {
    this.configBusy = 'export';
    try {
      const res = await fetch('/api/v1/system/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        let message = '导出失败（HTTP ' + res.status + '）';
        try {
          const data = await res.json();
          if (data && data.error && data.error.message) message = data.error.message;
        } catch (err) { /* 忽略 */ }
        throw new Error(message);
      }
      const text = await res.text();
      const disposition = res.headers.get('content-disposition') || '';
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(match ? match[1] : 'nunt-config-' + stamp + '.json', text, 'application/json;charset=utf-8');
      toast('配置已导出', 'ok');
    } catch (err) {
      toast(errorMessage(err, '导出失败'), 'err');
    } finally {
      if (!this.disposed) this.configBusy = '';
    }
  }

  pickImportFile() {
    const input = this.querySelector('input[type="file"]');
    if (input) { input.value = ''; input.click(); }
  }

  async importConfig(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (!(await confirmDialog('导入会覆盖当前的系统、Web、转发、动态域名、证书、存储、WAF、任务与通知配置，确定继续吗？', { danger: true, okLabel: '导入' }))) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      toast('文件不是合法的 JSON', 'err');
      return;
    }
    this.configBusy = 'import';
    try {
      await this.ctx.api.put('/api/v1/system/config', { config: parsed });
      if (this.disposed) return;
      this.systemSettings = null;
      toast('配置已导入并重新加载', 'ok');
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '导入失败'), 'err');
    } finally {
      if (!this.disposed) this.configBusy = '';
    }
  }

  async reloadConfig() {
    this.configBusy = 'reload';
    try {
      await this.ctx.api.post('/api/v1/system/reload', {});
      if (this.disposed) return;
      this.systemSettings = null;
      toast('已通知各模块重新加载配置', 'ok');
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '重载失败'), 'err');
    } finally {
      if (!this.disposed) this.configBusy = '';
    }
  }

  async showRawConfig() {
    this.configBusy = 'raw';
    try {
      const data = await this.ctx.api.get('/api/v1/system/config');
      if (this.disposed) return;
      let text;
      try { text = JSON.stringify(data, null, 2); } catch (err) { text = String(data); }
      this.openPageDialog({
        title: '当前配置（密钥已脱敏）',
        body: html`<pre class="mono psettings-json">${text}</pre>`,
        wide: true,
        actions: [
          { label: '关闭' },
          {
            label: '复制',
            kind: 'primary',
            close: false,
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast('已复制', 'ok');
              } catch (err) {
                toast('复制失败', 'err');
              }
            },
          },
        ],
      });
    } catch (err) {
      toast(errorMessage(err, '读取失败'), 'err');
    } finally {
      if (!this.disposed) this.configBusy = '';
    }
  }

  renderConfig() {
    return html`<section class="card">
      <div class="card-header">
        <h2>配置导入导出</h2>
      </div>
      <div class="card-body">
        <p class="muted psettings-note">导出的 JSON 中所有密钥以 ******** 呈现；直接回导时这些字段会沿用现有值。</p>
        <div class="row">
          <sl-button variant="primary" ?loading=${this.configBusy === 'export'} @click=${() => this.exportConfig()}>导出配置</sl-button>
          <sl-button ?loading=${this.configBusy === 'raw'} @click=${() => this.showRawConfig()}>查看当前配置 JSON</sl-button>
        </div>
        <sl-divider></sl-divider>
        <p class="muted psettings-note">导入会替换配置（用户仅在带有密码哈希时被替换），随后自动重载各模块。</p>
        <div class="row">
          <sl-button ?loading=${this.configBusy === 'import'} @click=${() => this.pickImportFile()}>选择配置文件并导入</sl-button>
          <input class="hidden" type="file" accept="application/json,.json" aria-label="选择配置文件" @change=${(event) => this.importConfig(event)} />
        </div>
        <sl-divider></sl-divider>
        <p class="muted psettings-note">修改配置文件后可用“重载配置”让各模块重新读取，无需重启进程。</p>
        <div class="row">
          <sl-button ?loading=${this.configBusy === 'reload'} @click=${() => this.reloadConfig()}>重载配置</sl-button>
        </div>
      </div>
    </section>`;
  }

  /* ---------------------------------------------------------------- 渲染 */

  renderTabBody(id) {
    if (id === 'basic') return this.renderBasic();
    if (id === 'users') return this.renderUsers();
    if (id === 'tokens') return this.renderTokens();
    if (id === 'sessions') return this.renderSessions();
    return this.renderConfig();
  }

  render() {
    return html`<sl-tab-group class="psettings-tabs" @sl-tab-show=${(event) => this.setTab(event.detail.name)}>
      ${TABS.map((tab) => html`<sl-tab slot="nav" panel=${tab.id} ?active=${this.activeTab === tab.id}>${tab.label}</sl-tab>`)}
      ${TABS.map((tab) => html`<sl-tab-panel name=${tab.id} ?active=${this.activeTab === tab.id}>
        ${this.activeTab === tab.id ? this.renderTabBody(tab.id) : nothing}
      </sl-tab-panel>`)}
    </sl-tab-group>`;
  }
}

define('nunt-page-settings', SettingsPage);

export default {
  id: 'settings',
  title: '设置',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007 19.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 13.6H3a2 2 0 110-4h.1A1.7 1.7 0 004.7 7L4.6 7a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010.4 3V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-settings');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
