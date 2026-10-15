// 通知页：Webhook 增删改与测试。
//
// 这是阶段 1 的「模板页」：页面 = 一个 light DOM 的 Lit 元素（NuntElement 子类），
// 表格/表单/对话框/提示全部来自 lib/kit.js，数据流（ctx.api 的接口与字段）与迁移前一致。
// 复制这一页改 render() 就能得到下一页，见 docs/CONTRACT.md 第 7 节。
import {
  NuntElement, html, nothing, define, formGrid, openDialog, confirmDialog, toast,
  errorMessage,
} from '../lib/kit.js';

const EVENTS = [
  { value: 'cert.issued', label: '证书签发成功 (cert.issued)' },
  { value: 'cert.failed', label: '证书签发失败 (cert.failed)' },
  { value: 'ddns.update', label: '动态域名更新成功 (ddns.update)' },
  { value: 'ddns.error', label: '动态域名更新失败 (ddns.error)' },
  { value: 'system.alert', label: '系统告警 (system.alert)' },
];

const METHODS = ['POST', 'PUT', 'GET', 'PATCH'];

function eventLabel(name) {
  const known = EVENTS.find((item) => item.value === name);
  return known ? known.label.replace(/\s*\(.*\)$/, '') : String(name);
}

class NotifyPage extends NuntElement {
  static properties = {
    hooks: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.hooks = [];
    this.loading = true;
    this.error = null;
    this.busyId = '';
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

  /** dispose 由 mount 返回的清理函数调用：断开后不再写 state。 */
  dispose() {
    this.disposed = true;
    this.remove();
  }

  get columns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => (row ? row.name || '' : ''),
        render: (row) => html`<span>${row.name || '未命名'}</span>`,
      },
      {
        key: 'url',
        title: '地址',
        sort: (row) => (row ? row.url || '' : ''),
        render: (row) => html`<span class="mono muted nunt-url">${row.url || ''}</span>`,
      },
      {
        key: 'method',
        title: '方法',
        width: 90,
        render: (row) => html`<sl-badge pill variant="neutral">${row.method || 'POST'}</sl-badge>`,
      },
      {
        key: 'events',
        title: '事件',
        sort: (row) => (row && Array.isArray(row.events) ? row.events.join(',') : ''),
        render: (row) => this.eventTags(row.events),
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
        width: 210,
        render: (row) => this.actionButtons(row),
      },
    ];
  }

  eventTags(events) {
    if (!Array.isArray(events) || !events.length) return html`<span class="nunt-muted">全部事件</span>`;
    return html`<span class="row">${events.map((name) => html`<sl-tag size="small">${eventLabel(name)}</sl-tag>`)}</span>`;
  }

  actionButtons(row) {
    const busy = this.busyId !== '' && String(row.id || '') === this.busyId;
    return html`
      <sl-button size="small" ?loading=${busy} @click=${() => this.testHook(row)}>测试</sl-button>
      <sl-button size="small" @click=${() => this.openEditor(row)}>编辑</sl-button>
      <sl-button size="small" variant="danger" outline @click=${() => this.removeHook(row)}>删除</sl-button>`;
  }

  async load() {
    this.loading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/notify/webhooks');
      if (this.disposed) return;
      this.hooks = Array.isArray(data) ? data : [];
      this.error = null;
    } catch (err) {
      if (this.disposed) return;
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  async save(list) {
    const data = await this.ctx.api.put('/api/v1/notify/webhooks', list);
    this.hooks = Array.isArray(data) ? data : list;
  }

  async testHook(row) {
    this.busyId = String(row.id || '');
    try {
      await this.ctx.api.post('/api/v1/notify/webhooks/test', row);
      toast('测试通知已发送：' + (row.name || row.url), 'ok');
    } catch (err) {
      toast(errorMessage(err, '发送失败'), 'err');
    } finally {
      this.busyId = '';
    }
  }

  async removeHook(row) {
    const ok = await confirmDialog('确定要删除 Webhook「' + (row.name || row.url) + '」吗？', {
      danger: true,
      okLabel: '删除',
    });
    if (!ok) return;
    try {
      await this.save(this.hooks.filter((item) => item.id !== row.id));
      toast('已删除', 'ok');
    } catch (err) {
      toast(errorMessage(err, '删除失败'), 'err');
    }
  }

  openEditor(row) {
    const draft = row
      ? JSON.parse(JSON.stringify(row))
      : { name: '', url: '', method: 'POST', enable: true, headers: {}, events: [] };
    const form = formGrid([
      { name: 'name', label: '名称', value: draft.name, placeholder: '例如：运维群机器人' },
      { name: 'url', label: 'Webhook 地址', value: draft.url, placeholder: 'https://example.com/hook', wide: true },
      { name: 'method', label: '请求方法', type: 'select', value: draft.method || 'POST', options: METHODS },
      { name: 'enable', label: '启用', type: 'switch', value: draft.enable !== false, text: '启用该通知' },
      { name: 'events', label: '订阅事件（不选表示全部）', type: 'select', multiple: true, value: draft.events || [], options: EVENTS, wide: true },
      { name: 'headers', label: '自定义请求头', type: 'kv', value: draft.headers || {}, wide: true, hint: '已保存的值以 ******** 展示，保持不变即不会覆盖原值' },
    ]);
    openDialog({
      title: row ? '编辑 Webhook' : '新建 Webhook',
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
            const name = String(values.name || '').trim();
            const url = String(values.url || '').trim();
            if (!name) {
              form.fieldError('name', '请填写名称');
              return;
            }
            if (!/^https?:\/\//i.test(url)) {
              form.fieldError('url', '请填写以 http:// 或 https:// 开头的地址');
              return;
            }
            const next = {
              id: draft.id || '',
              name,
              url,
              method: values.method || 'POST',
              enable: !!values.enable,
              headers: values.headers || {},
              events: Array.isArray(values.events) ? values.events : [],
            };
            if (draft.createdAt) next.createdAt = draft.createdAt;
            dlg.setBusy(true, button);
            try {
              const list = row
                ? this.hooks.map((item) => (item.id === row.id ? Object.assign({}, item, next) : item))
                : this.hooks.concat([next]);
              await this.save(list);
              toast('已保存', 'ok');
              dlg.close();
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

  render() {
    const count = this.hooks.length;
    return html`
      <section class="card">
        <div class="card-header">
          <h2>通知渠道</h2>
          <span class="sub">${count ? '共 ' + count + ' 个 Webhook' : ''}</span>
          <span class="spacer"></span>
          <sl-button size="small" @click=${() => this.load()}>
            <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
          </sl-button>
          <sl-button size="small" variant="primary" @click=${() => this.openEditor(null)}>
            <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建 Webhook
          </sl-button>
        </div>
        <div class="card-body tight">
          <nunt-table caption="Webhook 通知渠道"
            .columns=${this.columns} .rows=${this.hooks} .loading=${this.loading} .error=${this.error}
            .onRetry=${() => this.load()} .rowKey=${(row) => row && row.id ? row.id : row.url}
            empty="还没有配置 Webhook 通知"
            emptyHint="点右上角「新建 Webhook」把事件通知发到你的机器人或告警平台。"></nunt-table>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <p class="muted" style="margin: 0; font-size: 13px;">
            Webhook 会在订阅事件发生时以 JSON 形式 POST 到目标地址；自定义请求头常用于鉴权令牌，保存后仅以掩码展示。
          </p>
        </div>
      </section>`;
  }
}

define('nunt-page-notify', NotifyPage);

export default {
  id: 'notify',
  title: '通知',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 19a2 2 0 004 0"/></svg>',
  async mount(root, ctx) {
    const page = document.createElement('nunt-page-notify');
    page.ctx = ctx;
    root.appendChild(page);
    return () => page.dispose();
  },
};
