// 通知页：Webhook 增删改与测试。
import { el, toast, confirmDialog, openModal, renderTable, formGrid, clear } from '../lib/ui.js';

const EVENTS = [
  { value: 'cert.issued', label: '证书签发成功 (cert.issued)' },
  { value: 'cert.failed', label: '证书签发失败 (cert.failed)' },
  { value: 'ddns.update', label: '动态域名更新成功 (ddns.update)' },
  { value: 'ddns.error', label: '动态域名更新失败 (ddns.error)' },
  { value: 'system.alert', label: '系统告警 (system.alert)' },
];

const METHODS = ['POST', 'PUT', 'GET', 'PATCH'];

export default {
  id: 'notify',
  title: '通知',
  async mount(root, ctx) {
    let disposed = false;
    let hooks = [];
    const tableHost = el('div', { class: 'card-body tight' });
    const statusText = el('span', { class: 'sub' }, '');

    function eventLabels(events) {
      if (!Array.isArray(events) || !events.length) return el('span', { class: 'muted' }, '全部事件');
      const wrap = el('span', { class: 'row', style: { gap: '4px' } });
      for (const name of events) {
        const known = EVENTS.find((item) => item.value === name);
        wrap.appendChild(el('span', { class: 'chip' }, known ? known.label.replace(/\s*\(.*\)$/, '') : String(name)));
      }
      return wrap;
    }

    function renderTable2() {
      renderTable(tableHost, {
        empty: '还没有配置 Webhook 通知',
        columns: [
          { title: '名称', render: (row) => el('span', null, String(row.name || '未命名')) },
          {
            title: '地址',
            render: (row) => el('span', { class: 'mono muted' }, String(row.url || '')),
          },
          { title: '方法', width: 80, render: (row) => el('span', { class: 'badge' }, String(row.method || 'POST')) },
          { title: '事件', render: (row) => eventLabels(row.events) },
          {
            title: '状态',
            width: 90,
            render: (row) => el('span', { class: 'badge ' + (row.enable ? 'ok' : '') }, row.enable ? '已启用' : '已停用'),
          },
          {
            title: '操作',
            className: 'actions',
            render: (row) => {
              const test = el('button', { class: 'btn btn-sm', type: 'button' }, '测试');
              test.addEventListener('click', () => testHook(row, test));
              const edit = el('button', { class: 'btn btn-sm', type: 'button' }, '编辑');
              edit.addEventListener('click', () => openEditor(row));
              const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '删除');
              del.addEventListener('click', () => removeHook(row));
              return [test, edit, del];
            },
          },
        ],
        rows: hooks,
      });
      statusText.textContent = hooks.length ? '共 ' + hooks.length + ' 个 Webhook' : '';
    }

    async function load() {
      try {
        const data = await ctx.api.get('/api/v1/notify/webhooks');
        if (disposed) return;
        hooks = Array.isArray(data) ? data : [];
        renderTable2();
      } catch (err) {
        if (disposed) return;
        clear(tableHost);
        tableHost.appendChild(el('div', { class: 'empty' },
          el('div', { class: 'empty-title' }, '无法加载 Webhook 配置'),
          el('div', { class: 'muted' }, err.message || ''),
        ));
      }
    }

    async function save(list) {
      const data = await ctx.api.put('/api/v1/notify/webhooks', list);
      hooks = Array.isArray(data) ? data : list;
      renderTable2();
    }

    async function testHook(row, button) {
      button.disabled = true;
      try {
        await ctx.api.post('/api/v1/notify/webhooks/test', row);
        toast('测试通知已发送：' + (row.name || row.url), 'ok');
      } catch (err) {
        toast(err && err.message ? err.message : '发送失败', 'err');
      } finally {
        button.disabled = false;
      }
    }

    async function removeHook(row) {
      if (!(await confirmDialog('确定要删除 Webhook「' + (row.name || row.url) + '」吗？'))) return;
      try {
        await save(hooks.filter((item) => item.id !== row.id));
        toast('已删除', 'ok');
      } catch (err) {
        toast(err && err.message ? err.message : '删除失败', 'err');
      }
    }

    function openEditor(row) {
      const draft = row ? JSON.parse(JSON.stringify(row)) : { name: '', url: '', method: 'POST', enable: true, headers: {}, events: [] };
      const form = formGrid([
        { name: 'name', label: '名称', value: draft.name, placeholder: '例如：运维群机器人' },
        { name: 'url', label: 'Webhook 地址', value: draft.url, placeholder: 'https://example.com/hook', wide: true },
        { name: 'method', label: '请求方法', type: 'select', value: draft.method || 'POST', options: METHODS },
        { name: 'enable', label: '启用', type: 'switch', value: draft.enable !== false, text: '启用该通知' },
        { name: 'events', label: '订阅事件（不选表示全部）', type: 'select', multiple: true, value: draft.events || [], options: EVENTS, wide: true },
        { name: 'headers', label: '自定义请求头', type: 'kv', value: draft.headers || {}, wide: true, hint: '已保存的值以 ******** 展示，保持不变即不会覆盖原值' },
      ]);
      const error = el('div', { class: 'field error hidden' });
      const body = el('div', null, form.node, error);
      const modal = openModal({
        title: row ? '编辑 Webhook' : '新建 Webhook',
        body,
        wide: true,
        actions: [
          { label: '取消' },
          {
            label: '保存',
            kind: 'primary',
            close: false,
            onClick: async () => {
              error.classList.add('hidden');
              const values = form.read();
              if (!values.name || !values.name.trim()) {
                error.textContent = '请填写名称';
                error.classList.remove('hidden');
                return;
              }
              if (!values.url || !/^https?:\/\//i.test(values.url.trim())) {
                error.textContent = '请填写以 http:// 或 https:// 开头的地址';
                error.classList.remove('hidden');
                return;
              }
              const next = {
                id: draft.id || '',
                name: values.name.trim(),
                url: values.url.trim(),
                method: values.method || 'POST',
                enable: !!values.enable,
                headers: values.headers || {},
                events: Array.isArray(values.events) ? values.events : [],
              };
              if (draft.createdAt) next.createdAt = draft.createdAt;
              modal.setBusy(true);
              try {
                const list = row
                  ? hooks.map((item) => (item.id === row.id ? Object.assign({}, item, next) : item))
                  : hooks.concat([next]);
                await save(list);
                toast('已保存', 'ok');
                modal.close();
              } catch (err) {
                error.textContent = err && err.message ? err.message : '保存失败';
                error.classList.remove('hidden');
              } finally {
                modal.setBusy(false);
              }
            },
          },
        ],
      });
    }

    const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '新建 Webhook');
    addBtn.addEventListener('click', () => openEditor(null));
    const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
    reloadBtn.addEventListener('click', () => load());

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('span', null, '通知渠道'),
        statusText,
        el('span', { class: 'spacer' }),
        reloadBtn,
        addBtn,
      ),
      tableHost,
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-body' },
        el('div', { class: 'muted', style: { fontSize: '13px' } },
          'Webhook 会在订阅事件发生时以 JSON 形式 POST 到目标地址；自定义请求头常用于鉴权令牌，保存后仅以掩码展示。'),
      ),
    ));

    await load();
    return () => { disposed = true; };
  },
};
