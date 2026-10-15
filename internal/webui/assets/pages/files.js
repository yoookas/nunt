// 文件管理页：浏览存储挂载点的目录 + 分享链接。
//
// 阶段 2 迁移：表格/控件/对话框/提示/状态块全部走 lib/kit.js，卡片标题用 h2。
// 数据流与迁移前一致：同一批接口与字段名，同样的交互（切换挂载点、面包屑、上一级/根目录、
// 路径跳转、目录过滤、下载/预览、分享链接复制与取消）。
//
// 阶段 1 修好的行为继续保留：分享链接接口由 filebrowser 模块注册，模块没注册时后端根本没有
// 这条路由，直接请求会拿到 Go 默认的 404 响应体（浏览器还会记一条 console 错误）。所以这里
// 先读一次 GET /api/v1/modules，没有 filebrowser 就渲染友好空态 + 「重新检测」，不发注定
// 404 的请求；同时也不再有迁移前那种「失败后重试一次」的第二条请求。
import {
  NuntElement, html, nothing, define, confirmDialog, toast, errorMessage,
  fmtBytes, fmtTime,
} from '../lib/kit.js';

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pfiles-tools{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}',
  '.pfiles-tools .pfiles-path{width:260px}',
  '.pfiles-tools .pfiles-filter{width:190px}',
  '.pfiles-tools .pfiles-mount{min-width:200px}',
  '.pfiles-crumb-row{margin-top:12px}',
  '.pfiles-crumb{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:13px}',
  '.pfiles-crumb .pfiles-sep{color:var(--text-faint);padding:0 2px}',
  '.pfiles-name{word-break:break-all}',
  '.pfiles-dir{color:var(--brand);font-weight:600}',
  '.pfiles-url{word-break:break-all}',
  '.pfiles-share-name{font-size:11px}',
  '.pfiles-foot{margin:14px 0 0;font-size:12px}',
].join(String.fromCharCode(10));

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（与迁移前一致） */

function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

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

function entryKey(e, index) {
  const path = e && e.path ? String(e.path) : '';
  if (path) return path;
  const name = e ? fileName(e) : '';
  return name || 'row:' + index;
}

/* ------------------------------------------------------------------ 页面 */

class FilesPage extends NuntElement {
  static properties = {
    mounts: { attribute: false },
    mountsLoading: { type: Boolean },
    mountsError: { attribute: false },
    mountId: { type: String },
    path: { type: String },
    entries: { attribute: false },
    listLoading: { type: Boolean },
    listError: { attribute: false },
    filter: { type: String },
    shares: { attribute: false },
    sharesLoading: { type: Boolean },
    sharesError: { attribute: false },
    shareUnavailable: { type: Boolean },
  };

  constructor() {
    super();
    this.ctx = null;
    this.mounts = [];
    this.mountsLoading = true;
    this.mountsError = null;
    this.mountId = '';
    this.path = '/';
    this.entries = [];
    this.listLoading = false;
    this.listError = null;
    this.filter = '';
    this.shares = [];
    this.sharesLoading = true;
    this.sharesError = null;
    this.shareUnavailable = false;
    this.filterTimer = null;
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadMounts();
    this.loadShares();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：清掉防抖定时器，断开后不再写 state。 */
  dispose() {
    this.disposed = true;
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    this.remove();
  }

  /* ---------------------------------------------------------------- 取数 */

  filtered() {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.entries;
    return this.entries.filter((e) => fileName(e).toLowerCase().indexOf(q) >= 0);
  }

  async browse(p) {
    this.path = p || '/';
    if (!this.mountId) {
      this.entries = [];
      this.listError = null;
      return;
    }
    this.listLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/storage/mounts/' + encodeURIComponent(this.mountId) + '/list', { path: this.path });
      if (this.disposed) return;
      const list = (data && Array.isArray(data.entries)) ? data.entries : unwrap(data, ['entries', 'items']);
      this.entries = list.map((e) => Object.assign({}, e, {
        name: e.name || String(e.path || '').split('/').pop(),
        dir: !!(e.dir || e.isDir || e.directory),
        size: sizeOf(e),
        modTime: modTime(e),
      }));
      this.listError = null;
    } catch (err) {
      if (this.disposed) return;
      this.listError = err;
      this.entries = [];
    } finally {
      if (!this.disposed) this.listLoading = false;
    }
  }

  async loadMounts() {
    this.mountsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/storage/mounts');
      if (this.disposed) return;
      this.mounts = unwrap(data, ['mounts', 'items']);
      this.mountsError = null;
      if (this.mounts.length) {
        this.mountId = this.mounts[0].id;
        this.path = '/';
      } else {
        this.mountId = '';
        this.entries = [];
      }
    } catch (err) {
      if (this.disposed) return;
      this.mounts = [];
      this.mountsError = err;
    } finally {
      if (!this.disposed) this.mountsLoading = false;
    }
    if (this.disposed || this.mountsError || !this.mountId) return;
    await this.browse('/');
  }

  // filebrowserAvailable 先问一次模块列表：分享链接接口由文件管理模块（filebrowser）注册，
  // 模块没注册时后端根本没有这条路由，直接请求会拿到 404（Go 默认响应体），浏览器还会把它
  // 记成一条 console 错误。拿不到模块清单时按「可用」处理，保持旧行为。
  async filebrowserAvailable() {
    try {
      const data = await this.ctx.api.get('/api/v1/modules');
      const list = Array.isArray(data) ? data : unwrap(data, ['modules', 'items']);
      if (!Array.isArray(list) || !list.length) return true;
      return list.some((m) => m && String(m.name || '').toLowerCase() === 'filebrowser');
    } catch (err) {
      return true;
    }
  }

  async loadShares() {
    this.sharesLoading = true;
    this.shareUnavailable = false;
    try {
      if (!(await this.filebrowserAvailable())) {
        if (this.disposed) return;
        this.shares = [];
        this.sharesError = null;
        this.shareUnavailable = true;
        return;
      }
      const data = await this.ctx.api.get('/api/v1/files/shares');
      if (this.disposed) return;
      this.shares = unwrap(data, ['shares', 'items']);
      this.sharesError = null;
    } catch (err) {
      if (this.disposed) return;
      this.shares = [];
      this.sharesError = err;
    } finally {
      if (!this.disposed) this.sharesLoading = false;
    }
  }

  /* ---------------------------------------------------------------- 动作 */

  onMountChange(event) {
    this.mountId = String((event.target && event.target.value) || '');
    this.browse('/');
  }

  onPathKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this.goToTypedPath();
  }

  goToTypedPath() {
    const input = this.querySelector('.pfiles-path');
    this.browse((input && input.value) || '/');
  }

  onFilterInput(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      if (!this.disposed) this.filter = value;
    }, 180);
  }

  shareURL(s, token) {
    if (s && s.url) return s.url;
    if (token) return '/s/' + token;
    return '';
  }

  async copyShare(s) {
    const url = this.shareURL(s, s.token || s.id);
    if (!url) return;
    const full = url.indexOf('http') === 0 ? url : (window.location.origin + url);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(full);
        toast('已复制链接', 'ok');
      } catch (err) {
        toast('复制失败，请手动复制：' + full, 'warn');
      }
    } else {
      toast('请手动复制：' + full, 'warn');
    }
  }

  async removeShare(s) {
    const ok = await confirmDialog('确定取消该分享链接吗？取消后原链接立即失效。', { danger: true, okLabel: '取消分享' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/files/shares/' + encodeURIComponent(s.id || s.token));
      if (this.disposed) return;
      toast('已取消分享', 'ok');
      this.loadShares();
    } catch (err) {
      if (this.disposed) return;
      toast('取消失败：' + errorMessage(err), 'err');
    }
  }

  /* ---------------------------------------------------------------- 渲染片段 */

  renderCrumbs() {
    const parts = String(this.path || '/').split('/').filter((s) => s.length > 0);
    const nodes = [html`<sl-button size="small" variant="text" @click=${() => this.browse('/')}>根目录</sl-button>`];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      const target = acc;
      nodes.push(html`<span class="pfiles-sep">/</span>`);
      nodes.push(html`<sl-button size="small" variant="text" @click=${() => this.browse(target)}>${part}</sl-button>`);
    }
    return html`<div class="pfiles-crumb">${nodes}</div>`;
  }

  fileColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (e) => (e ? fileName(e) : ''),
        render: (e) => html`<span class=${isDir(e) ? 'pfiles-name pfiles-dir' : 'pfiles-name'}>${fileName(e) + (isDir(e) ? '/' : '')}</span>`,
      },
      {
        key: 'type',
        title: '类型',
        width: 90,
        sort: (e) => (isDir(e) ? '目录' : String(e.mode || '文件')),
        render: (e) => html`<sl-badge pill variant="neutral">${isDir(e) ? '目录' : String(e.mode || '文件')}</sl-badge>`,
      },
      {
        key: 'size',
        title: '大小',
        width: 110,
        align: 'right',
        sort: (e) => sizeOf(e),
        render: (e) => (isDir(e) ? html`<span class="muted">-</span>` : html`<span>${fmtBytes(sizeOf(e))}</span>`),
      },
      {
        key: 'modTime',
        title: '修改时间',
        width: 180,
        render: (e) => html`<span>${fmtTime(modTime(e))}</span>`,
      },
      {
        title: '操作',
        actions: true,
        width: 190,
        render: (e) => (isDir(e)
          ? html`<sl-button size="small" @click=${() => this.browse(e.path || joinPath(this.path, fileName(e)))}>打开</sl-button>`
          : html`<sl-button size="small" href=${downloadURL(this.mountId, e.path || joinPath(this.path, fileName(e)))}
                .download=${fileName(e)}>下载</sl-button>
              <sl-button size="small" outline target="_blank" rel="noopener"
                href=${downloadURL(this.mountId, e.path || joinPath(this.path, fileName(e)), true)}>预览</sl-button>`),
      },
    ];
  }

  renderList() {
    if (!this.mountId) {
      return html`<nunt-empty text="请选择或先创建一个存储挂载点"
        hint="在「存储」页面创建挂载点后，这里就能浏览目录。"></nunt-empty>`;
    }
    const q = this.filter.trim();
    return html`<nunt-table caption="目录内容"
      .columns=${this.fileColumns()} .rows=${this.filtered()} .loading=${this.listLoading}
      .error=${this.listError} .onRetry=${() => this.browse(this.path)}
      .rowKey=${(e, index) => entryKey(e, index)}
      empty=${q ? '没有匹配的文件' : '该目录为空'}
      emptyHint=${q ? '换个关键字，或清空右侧的过滤框。' : '这个目录里还没有文件。'}></nunt-table>`;
  }

  renderBrowser() {
    if (this.mountsError) {
      return html`<nunt-error .error=${this.mountsError} heading="无法读取存储挂载点"
        .onRetry=${() => this.loadMounts()}></nunt-error>`;
    }
    if (this.mountsLoading && !this.mounts.length) {
      return html`<nunt-loading text="正在读取存储挂载点…"></nunt-loading>`;
    }
    return html`
      <div class="pfiles-tools">
        <sl-select label="挂载点" size="small" class="pfiles-mount" .value=${this.mountId}
          @sl-change=${(event) => this.onMountChange(event)}>
          ${this.mounts.length
            ? this.mounts.map((m) => html`<sl-option value=${String(m.id)}>${String(m.name || m.id) + (m.readOnly ? '（只读）' : '')}</sl-option>`)
            : html`<sl-option value="">（暂无挂载点）</sl-option>`}
        </sl-select>
        <sl-button size="small" @click=${() => this.browse(parentPath(this.path))}>上一级</sl-button>
        <sl-button size="small" @click=${() => this.browse('/')}>根目录</sl-button>
        <sl-input label="路径" size="small" class="pfiles-path" .value=${this.path} placeholder="/sub/dir"
          @keydown=${(event) => this.onPathKeydown(event)}></sl-input>
        <sl-button size="small" @click=${() => this.goToTypedPath()}>前往</sl-button>
        <span class="spacer"></span>
        <sl-input label="过滤当前目录" size="small" class="pfiles-filter" placeholder="文件名包含…"
          @sl-input=${(event) => this.onFilterInput(event)}></sl-input>
      </div>
      <div class="pfiles-crumb-row">${this.renderCrumbs()}</div>
      ${this.renderList()}
      <p class="muted pfiles-foot">下载地址：/api/v1/files/download?mount={挂载}&path={路径}（浏览器直接打开该地址即可下载）。如果该接口未实现，请通过 Web 服务规则或 WebDAV 下载文件。</p>`;
  }

  shareColumns() {
    return [
      {
        key: 'mountId',
        title: '挂载 / 路径',
        render: (s) => html`<div>
          <div class="mono">${String(s.mountId || s.mount || '-') + ' ' + String(s.path || '-')}</div>
          ${s.name ? html`<div class="muted pfiles-share-name">${String(s.name)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'url',
        title: '链接',
        render: (s) => {
          const url = this.shareURL(s, s.token || s.id);
          if (!url) return html`<span class="muted">-</span>`;
          return html`<span class="row">
            <span class="mono pfiles-url">${url}</span>
            <sl-button size="small" outline @click=${() => this.copyShare(s)}>复制</sl-button>
          </span>`;
        },
      },
      {
        key: 'expiresAt',
        title: '有效期',
        width: 180,
        render: (s) => html`<span>${(s.expiresAt || s.expireAt)
          ? fmtTime(s.expiresAt || s.expireAt)
          : ((s.ttlMinutes || s.shareTtlMinutes) ? (s.ttlMinutes || s.shareTtlMinutes) + ' 分钟' : '永久')}</span>`,
      },
      {
        key: 'createdBy',
        title: '创建者',
        width: 140,
        render: (s) => html`<span class="muted">${String(s.createdBy || s.user || '-')}</span>`,
      },
      {
        title: '操作',
        actions: true,
        width: 110,
        render: (s) => html`<sl-icon-button name="trash" label="取消分享"
          @click=${() => this.removeShare(s)}></sl-icon-button>`,
      },
    ];
  }

  renderShares() {
    if (this.shareUnavailable) {
      return html`<nunt-empty text="分享链接暂不可用"
        hint="分享链接由文件管理模块（filebrowser）提供，当前后端没有注册该模块。启用后点「重新检测」，或者改用 Web 服务里的“文件管理”规则分享文件。"
        .action=${html`<sl-button size="small" @click=${() => this.loadShares()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>重新检测
        </sl-button>`}></nunt-empty>`;
    }
    if (this.sharesError) {
      return html`<nunt-error .error=${this.sharesError} heading="分享链接接口不可用"
        hint="分享链接由文件管理模块（filebrowser）提供；如果该模块未启用，可以改用 Web 服务里的“文件管理”规则生成分享链接。"
        .onRetry=${() => this.loadShares()}></nunt-error>`;
    }
    return html`<nunt-table caption="分享链接"
      .columns=${this.shareColumns()} .rows=${this.shares} .loading=${this.sharesLoading}
      .rowKey=${(s) => (s && (s.id || s.token)) || ''}
      empty="暂无分享链接（在文件管理站点中点击“分享”可生成）"></nunt-table>`;
  }

  render() {
    return html`
      <section class="card">
        <div class="card-header">
          <h2>文件浏览</h2>
          <span class="spacer"></span>
          <span class="sub">GET /api/v1/storage/mounts/{id}/list?path=</span>
          <sl-button size="small" @click=${() => this.browse(this.path)}>
            <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
          </sl-button>
        </div>
        <div class="card-body">${this.renderBrowser()}</div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>分享链接</h2>
          <span class="spacer"></span>
          <span class="sub">GET/DELETE /api/v1/files/shares</span>
          <sl-button size="small" @click=${() => this.loadShares()}>
            <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
          </sl-button>
        </div>
        <div class="card-body">${this.renderShares()}</div>
      </section>`;
  }
}

define('nunt-page-files', FilesPage);

export default {
  id: 'files',
  title: '文件管理',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-files');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
