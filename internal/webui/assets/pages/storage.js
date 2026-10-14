// 存储页：挂载管理（本地目录 / WebDAV）与目录浏览。
import { el, toast, confirmDialog, openModal, renderTable, formGrid, fmtBytes, fmtTime, clear } from '../lib/ui.js';

const TYPES = [
  { value: 'local', label: '本地目录' },
  { value: 'webdav', label: 'WebDAV' },
];

function typeLabel(type) {
  return type === 'webdav' ? 'WebDAV' : '本地目录';
}

export default {
  id: 'storage',
  title: '存储',
  async mount(root, ctx) {
    let disposed = false;
    let mounts = [];
    const tableHost = el('div', { class: 'card-body tight' });
    const statusText = el('span', { class: 'sub' }, '');

    function render() {
      renderTable(tableHost, {
        empty: '还没有配置存储挂载',
        columns: [
          {
            title: '名称',
            render: (row) => el('div', null,
              el('div', null, String(row.name || '未命名')),
              row.remark ? el('div', { class: 'muted', style: { fontSize: '12px' } }, String(row.remark)) : null,
            ),
          },
          { title: '类型', width: 100, render: (row) => el('span', { class: 'badge' }, typeLabel(row.type)) },
          {
            title: '位置',
            render: (row) => el('span', { class: 'mono muted' },
              row.type === 'webdav' ? String(row.url || '') : String(row.root || '')),
          },
          {
            title: '只读',
            width: 80,
            render: (row) => el('span', { class: 'badge ' + (row.readOnly ? 'warn' : '') }, row.readOnly ? '只读' : '可写'),
          },
          {
            title: '状态',
            width: 90,
            render: (row) => el('span', { class: 'badge ' + (row.enable ? 'ok' : '') }, row.enable ? '已启用' : '已停用'),
          },
          {
            title: '操作',
            className: 'actions',
            render: (row) => {
              const browse = el('button', { class: 'btn btn-sm', type: 'button' }, '浏览');
              browse.addEventListener('click', () => openBrowser(row));
              const test = el('button', { class: 'btn btn-sm', type: 'button' }, '测试');
              test.addEventListener('click', () => testMount(row, test));
              const edit = el('button', { class: 'btn btn-sm', type: 'button' }, '编辑');
              edit.addEventListener('click', () => openEditor(row));
              const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '删除');
              del.addEventListener('click', () => remove(row));
              if (!row.enable) {
                for (const btn of [browse, test]) btn.disabled = false;
              }
              return [browse, test, edit, del];
            },
          },
        ],
        rows: mounts,
      });
      statusText.textContent = mounts.length ? '共 ' + mounts.length + ' 个挂载' : '';
    }

    async function load() {
      try {
        const data = await ctx.api.get('/api/v1/storage/mounts');
        if (disposed) return;
        mounts = Array.isArray(data) ? data : [];
        render();
      } catch (err) {
        if (disposed) return;
        clear(tableHost);
        tableHost.appendChild(el('div', { class: 'empty' },
          el('div', { class: 'empty-title' }, '无法加载存储挂载'),
          el('div', { class: 'muted' }, err.message || ''),
        ));
      }
    }

    async function testMount(row, button) {
      button.disabled = true;
      try {
        await ctx.api.post('/api/v1/storage/mounts/test', { mount: row, id: row.id || '' });
        toast('连接正常：' + (row.name || ''), 'ok');
      } catch (err) {
        toast(err && err.message ? err.message : '连接失败', 'err');
      } finally {
        button.disabled = false;
      }
    }

    async function remove(row) {
      if (!(await confirmDialog('确定要删除挂载「' + (row.name || '') + '」吗？引用它的站点会立即失效。'))) return;
      try {
        await ctx.api.del('/api/v1/storage/mounts/' + encodeURIComponent(row.id));
        toast('已删除', 'ok');
        await load();
      } catch (err) {
        toast(err && err.message ? err.message : '删除失败', 'err');
      }
    }

    function buildPayload(values, draft) {
      const payload = {
        id: draft.id || '',
        name: String(values.name || '').trim(),
        type: values.type,
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
      if (values.type === 'webdav') {
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

    function openEditor(row) {
      const draft = row ? JSON.parse(JSON.stringify(row)) : {
        name: '', type: 'local', enable: true, readOnly: false, root: '', url: '', username: '', password: '', insecureTls: false, remark: '',
      };
      if (!draft.type) draft.type = 'local';
      const isNew = !row;

      const form = formGrid([
        { name: 'name', label: '名称', value: draft.name, placeholder: '例如：NAS 备份' },
        { name: 'type', label: '类型', type: 'select', value: draft.type, options: TYPES, disabled: !isNew },
        { name: 'enable', label: '启用', type: 'switch', value: draft.enable !== false, text: '启用该挂载' },
        { name: 'readOnly', label: '只读', type: 'switch', value: !!draft.readOnly, text: '禁止写入' },
        { name: 'root', label: '本地路径', value: draft.root || '', placeholder: '/data/media 或 D:\\media', wide: true, hint: '必须存在且服务进程可读' },
        { name: 'url', label: 'WebDAV 地址', value: draft.url || '', placeholder: 'https://dav.example.com/remote.php/dav', wide: true },
        { name: 'username', label: '用户名', value: draft.username || '' },
        { name: 'password', label: '密码', type: 'password', value: draft.password || '', placeholder: isNew ? '' : '留空或保持 ******** 表示不修改' },
        { name: 'insecureTls', label: '跳过证书校验', type: 'switch', value: !!draft.insecureTls, text: '不校验服务器证书（自签名场景）' },
        { name: 'remark', label: '备注', value: draft.remark || '', wide: true },
      ]);

      const applyType = () => {
        const type = form.get('type');
        const webdav = type === 'webdav';
        form.toggle('root', !webdav);
        form.toggle('url', webdav);
        form.toggle('username', webdav);
        form.toggle('password', webdav);
        form.toggle('insecureTls', webdav);
        form.toggle('readOnly', true);
      };
      applyType();
      form.input('type').addEventListener('change', applyType);

      const error = el('div', { class: 'field error hidden' });
      const testResult = el('span', { class: 'muted' });
      const testBtn = el('button', { class: 'btn', type: 'button' }, '测试连接');
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testResult.textContent = '正在测试…';
        try {
          const payload = buildPayload(form.read(), draft);
          if (!isNew && (!payload.password || payload.password === '********')) payload.password = '********';
          await ctx.api.post('/api/v1/storage/mounts/test', { mount: payload, id: draft.id || '' });
          testResult.textContent = '';
          toast('连接正常', 'ok');
        } catch (err) {
          testResult.textContent = err && err.message ? err.message : '连接失败';
          toast(err && err.message ? err.message : '连接失败', 'err');
        } finally {
          testBtn.disabled = false;
        }
      });

      const body = el('div', null, form.node, error);
      const modal = openModal({
        title: isNew ? '新建挂载' : '编辑挂载',
        body,
        wide: true,
        actions: [
          { label: '取消' },
          { spacer: true },
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
              if (values.type === 'webdav') {
                if (!values.url || !/^https?:\/\//i.test(String(values.url).trim())) {
                  error.textContent = '请填写以 http:// 或 https:// 开头的 WebDAV 地址';
                  error.classList.remove('hidden');
                  return;
                }
              } else if (!values.root || !String(values.root).trim()) {
                error.textContent = '请填写本地路径';
                error.classList.remove('hidden');
                return;
              }
              const payload = buildPayload(values, draft);
              modal.setBusy(true);
              try {
                if (isNew) await ctx.api.post('/api/v1/storage/mounts', payload);
                else await ctx.api.put('/api/v1/storage/mounts/' + encodeURIComponent(draft.id), payload);
                toast('已保存', 'ok');
                modal.close();
                await load();
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
      modal.footer.insertBefore(el('span', { class: 'row', style: { marginRight: 'auto' } }, testBtn, testResult), modal.footer.firstChild);
    }

    function openBrowser(row) {
      const listing = el('div', { class: 'listing' });
      const crumbs = el('div', { class: 'crumbs' });
      const info = el('span', { class: 'muted' }, '');
      let currentPath = '/';

      function renderCrumbs() {
        clear(crumbs);
        const parts = String(currentPath || '/').split('/').filter(Boolean);
        const root = el('button', { type: 'button' }, '/');
        root.addEventListener('click', () => open('/'));
        crumbs.appendChild(root);
        let acc = '';
        for (const part of parts) {
          acc += '/' + part;
          const target = acc;
          crumbs.appendChild(el('span', { class: 'muted' }, '/'));
          const btn = el('button', { type: 'button' }, part);
          btn.addEventListener('click', () => open(target));
          crumbs.appendChild(btn);
        }
      }

      async function open(path) {
        currentPath = path || '/';
        renderCrumbs();
        clear(listing);
        listing.appendChild(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', null, '读取中…')));
        try {
          const data = await ctx.api.get('/api/v1/storage/mounts/' + encodeURIComponent(row.id) + '/list', { path: currentPath });
          if (disposed) return;
          const entries = data && Array.isArray(data.entries) ? data.entries.slice() : [];
          entries.sort((a, b) => (a.dir === b.dir ? String(a.name).localeCompare(String(b.name)) : (a.dir ? -1 : 1)));
          clear(listing);
          if (!entries.length) {
            listing.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-title' }, '目录为空')));
          }
          for (const entry of entries) {
            const isDir = !!entry.dir;
            const node = el('div', { class: 'entry' + (isDir ? ' dir' : '') },
              el('span', { class: 'badge' }, isDir ? '目录' : '文件'),
              el('span', { class: 'entry-name' }, String(entry.name || '')),
              el('span', { class: 'entry-size' }, isDir ? '' : fmtBytes(entry.size)),
              el('span', { class: 'entry-size' }, entry.modTime ? fmtTime(entry.modTime) : ''),
            );
            if (isDir) node.addEventListener('click', () => open(entry.path || (currentPath.replace(/\/$/, '') + '/' + entry.name)));
            listing.appendChild(node);
          }
          info.textContent = entries.length + ' 项 · ' + (row.readOnly ? '只读' : '可读写');
        } catch (err) {
          clear(listing);
          listing.appendChild(el('div', { class: 'empty' },
            el('div', { class: 'empty-title' }, '无法读取目录'),
            el('div', { class: 'muted' }, err && err.message ? err.message : ''),
          ));
        }
      }

      const up = el('button', { class: 'btn btn-sm', type: 'button' }, '上一级');
      up.addEventListener('click', () => {
        const parts = String(currentPath || '/').split('/').filter(Boolean);
        parts.pop();
        open('/' + parts.join('/'));
      });
      const refresh = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
      refresh.addEventListener('click', () => open(currentPath));

      const body = el('div', { class: 'browser' },
        el('div', { class: 'row' }, up, refresh, el('span', { class: 'spacer' }), info),
        crumbs,
        listing,
      );
      openModal({ title: '浏览：' + (row.name || ''), body, wide: true, actions: [{ label: '关闭' }] });
      open('/');
    }

    const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '新建挂载');
    addBtn.addEventListener('click', () => openEditor(null));
    const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
    reloadBtn.addEventListener('click', () => load());

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('span', null, '存储挂载'),
        statusText,
        el('span', { class: 'spacer' }),
        reloadBtn,
        addBtn,
      ),
      tableHost,
    ));

    await load();
    return () => { disposed = true; };
  },
};
