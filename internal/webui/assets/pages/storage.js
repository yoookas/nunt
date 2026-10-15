// 存储页：挂载管理（本地目录 / WebDAV）+ 目录浏览。
//
// 阶段 2 迁移：挂载点表格换成 kit 的 nunt-table（操作列走 actions，右对齐不换行），
// 新建/编辑、测试连接、目录浏览都走 openDialog + formGrid，提示走 toast / confirmDialog，
// 三态走 nunt-empty / nunt-loading / nunt-error，卡片标题 h2。
// 数据流与迁移前一致：同一批接口（GET/POST/PUT/DELETE /api/v1/storage/mounts、
// POST /api/v1/storage/mounts/test、GET /api/v1/storage/mounts/{id}/list?path=）与字段名、
// 同样的类型显隐（local 只显示本地路径，webdav 显示地址/用户名/密码/跳过证书校验）、
// 同样的密码掩码回填（列表返回的 ******** 原样提交，后端按「不修改」处理）。
import {
  NuntElement, html, nothing, define, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtBytes, fmtTime,
} from '../lib/kit.js';

const TYPES = [
  { value: 'local', label: '本地目录' },
  { value: 'webdav', label: 'WebDAV' },
];

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pstorage-name{font-weight:600;word-break:break-word}',
  '.pstorage-remark{font-size:11px;color:var(--text-faint);word-break:break-word}',
  '.pstorage-loc{word-break:break-all}',
  '.pstorage-test{display:flex;align-items:center;gap:8px;margin-right:auto;font-size:12.5px;color:var(--text-dim);min-width:0}',
  '.pstorage-test-result{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}',
  '.pstorage-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:13px;margin:10px 0}',
  '.pstorage-crumb-sep{color:var(--text-faint);padding:0 2px}',
  '.pstorage-name-cell{word-break:break-all}',
  '.pstorage-dir{color:var(--brand);font-weight:600}',
  '.pstorage-browser-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pstorage-browser-info{margin-left:auto;font-size:12.5px;color:var(--text-dim);white-space:nowrap}',
  '.pstorage-foot{margin:14px 0 0;font-size:12px;color:var(--text-faint)}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（与迁移前一致） */

function typeLabel(type) {
  return type === 'webdav' ? 'WebDAV' : '本地目录';
}

function locOf(row) {
  return String((row && (row.type === 'webdav' ? row.url : row.root)) || '');
}

function parentPath(p) {
  const clean = String(p || '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return '/';
  return clean.slice(0, idx);
}

function joinPath(base, name) {
  const b = String(base || '/').replace(/\/+$/, '');
  return (b === '' ? '' : b) + '/' + name;
}

/* ------------------------------------------------------------------ 页面 */

class StoragePage extends NuntElement {
  static properties = {
    mounts: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.mounts = [];
    this.loading = true;
    this.error = null;
    this.busyId = '';
    this.dialogs = new Set();
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：关掉本页打开的对话框，断开后不再写 state。 */
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

  /* ---------------------------------------------------------------- 取数 */

  async load() {
    this.loading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/storage/mounts');
      if (this.disposed) return;
      this.mounts = Array.isArray(data) ? data : [];
      this.error = null;
    } catch (err) {
      if (this.disposed) return;
      this.mounts = [];
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  /* ---------------------------------------------------------------- 动作 */

  async testMount(row) {
    this.busyId = String(row.id || '');
    try {
      await this.ctx.api.post('/api/v1/storage/mounts/test', { mount: row, id: row.id || '' });
      if (this.disposed) return;
      toast('连接正常：' + (row.name || ''), 'ok');
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '连接失败'), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  async removeMount(row) {
    const ok = await confirmDialog('确定要删除挂载「' + (row.name || '') + '」吗？引用它的站点会立即失效。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/storage/mounts/' + encodeURIComponent(row.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast(errorMessage(err, '删除失败'), 'err');
    }
  }

  /** buildPayload 与迁移前逐字段一致（local 只带 root，webdav 带 url/凭据/跳过校验）。 */
  buildPayload(values, draft) {
    const type = values.type === 'webdav' ? 'webdav' : 'local';
    const payload = {
      id: draft.id || '',
      name: String(values.name || '').trim(),
      type,
      enable: !!values.enable,
      remark: String(values.remark || '').trim(),
      readOnly: !!values.readOnly,
      root: '',
      url: '',
      username: '',
      password: '',
      insecureTls: false,
    };
    if (draft.createdAt) payload.createdAt = draft.createdAt;
    if (type === 'webdav') {
      payload.url = String(values.url || '').trim();
      payload.username = String(values.username || '').trim();
      payload.password = String(values.password || '');
      payload.insecureTls = !!values.insecureTls;
      payload.readOnly = !!values.readOnly;
    } else {
      payload.root = String(values.root || '').trim();
    }
    return payload;
  }

  /* ---------------------------------------------------------------- 编辑器 */

  openEditor(row) {
    const draft = row ? JSON.parse(JSON.stringify(row)) : {
      name: '', type: 'local', enable: true, readOnly: false, root: '', url: '', username: '', password: '', insecureTls: false, remark: '',
    };
    if (!draft.type) draft.type = 'local';
    const isNew = !row;

    const applyType = (value) => {
      const webdav = (value || form.get('type')) === 'webdav';
      form.toggle('root', !webdav);
      form.toggle('url', webdav);
      form.toggle('username', webdav);
      form.toggle('password', webdav);
      form.toggle('insecureTls', webdav);
      form.toggle('readOnly', true);
    };

    const form = formGrid([
      { name: 'name', label: '名称', value: draft.name, placeholder: '例如：NAS 备份' },
      { name: 'type', label: '类型', type: 'select', value: draft.type, options: TYPES, disabled: !isNew, onChange: applyType },
      { name: 'enable', label: '启用', type: 'switch', value: draft.enable !== false, text: '启用该挂载' },
      { name: 'readOnly', label: '只读', type: 'switch', value: !!draft.readOnly, text: '禁止写入' },
      { name: 'root', label: '本地路径', value: draft.root || '', placeholder: '/data/media 或 D:\\media', wide: true, hint: '必须存在且服务进程可读' },
      { name: 'url', label: 'WebDAV 地址', value: draft.url || '', placeholder: 'https://dav.example.com/remote.php/dav', wide: true },
      { name: 'username', label: '用户名', value: draft.username || '' },
      { name: 'password', label: '密码', type: 'password', value: draft.password || '', placeholder: isNew ? '' : '留空或保持 ******** 表示不修改' },
      { name: 'insecureTls', label: '跳过证书校验', type: 'switch', value: !!draft.insecureTls, text: '不校验服务器证书（自签名场景）' },
      { name: 'remark', label: '备注', value: draft.remark || '', wide: true },
    ]);
    applyType(draft.type);

    // 测试连接按钮放在对话框页脚左侧（迁移前的位置），busy 态用 sl-button 的 loading。
    const testResult = document.createElement('span');
    testResult.className = 'pstorage-test-result';
    const testBtn = document.createElement('sl-button');
    testBtn.setAttribute('size', 'small');
    testBtn.textContent = '测试连接';
    const testRow = document.createElement('div');
    testRow.className = 'pstorage-test';
    testRow.appendChild(testBtn);
    testRow.appendChild(testResult);

    const api = this.openPageDialog({
      title: isNew ? '新建挂载' : '编辑挂载',
      body: form.node,
      wide: true,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            if (!values.name || !String(values.name).trim()) {
              form.fieldError('name', '请填写名称');
              return;
            }
            if (values.type === 'webdav') {
              if (!values.url || !/^https?:\/\//i.test(String(values.url).trim())) {
                form.fieldError('url', '请填写以 http:// 或 https:// 开头的 WebDAV 地址');
                return;
              }
            } else if (!values.root || !String(values.root).trim()) {
              form.fieldError('root', '请填写本地路径');
              return;
            }
            const payload = this.buildPayload(values, draft);
            dlg.setBusy(true, button);
            try {
              if (isNew) await this.ctx.api.post('/api/v1/storage/mounts', payload);
              else await this.ctx.api.put('/api/v1/storage/mounts/' + encodeURIComponent(draft.id), payload);
              if (this.disposed) return;
              toast('已保存', 'ok');
              dlg.close();
              await this.load();
            } catch (err) {
              form.error(errorMessage(err, '保存失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
    // 插到页脚最左边（取消/保存两个按钮之前），与迁移前的按钮位置一致。
    // 注意：不能写在 openDialog 的 onMount 回调里 —— show() 可能同步 resolve，
    // 那时 onMount 会先于 const api = ... 赋值执行，api 还是 undefined。
    api.footer.insertBefore(testRow, api.footer.firstChild || null);

    testBtn.addEventListener('click', async () => {
      testBtn.setAttribute('loading', '');
      testBtn.setAttribute('disabled', '');
      testResult.textContent = '正在测试…';
      try {
        const payload = this.buildPayload(form.read(), draft);
        if (!isNew && (!payload.password || payload.password === '********')) payload.password = '********';
        await this.ctx.api.post('/api/v1/storage/mounts/test', { mount: payload, id: draft.id || '' });
        if (this.disposed) return;
        testResult.textContent = '';
        toast('连接正常', 'ok');
      } catch (err) {
        if (this.disposed) return;
        const message = errorMessage(err, '连接失败');
        testResult.textContent = message;
        toast(message, 'err');
      } finally {
        testBtn.removeAttribute('loading');
        testBtn.removeAttribute('disabled');
      }
    });
  }

  /* ---------------------------------------------------------------- 目录浏览 */

  openBrowser(row) {
    let currentPath = '/';
    const state = { entries: [], loading: true, error: null };

    const crumbsRow = document.createElement('div');
    crumbsRow.className = 'pstorage-crumbs';
    const upBtn = document.createElement('sl-button');
    upBtn.setAttribute('size', 'small');
    upBtn.textContent = '上一级';
    const refreshBtn = document.createElement('sl-button');
    refreshBtn.setAttribute('size', 'small');
    refreshBtn.textContent = '刷新';
    const info = document.createElement('span');
    info.className = 'pstorage-browser-info';
    const tools = document.createElement('div');
    tools.className = 'pstorage-browser-tools';
    tools.appendChild(upBtn);
    tools.appendChild(refreshBtn);
    tools.appendChild(info);
    // 表格只用 nunt-table 建一次，翻目录时改 rows / loading / error（不重建 DOM）。
    const columns = [
      {
        key: 'name',
        title: '名称',
        sort: (e) => (e ? String(e.name || '') : ''),
        render: (e) => html`<span class=${e.dir ? 'pstorage-name-cell pstorage-dir' : 'pstorage-name-cell'}>${String(e.name || '')}${e.dir ? '/' : ''}</span>`,
      },
      {
        key: 'type',
        title: '类型',
        width: 90,
        render: (e) => html`<sl-badge pill variant="neutral">${e.dir ? '目录' : '文件'}</sl-badge>`,
      },
      {
        key: 'size',
        title: '大小',
        width: 110,
        align: 'right',
        sort: (e) => (e && !e.dir ? Number(e.size) || 0 : -1),
        render: (e) => (e.dir ? html`<span class="muted">-</span>` : html`<span>${fmtBytes(e.size)}</span>`),
      },
      {
        key: 'modTime',
        title: '修改时间',
        width: 180,
        render: (e) => html`<span class="muted">${e.modTime ? fmtTime(e.modTime) : ''}</span>`,
      },
      {
        title: '操作',
        actions: true,
        width: 110,
        render: (e) => (e.dir
          ? html`<sl-button size="small" @click=${() => open(e.path || joinPath(currentPath, e.name))}>打开</sl-button>`
          : nothing),
      },
    ];
    const table = document.createElement('nunt-table');
    table.setAttribute('caption', '目录内容');
    table.columns = columns;
    table.empty = '目录为空';
    table.emptyHint = '这个目录里还没有文件。';
    table.rowKey = (e, index) => (e && e.path) || (e && e.name) || 'row:' + index;
    table.onRetry = () => open(currentPath);
    const body = document.createElement('div');
    body.appendChild(tools);
    body.appendChild(crumbsRow);
    body.appendChild(table);

    const api = this.openPageDialog({
      title: '浏览：' + (row.name || ''),
      body,
      wide: true,
      actions: [{ label: '关闭' }],
      onClose: () => { this.dialogs.delete(api); },
    });

    const renderCrumbs = () => {
      crumbsRow.textContent = '';
      const parts = String(currentPath || '/').split('/').filter(Boolean);
      const root = document.createElement('sl-button');
      root.setAttribute('size', 'small');
      root.setAttribute('variant', 'text');
      root.textContent = '/';
      root.addEventListener('click', () => open('/'));
      crumbsRow.appendChild(root);
      let acc = '';
      for (const part of parts) {
        acc += '/' + part;
        const target = acc;
        const sep = document.createElement('span');
        sep.className = 'pstorage-crumb-sep';
        sep.textContent = '/';
        crumbsRow.appendChild(sep);
        const btn = document.createElement('sl-button');
        btn.setAttribute('size', 'small');
        btn.setAttribute('variant', 'text');
        btn.textContent = part;
        btn.addEventListener('click', () => open(target));
        crumbsRow.appendChild(btn);
      }
    };

    // renderListing：把当前状态写进同一张表（rows / loading / error 三态由 kit 负责）。
    const renderListing = () => {
      table.rows = state.entries;
      table.loading = state.loading;
      table.error = state.error;
    };

    const open = async (p) => {
      currentPath = p || '/';
      renderCrumbs();
      state.loading = true;
      state.error = null;
      state.entries = [];
      renderListing();
      try {
        const data = await this.ctx.api.get('/api/v1/storage/mounts/' + encodeURIComponent(row.id) + '/list', { path: currentPath });
        if (this.disposed) return;
        const entries = data && Array.isArray(data.entries) ? data.entries.slice() : [];
        entries.sort((a, b) => (a.dir === b.dir ? String(a.name).localeCompare(String(b.name)) : (a.dir ? -1 : 1)));
        state.entries = entries;
        info.textContent = entries.length + ' 项 · ' + (row.readOnly ? '只读' : '可读写');
      } catch (err) {
        if (this.disposed) return;
        state.error = err;
      } finally {
        if (!this.disposed) state.loading = false;
        renderListing();
      }
    };

    upBtn.addEventListener('click', () => open(parentPath(currentPath)));
    refreshBtn.addEventListener('click', () => open(currentPath));
    open('/');
  }

  /* ---------------------------------------------------------------- 渲染 */

  mountColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => (row ? String(row.name || '') : ''),
        render: (row) => html`<div>
          <div class="pstorage-name">${String(row.name || '未命名')}</div>
          ${row.remark ? html`<div class="pstorage-remark">${String(row.remark)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'type',
        title: '类型',
        width: 110,
        sort: (row) => typeLabel(row && row.type),
        render: (row) => html`<sl-badge pill variant="neutral">${typeLabel(row.type)}</sl-badge>`,
      },
      {
        key: 'location',
        title: '位置',
        sort: (row) => locOf(row),
        render: (row) => html`<span class="mono muted pstorage-loc">${locOf(row)}</span>`,
      },
      {
        key: 'readOnly',
        title: '只读',
        width: 100,
        sort: (row) => (row && row.readOnly ? 1 : 0),
        render: (row) => html`<sl-badge pill variant=${row.readOnly ? 'warning' : 'neutral'}>${row.readOnly ? '只读' : '可写'}</sl-badge>`,
      },
      {
        key: 'enable',
        title: '状态',
        width: 100,
        sort: (row) => (row && row.enable ? 1 : 0),
        render: (row) => html`<sl-badge pill variant=${row.enable ? 'success' : 'neutral'}>${row.enable ? '已启用' : '已停用'}</sl-badge>`,
      },
      {
        title: '操作',
        actions: true,
        width: 300,
        render: (row) => html`
          <sl-button size="small" @click=${() => this.openBrowser(row)}>浏览</sl-button>
          <sl-button size="small" ?loading=${this.busyId === String(row.id || '')}
            @click=${() => this.testMount(row)}>测试</sl-button>
          <sl-button size="small" @click=${() => this.openEditor(row)}>编辑</sl-button>
          <sl-button size="small" variant="danger" outline @click=${() => this.removeMount(row)}>删除</sl-button>`,
      },
    ];
  }

  render() {
    return html`<section class="card">
      <div class="card-header">
        <h2>存储挂载</h2>
        <span class="sub">${this.mounts.length ? '共 ' + this.mounts.length + ' 个挂载' : ''}</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.loading} @click=${() => this.load()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openEditor(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建挂载
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="存储挂载列表"
          .columns=${this.mountColumns()} .rows=${this.mounts} .loading=${this.loading}
          .error=${this.error} .onRetry=${() => this.load()}
          .rowKey=${(row) => (row && row.id) || (row && row.name) || ''}
          empty="还没有配置存储挂载" emptyHint="点右上角「新建挂载」添加本地目录或 WebDAV。"></nunt-table>
        <p class="pstorage-foot">密码由服务端加密保存；列表里的 ******** 表示已有密码，编辑时不改动它就不会被覆盖。</p>
      </div>
    </section>`;
  }
}

define('nunt-page-storage', StoragePage);

export default {
  id: 'storage',
  title: '存储',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-storage');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
