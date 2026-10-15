// 计划任务：cron 调度 + 动作列表。
//
// 阶段 2 迁移：任务表格换成 kit 的 nunt-table（操作列走 actions —— 右对齐、不换行，
// 不再有 axe 的 empty-table-header），cron 摘要 / 上次运行结果与相对时间 / 下次运行逐列保留；
// 新建与编辑走 openDialog + 按类型显示字段的动作编辑器（动作列表增删、cron 常用示例按钮、
// 测试与校验文案不变）；「立即运行」仍然走 POST /api/v1/task/items/{id}/run；
// 删除确认统一走 confirmDialog。卡片标题 h2。
//
// 数据流与迁移前一致：GET/POST/PUT/DELETE /api/v1/task/items[/{id}]、
// POST /api/v1/task/items/{id}/toggle（后端没有这条路由时退回 PUT 全量更新），
// 提交体字段名不变：name/enable/cron/remark/actions[]。
import {
  NuntElement, html, nothing, define, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
} from '../lib/kit.js';

const EOL = String.fromCharCode(10);
const ACTION_LABEL = {
  'module.toggle': '模块开关',
  'rule.toggle': '规则开关',
  'http.request': 'HTTP 请求',
  'notify.webhook': '发送通知',
  'shell.exec': '执行 Shell',
};
const ACTION_TYPES = Object.keys(ACTION_LABEL).map((key) => ({ value: key, label: ACTION_LABEL[key] }));
const NOTIFY_EVENTS = [
  'ddns.updated', 'ddns.failed', 'acme.issued', 'acme.failed',
  'waf.blocked', 'forward.error', 'web.error', 'cert.expiring', 'task.failed',
];
const CRON_EXAMPLES = [
  { expr: '*/5 * * * *', label: '每 5 分钟' },
  { expr: '0 * * * *', label: '每小时' },
  { expr: '30 3 * * *', label: '每天 03:30' },
  { expr: '0 4 * * 0', label: '每周日 04:00' },
  { expr: '0 0 1 * *', label: '每月 1 日 00:00' },
  { expr: '@every 30m', label: '每 30 分钟' },
  { expr: '@daily', label: '每天（快捷）' },
];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const RULE_MODULES = ['forward', 'web'];

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.ptask-tools{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
  '.ptask-tools .ptask-search{width:220px}',
  '.ptask-name{font-weight:600;word-break:break-word}',
  '.ptask-remark{font-size:11px;color:var(--text-faint);word-break:break-word}',
  '.ptask-cron{word-break:break-all}',
  '.ptask-chips{display:flex;flex-wrap:wrap;gap:4px}',
  '.ptask-ago{font-size:11px;color:var(--text-faint)}',
  '.ptask-examples{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
  '.ptask-actions{display:flex;flex-direction:column;gap:8px}',
  '.ptask-switch{font-size:12px}',
  '.ptask-act{display:grid;grid-template-columns:150px 1fr auto;gap:8px;align-items:start;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px}',
  '@media (max-width:760px){.ptask-act{grid-template-columns:1fr}}',
  '.ptask-actbody{display:flex;flex-direction:column;gap:6px;min-width:0}',
  '.ptask-actgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
  '.ptask-actgrid .is-wide{grid-column:1/-1}',
  '.ptask-actadd{margin-top:8px}',
  '.ptask-note{margin:0 0 12px;font-size:12.5px;color:var(--text-dim)}',
  '.ptask-empty-actions{margin:0;font-size:12.5px;color:var(--text-dim)}',
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

function lastRun(task) {
  return task.lastRun || task.lastTime || task.lastExecutedAt || (task.state && task.state.lastRun) || null;
}

function lastResult(task) {
  const s = task.state || task;
  return s.lastResult || s.lastMessage || s.message || s.lastError || (s.lastOK === true ? '成功' : (s.lastOK === false ? '失败' : ''));
}

function dateAgo(t) {
  if (!t) return '-';
  const date = (t instanceof Date) ? t : new Date(String(t));
  if (isNaN(date.getTime())) return String(t);
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 0) return fmtTime(t);
  if (secs < 60) return secs + ' 秒前';
  if (secs < 3600) return Math.floor(secs / 60) + ' 分钟前';
  if (secs < 86400) return Math.floor(secs / 3600) + ' 小时前';
  return Math.floor(secs / 86400) + ' 天前';
}

function kvText(map) {
  const src = map || {};
  return Object.keys(src).map((key) => key + ': ' + src[key]).join(EOL);
}

function keyValues(value) {
  const out = {};
  for (const raw of String(value === undefined || value === null ? '' : value).split(EOL)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/* ------------------------------------------------------------------ 动作编辑器 */

/**
 * ActionListEditor：按类型显示字段的动作列表编辑（迁移前 actionRow 的等价物）。
 * 每一行有自己的类型下拉、字段区与删除按钮；collect() 把整份列表读成提交用的数组。
 */
class ActionListEditor extends NuntElement {
  static properties = { actions: { attribute: false }, disabled: { type: Boolean } };

  constructor() {
    super();
    this.actions = [];
    this.disabled = false;
  }

  add(action) {
    this.actions = this.actions.concat([action || { type: 'module.toggle' }]);
  }

  removeAt(index) {
    const next = this.actions.slice();
    next.splice(index, 1);
    this.actions = next;
  }

  setType(index, type) {
    const next = this.actions.slice();
    next[index] = { type };
    this.actions = next;
  }

  /** collect 汇总所有动作行；host 上找不到控件时退回该行当前的值。 */
  collect() {
    const out = [];
    const rows = Array.from(this.querySelectorAll('.ptask-act'));
    for (let index = 0; index < this.actions.length; index += 1) {
      const action = this.actions[index] || { type: 'module.toggle' };
      const type = action.type || 'module.toggle';
      const row = rows[index] || null;
      const read = (name) => {
        const node = row ? row.querySelector('[data-field="' + name + '"]') : null;
        return node && node.value !== undefined && node.value !== null ? String(node.value).trim() : '';
      };
      if (type === 'module.toggle') {
        out.push({ type, target: read('target') || String(action.target || ''), value: read('value') || String(action.value || 'restart') });
      } else if (type === 'rule.toggle') {
        out.push({ type, target: read('target') || String(action.target || ''), value: read('value') || String(action.value || ''), url: read('url') || String(action.url || 'on') });
      } else if (type === 'http.request') {
        const headers = read('headers');
        out.push({
          type,
          method: read('method') || String(action.method || 'GET').toUpperCase(),
          url: read('url') || String(action.url || ''),
          headers: headers ? keyValues(headers) : (action.headers || {}),
          body: read('body') !== '' ? read('body') : String(action.body || ''),
        });
      } else if (type === 'notify.webhook') {
        const events = Array.isArray(action.events) ? action.events.slice() : [];
        const choice = read('events') || events[0] || '';
        out.push({ type, target: read('target') || String(action.target || ''), headers: choice ? { __events: choice } : undefined, value: read('value') || String(action.value || '') });
      } else {
        out.push({ type, command: read('command') || String(action.command || '') });
      }
    }
    return out;
  }

  renderBody(action) {
    const type = action.type || 'module.toggle';
    if (type === 'module.toggle') {
      return html`<div class="ptask-actgrid">
        <sl-input size="small" data-field="target" label="模块名" placeholder="模块名，例如 web / ddns / waf / forward"
          .value=${String(action.target || '')}></sl-input>
        <sl-select size="small" data-field="value" label="动作" .value=${String(action.value || 'restart')}>
          <sl-option value="on">启动</sl-option>
          <sl-option value="off">停止</sl-option>
          <sl-option value="restart">重启</sl-option>
        </sl-select>
      </div>`;
    }
    if (type === 'rule.toggle') {
      return html`<div class="ptask-actgrid">
        <sl-select size="small" data-field="target" label="模块" .value=${String(action.target || 'forward')}>
          ${RULE_MODULES.map((name) => html`<sl-option value=${name}>${name}</sl-option>`)}
        </sl-select>
        <sl-input size="small" data-field="value" label="规则 ID" placeholder="规则 ID"
          .value=${String(action.value || '')}></sl-input>
        <sl-select size="small" data-field="url" label="动作" .value=${String(action.url || 'on')}>
          <sl-option value="on">启用规则</sl-option>
          <sl-option value="off">停用规则</sl-option>
        </sl-select>
      </div>`;
    }
    if (type === 'http.request') {
      return html`<div class="ptask-actgrid">
        <sl-select size="small" data-field="method" label="方法" .value=${String(action.method || 'GET').toUpperCase()}>
          ${HTTP_METHODS.map((method) => html`<sl-option value=${method}>${method}</sl-option>`)}
        </sl-select>
        <sl-input size="small" data-field="url" label="URL" placeholder="https://example.com/hook"
          .value=${String(action.url || '')}></sl-input>
        <sl-textarea class="is-wide" size="small" rows="2" data-field="headers" label="请求头"
          placeholder="每行一条 key: value" .value=${kvText(action.headers)}></sl-textarea>
        <sl-textarea class="is-wide" size="small" rows="2" data-field="body" label="请求体"
          placeholder="请求体（可选）" .value=${String(action.body || '')}></sl-textarea>
      </div>`;
    }
    if (type === 'notify.webhook') {
      const events = Array.isArray(action.events) ? action.events : [];
      return html`<div class="ptask-actgrid">
        <sl-input size="small" data-field="target" label="webhook ID" placeholder="留空表示全部通知渠道"
          help-text="对应「通知」页面里的 webhook" .value=${String(action.target || '')}></sl-input>
        <sl-select size="small" data-field="events" label="事件" .value=${String(events[0] || '')}>
          <sl-option value="">（不指定事件）</sl-option>
          ${NOTIFY_EVENTS.map((name) => html`<sl-option value=${name}>${name}</sl-option>`)}
        </sl-select>
        <sl-input class="is-wide" size="small" data-field="value" label="通知内容" placeholder="留空使用默认文案"
          .value=${String(action.value || '')}></sl-input>
      </div>`;
    }
    return html`<div class="ptask-actgrid">
      <sl-textarea class="is-wide" size="small" rows="2" data-field="command" label="命令"
        placeholder="需要后台显式开启 shell 才能执行" help-text="禁止拼接未校验的用户输入"
        .value=${String(action.command || '')}></sl-textarea>
    </div>`;
  }

  renderRow(action, index) {
    return html`<div class="ptask-act">
      <sl-select size="small" label="动作类型" .value=${action.type || 'module.toggle'}
        ?disabled=${this.disabled}
        @sl-change=${(event) => this.setType(index, event.target.value)}>
        ${ACTION_TYPES.map((item) => html`<sl-option value=${item.value}>${item.label}</sl-option>`)}
      </sl-select>
      <div class="ptask-actbody">${this.renderBody(action)}</div>
      <sl-button size="small" variant="danger" outline ?disabled=${this.disabled}
        @click=${() => this.removeAt(index)}>删除</sl-button>
    </div>`;
  }

  render() {
    return html`<div class="ptask-actions">
      ${this.actions.length
        ? this.actions.map((action, index) => this.renderRow(action, index))
        : html`<p class="ptask-empty-actions">还没有动作，点下面的「添加动作」加一个。</p>`}
      <div class="ptask-actadd">
        <sl-button size="small" ?disabled=${this.disabled} @click=${() => this.add({ type: 'module.toggle' })}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>添加动作
        </sl-button>
      </div>
    </div>`;
  }
}

define('nunt-action-list', ActionListEditor);

/* ------------------------------------------------------------------ 页面 */

class TaskPage extends NuntElement {
  static properties = {
    items: { attribute: false },
    loading: { type: Boolean },
    error: { attribute: false },
    query: { type: String },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.items = [];
    this.loading = true;
    this.error = null;
    this.query = '';
    this.busyId = '';
    this.searchTimer = null;
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

  /** dispose 由 mount 返回的清理函数调用：清掉防抖定时器、关掉本页打开的对话框。 */
  dispose() {
    this.disposed = true;
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    for (const dialog of Array.from(this.dialogs)) {
      try { dialog.close(); } catch (err) { /* 忽略 */ }
    }
    this.dialogs.clear();
    this.remove();
  }

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
      const data = await this.ctx.api.get('/api/v1/task/items');
      if (this.disposed) return;
      this.items = unwrap(data, ['items', 'tasks', 'list']);
      this.error = null;
    } catch (err) {
      if (this.disposed) return;
      this.items = [];
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  filtered() {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((task) => [task.name, task.cron, (task.actions || []).map((a) => a.type + ' ' + (a.target || '')).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0);
  }

  /* ---------------------------------------------------------------- 动作 */

  async toggle(item, next) {
    const want = next === undefined ? !item.enable : !!next;
    this.busyId = String(item.id || '');
    try {
      try {
        await this.ctx.api.post('/api/v1/task/items/' + encodeURIComponent(item.id) + '/toggle');
      } catch (err) {
        // 后端目前没有这条路由：退回整条任务的更新（与迁移前一致）。
        await this.ctx.api.put('/api/v1/task/items/' + encodeURIComponent(item.id), Object.assign({}, item, { enable: want }));
      }
      if (this.disposed) return;
      toast(want ? '已启用' : '已停用', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('切换失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  async removeTask(item) {
    const ok = await confirmDialog('确定删除计划任务「' + (item.name || item.id) + '」吗？', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/task/items/' + encodeURIComponent(item.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  async runNow(item) {
    this.busyId = String(item.id || '');
    toast('正在执行「' + (item.name || item.id) + '」…', 'info');
    try {
      const res = await this.ctx.api.post('/api/v1/task/items/' + encodeURIComponent(item.id) + '/run');
      if (this.disposed) return;
      const data = res || {};
      const msg = data.message || data.result || (data.ok === false ? '执行失败' : '已排入执行队列');
      toast((data.ok === false ? '执行失败：' : '执行完成：') + msg, data.ok === false ? 'err' : 'ok');
      await this.load();
    } catch (err) {
      if (this.disposed) return;
      toast('执行失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  /* ---------------------------------------------------------------- 表单 */

  openTaskForm(item) {
    const base = item || {};
    const editing = !!base.id;
    const editor = document.createElement('nunt-action-list');
    editor.actions = Array.isArray(base.actions) && base.actions.length
      ? base.actions.map((action) => Object.assign({}, action))
      : [];

    // cron 输入框下面要挂「常用示例」按钮（迁移前 cronHintBox 的位置），而 nunt-form 只渲染自己的
    // 字段，所以这里用 custom 字段把「sl-input + 示例按钮」整块交给 kit 渲染。
    const cronInput = document.createElement('sl-input');
    cronInput.setAttribute('label', 'Cron 表达式');
    cronInput.setAttribute('placeholder', '*/5 * * * *');
    cronInput.setAttribute('help-text', '5 段式（分 时 日 月 周），也支持 @every 30m / @daily 这类快捷写法');
    cronInput.value = base.cron || '';
    cronInput.addEventListener('sl-input', (event) => form.set('cron', event.target.value));
    const cronBox = document.createElement('div');
    cronBox.appendChild(cronInput);
    const examples = document.createElement('div');
    examples.className = 'ptask-examples';
    for (const example of CRON_EXAMPLES) {
      const btn = document.createElement('sl-button');
      btn.setAttribute('size', 'small');
      btn.setAttribute('title', example.expr);
      btn.textContent = example.label;
      btn.addEventListener('click', () => {
        form.set('cron', example.expr);
        cronInput.value = example.expr;
        toast('已填入：' + example.expr, 'ok');
      });
      examples.appendChild(btn);
    }
    cronBox.appendChild(examples);
    const form = formGrid([
      { name: 'name', label: '名称', value: base.name || '', placeholder: '例如 每天检查证书' },
      { name: 'enable', label: '启用', type: 'switch', value: base.enable !== false, text: '启用该任务' },
      { name: 'cron', label: 'Cron 表达式', type: 'custom', wide: true, value: base.cron || '', node: cronBox },
      { name: 'remark', label: '备注', value: base.remark || '', placeholder: '备注（可选）', wide: true },
    ]);
    const body = document.createElement('div');
    body.appendChild(form.node);
    body.appendChild(editor);

    this.openPageDialog({
      title: editing ? '编辑计划任务' : '新建计划任务',
      body,
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
            const cron = String(values.cron || '').trim();
            if (!name) { form.fieldError('name', '请填写任务名称'); return; }
            if (!cron) { form.fieldError('cron', '请填写 Cron 表达式'); return; }
            const actions = editor.collect();
            if (!actions.length) {
              form.error('请至少添加一个动作');
              return;
            }
            const payload = { name, enable: !!values.enable, cron, remark: String(values.remark || '').trim(), actions };
            dlg.setBusy(true, button);
            try {
              if (editing) await this.ctx.api.put('/api/v1/task/items/' + encodeURIComponent(base.id), payload);
              else await this.ctx.api.post('/api/v1/task/items', payload);
              if (this.disposed) return;
              toast('保存成功', 'ok');
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
  }

  /* ---------------------------------------------------------------- 渲染 */

  taskColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => (row ? String(row.name || row.id || '') : ''),
        render: (row) => html`<div>
          <div class="ptask-name">${String(row.name || row.id || '')}</div>
          ${row.remark ? html`<div class="ptask-remark">${String(row.remark)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'cron',
        title: 'Cron',
        width: 140,
        sort: (row) => (row ? String(row.cron || '') : ''),
        render: (row) => html`<span class="mono ptask-cron">${String(row.cron || '-')}</span>`,
      },
      {
        key: 'actions',
        title: '动作',
        render: (row) => {
          const list = row.actions || [];
          if (!list.length) return html`<span class="muted">-</span>`;
          const labels = list.map((action) => ACTION_LABEL[action.type] || action.type);
          const shown = labels.slice(0, 3);
          return html`<span class="ptask-chips">
            ${shown.map((label) => html`<sl-badge pill variant="neutral">${label}</sl-badge>`)}
            ${labels.length > shown.length ? html`<span class="muted">+${labels.length - shown.length}</span>` : nothing}
          </span>`;
        },
      },
      {
        key: 'lastRun',
        title: '上次运行',
        width: 180,
        sort: (row) => {
          const value = lastRun(row);
          const time = value ? new Date(String(value)).getTime() : 0;
          return isNaN(time) ? 0 : time;
        },
        render: (row) => {
          const value = lastRun(row);
          return html`<div>
            <div>${fmtTime(value)}</div>
            ${value ? html`<div class="ptask-ago">${dateAgo(value)}</div>` : nothing}
          </div>`;
        },
      },
      {
        key: 'nextRun',
        title: '下次运行',
        width: 180,
        render: (row) => html`<span class="muted">${fmtTime(row.nextRun || (row.state && row.state.nextRun))}</span>`,
      },
      {
        key: 'result',
        title: '运行结果',
        render: (row) => {
          const result = lastResult(row);
          if (!result) return html`<span class="muted">尚未运行</span>`;
          const bad = /失败|error|fail/i.test(String(result));
          return html`<sl-badge pill variant=${bad ? 'danger' : 'success'}>${String(result).slice(0, 40)}</sl-badge>`;
        },
      },
      {
        key: 'enable',
        title: '状态',
        width: 130,
        sort: (row) => (row && row.enable ? 1 : 0),
                // 状态文字放进 sl-switch 的可见标签（原因见 forward.js 同名列的说明）。
        render: (row) => html`<sl-switch size="small" class="ptask-switch"
          ?checked=${!!row.enable} ?disabled=${this.busyId === String(row.id || '')}
          title=${row.enable ? '点击停用' : '点击启用'}
          @sl-change=${(event) => this.toggle(row, !!event.target.checked)}>${row.enable ? '已启用' : '已停用'}</sl-switch>`,
      },
      {
        title: '操作',
        actions: true,
        width: 150,
        render: (row) => html`
          <sl-button size="small" title="立即运行" ?loading=${this.busyId === String(row.id || '')}
            @click=${() => this.runNow(row)}>
            <sl-icon name="play-fill" label="立即运行"></sl-icon>
          </sl-button>
          <sl-button size="small" title="编辑" @click=${() => this.openTaskForm(row)}>
            <sl-icon name="pencil-square" label="编辑"></sl-icon>
          </sl-button>
          <sl-button size="small" variant="danger" outline title="删除" @click=${() => this.removeTask(row)}>
            <sl-icon name="trash" label="删除"></sl-icon>
          </sl-button>`,
      },
    ];
  }

  onSearchInput(event) {
    const value = event.target && event.target.value !== undefined ? String(event.target.value) : '';
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (!this.disposed) this.query = value;
    }, 200);
  }

  render() {
    const rows = this.filtered();
    return html`<section class="card">
      <div class="card-header">
        <h2>计划任务</h2>
        <span class="sub">${this.items.length ? '共 ' + this.items.length + ' 个任务' : ''}</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.loading} @click=${() => this.load()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openTaskForm(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建任务
        </sl-button>
      </div>
      <div class="card-body tight">
        <div class="ptask-tools">
          <sl-input class="ptask-search" size="small" label="搜索任务" placeholder="搜索名称/Cron"
            @sl-input=${(event) => this.onSearchInput(event)}></sl-input>
        </div>
        <nunt-table caption="计划任务"
          .columns=${this.taskColumns()} .rows=${rows} .loading=${this.loading}
          .error=${this.error} .onRetry=${() => this.load()}
          .rowKey=${(row) => (row && row.id) || ''}
          empty=${this.items.length ? '没有符合条件的任务' : '还没有计划任务'}
          emptyHint=${this.items.length ? '换个关键字试试。' : '点右上角「新建任务」创建第一个定时任务。'}></nunt-table>
        <p class="ptask-note">shell 动作需要在服务端配置中显式开启；动作按顺序执行，任一动作失败会记录到运行结果中。</p>
      </div>
    </section>`;
  }
}

define('nunt-page-task', TaskPage);

export default {
  id: 'task',
  title: '计划任务',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-task');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
