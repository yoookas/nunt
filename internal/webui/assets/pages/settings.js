// 设置页：系统参数、用户、API Token、在线会话、配置导入导出。
import {
  el, toast, confirmDialog, openModal, renderTable, formGrid, fmtTime, downloadText, clear,
} from '../lib/ui.js';

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

export default {
  id: 'settings',
  title: '设置',
  async mount(root, ctx) {
    let disposed = false;
    let active = 'basic';
    let systemSettings = null;
    const panel = el('div', null);
    const tabBar = el('div', { class: 'tabs' });

    function setTab(id) {
      active = id;
      for (const btn of Array.from(tabBar.querySelectorAll('.tab'))) {
        btn.classList.toggle('active', btn.dataset.tab === id);
      }
      renderPanel();
    }

    for (const tab of TABS) {
      const btn = el('button', { class: 'tab' + (tab.id === active ? ' active' : ''), type: 'button', 'data-tab': tab.id }, tab.label);
      btn.addEventListener('click', () => setTab(tab.id));
      tabBar.appendChild(btn);
    }

    root.appendChild(el('div', { class: 'card' }, el('div', { class: 'card-body' }, tabBar)));
    root.appendChild(panel);

    function loadingCard(text) {
      return el('div', { class: 'card' }, el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', null, text || '加载中…')));
    }

    function errorCard(title, err, retry) {
      return el('div', { class: 'card' }, el('div', { class: 'empty' },
        el('div', { class: 'empty-title' }, title),
        el('div', { class: 'muted' }, err && err.message ? err.message : String(err || '')),
        retry ? el('button', { class: 'btn btn-sm', type: 'button', on: { click: retry } }, '重试') : null,
      ));
    }

    async function renderPanel() {
      clear(panel);
      if (active === 'basic') await renderBasic();
      else if (active === 'users') await renderUsers();
      else if (active === 'tokens') await renderTokens();
      else if (active === 'sessions') await renderSessions();
      else renderConfig();
    }

    /* ---------------------------------------------------------- 基础设置 */

    async function renderBasic() {
      panel.appendChild(loadingCard());
      let data = systemSettings;
      if (!data) {
        try {
          data = await ctx.api.get('/api/v1/system/settings');
          systemSettings = data || {};
        } catch (err) {
          if (disposed) return;
          clear(panel);
          panel.appendChild(errorCard('无法读取系统设置', err, () => { systemSettings = null; renderPanel(); }));
          return;
        }
      }
      if (disposed) return;

      const form = formGrid([
        { name: 'adminListen', label: '管理监听地址', value: data.adminListen || '', placeholder: ':8080 或 127.0.0.1:8080', hint: '修改后需要重启服务才能真正生效' },
        { name: 'baseUrl', label: '外部访问地址', value: data.baseUrl || '', placeholder: 'https://admin.example.com', hint: '用于生成回跳链接，可留空' },
        { name: 'logLevel', label: '日志级别', type: 'select', value: data.logLevel || 'info', options: LOG_LEVELS },
        { name: 'sessionTtlHours', label: '会话有效期（小时）', type: 'number', value: data.sessionTtlHours || 24, min: 1, max: 720 },
        { name: 'loginMaxFail', label: '登录失败次数上限', type: 'number', value: data.loginMaxFail || 5, min: 1, max: 100 },
        { name: 'loginLockMinutes', label: '锁定时长（分钟）', type: 'number', value: data.loginLockMin || 15, min: 1, max: 1440 },
        { name: 'trustProxy', label: '信任反向代理', type: 'switch', value: !!data.trustProxy, text: '使用 X-Forwarded-For 识别客户端 IP' },
        { name: 'checkUpdate', label: '检查更新', type: 'switch', value: data.checkUpdate !== false, text: '启动时检查新版本' },
        { name: 'theme', label: '默认主题', type: 'select', value: data.theme || 'dark', options: THEMES, hint: '仅作为新设备的默认值，本机选择保存在浏览器中' },
        { name: 'adminAllowIps', label: '管理端 IP 白名单', type: 'tags', value: data.adminAllowIps || [], wide: true, placeholder: '留空表示不限制，多个用逗号分隔' },
      ]);
      const error = el('div', { class: 'field error hidden' });
      const save = el('button', { class: 'btn btn-primary', type: 'button' }, '保存设置');
      save.addEventListener('click', async () => {
        error.classList.add('hidden');
        const values = form.read();
        const payload = {
          adminListen: String(values.adminListen || '').trim(),
          adminAllowIps: Array.isArray(values.adminAllowIps) ? values.adminAllowIps : [],
          trustProxy: !!values.trustProxy,
          logLevel: values.logLevel || 'info',
          sessionTtlHours: Number(values.sessionTtlHours) || 24,
          loginMaxFail: Number(values.loginMaxFail) || 5,
          loginLockMinutes: Number(values.loginLockMinutes) || 15,
          theme: values.theme || 'dark',
          checkUpdate: !!values.checkUpdate,
          baseUrl: String(values.baseUrl || '').trim(),
        };
        save.disabled = true;
        try {
          const result = await ctx.api.put('/api/v1/system/settings', payload);
          systemSettings = result || payload;
          ctx.theme.set(payload.theme);
          toast('设置已保存', 'ok');
          await renderBasic();
        } catch (err) {
          error.textContent = err && err.message ? err.message : '保存失败';
          error.classList.remove('hidden');
        } finally {
          save.disabled = false;
        }
      });

      clear(panel);
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('span', null, '系统参数'), el('span', { class: 'spacer' }),
          el('span', { class: 'sub' }, '修改监听地址后请重启服务')),
        el('div', { class: 'card-body' }, form.node, error,
          el('div', { class: 'row' }, save)),
      ));
    }

    /* ---------------------------------------------------------- 用户管理 */

    async function renderUsers() {
      panel.appendChild(loadingCard());
      let users = [];
      try {
        const data = await ctx.api.get('/api/v1/auth/users');
        users = Array.isArray(data) ? data : [];
      } catch (err) {
        if (disposed) return;
        clear(panel);
        panel.appendChild(errorCard('无法读取用户列表', err, () => renderPanel()));
        return;
      }
      if (disposed) return;

      const host = el('div', { class: 'card-body tight' });
      renderTable(host, {
        empty: '暂无用户',
        columns: [
          { title: '用户名', render: (row) => el('span', null, String(row.username || '')) },
          { title: '角色', width: 90, render: (row) => el('span', { class: 'badge' }, String(row.role || 'admin')) },
          {
            title: '状态',
            width: 120,
            render: (row) => [el('span', { class: 'badge ' + (row.enabled ? 'ok' : '') }, row.enabled ? '已启用' : '已停用'),
              row.mustChangePassword ? el('span', { class: 'badge warn' }, '待改密') : null],
          },
          { title: '最近登录', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.lastLogin)) },
          { title: '创建时间', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.createdAt)) },
          {
            title: '操作',
            className: 'actions',
            render: (row) => {
              const edit = el('button', { class: 'btn btn-sm', type: 'button' }, '编辑');
              edit.addEventListener('click', () => openUserEditor(row, users));
              const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '删除');
              del.addEventListener('click', async () => {
                if (!(await confirmDialog('确定要删除用户「' + row.username + '」吗？该用户的会话会立即失效。'))) return;
                try {
                  await ctx.api.del('/api/v1/auth/users/' + encodeURIComponent(row.id));
                  toast('已删除', 'ok');
                  renderPanel();
                } catch (err) {
                  toast(err && err.message ? err.message : '删除失败', 'err');
                }
              });
              return [edit, del];
            },
          },
        ],
        rows: users,
      });

      const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '新建用户');
      addBtn.addEventListener('click', () => openUserEditor(null, users));
      const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
      reloadBtn.addEventListener('click', () => renderPanel());

      clear(panel);
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('span', null, '用户'), el('span', { class: 'spacer' }), reloadBtn, addBtn),
        host,
      ));
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-body muted', style: { fontSize: '13px' } },
          '后端当前创建的账号均为管理员角色；密码修改后该用户的其它会话会立即失效。'),
      ));
    }

    function openUserEditor(row, users) {
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
      const error = el('div', { class: 'field error hidden' });
      const modal = openModal({
        title: isNew ? '新建用户' : '编辑用户：' + row.username,
        body: el('div', null, form.node, error),
        actions: [
          { label: '取消' },
          {
            label: '保存',
            kind: 'primary',
            close: false,
            onClick: async () => {
              error.classList.add('hidden');
              const values = form.read();
              const username = String(values.username || '').trim();
              if (!username) {
                error.textContent = '请填写用户名';
                error.classList.remove('hidden');
                return;
              }
              if (isNew && String(values.password || '').length < 8) {
                error.textContent = '密码至少需要 8 位';
                error.classList.remove('hidden');
                return;
              }
              if (!isNew && values.password && String(values.password).length < 8) {
                error.textContent = '密码至少需要 8 位';
                error.classList.remove('hidden');
                return;
              }
              const payload = { username, password: values.password || '', enabled: !!values.enabled };
              modal.setBusy(true);
              try {
                if (isNew) await ctx.api.post('/api/v1/auth/users', payload);
                else await ctx.api.put('/api/v1/auth/users/' + encodeURIComponent(row.id), payload);
                toast('已保存', 'ok');
                modal.close();
                renderPanel();
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

    /* ---------------------------------------------------------- API Token */

    async function renderTokens() {
      panel.appendChild(loadingCard());
      let tokens = [];
      try {
        const data = await ctx.api.get('/api/v1/auth/tokens');
        tokens = Array.isArray(data) ? data : [];
      } catch (err) {
        if (disposed) return;
        clear(panel);
        panel.appendChild(errorCard('无法读取 Token 列表', err, () => renderPanel()));
        return;
      }
      if (disposed) return;

      const host = el('div', { class: 'card-body tight' });
      renderTable(host, {
        empty: '还没有创建 API Token',
        columns: [
          { title: '名称', render: (row) => el('span', null, String(row.name || '')) },
          {
            title: '权限范围',
            render: (row) => (Array.isArray(row.scopes) && row.scopes.length
              ? el('span', { class: 'row', style: { gap: '4px' } }, row.scopes.map((scope) => el('span', { class: 'chip' }, String(scope))))
              : el('span', { class: 'muted' }, '默认')),
          },
          { title: '状态', width: 90, render: (row) => el('span', { class: 'badge ' + (row.enabled ? 'ok' : '') }, row.enabled ? '有效' : '已停用') },
          { title: '最近使用', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.lastUsed)) },
          { title: '创建时间', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.createdAt)) },
          {
            title: '操作',
            className: 'actions',
            render: (row) => {
              const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '删除');
              del.addEventListener('click', async () => {
                if (!(await confirmDialog('确定要删除 Token「' + row.name + '」吗？使用它的客户端会立即失效。'))) return;
                try {
                  await ctx.api.del('/api/v1/auth/tokens/' + encodeURIComponent(row.id));
                  toast('已删除', 'ok');
                  renderPanel();
                } catch (err) {
                  toast(err && err.message ? err.message : '删除失败', 'err');
                }
              });
              return [del];
            },
          },
        ],
        rows: tokens,
      });

      const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '新建 Token');
      addBtn.addEventListener('click', () => openTokenEditor());
      const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
      reloadBtn.addEventListener('click', () => renderPanel());

      clear(panel);
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('span', null, 'API Token'), el('span', { class: 'spacer' }), reloadBtn, addBtn),
        host,
      ));
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-body muted', style: { fontSize: '13px' } },
          'Token 仅在创建时完整显示一次，请立即复制保存；服务端只保存摘要。'),
      ));
    }

    function openTokenEditor() {
      const form = formGrid([
        { name: 'name', label: '名称', value: '', placeholder: '例如：监控脚本' },
        { name: 'scopes', label: '权限范围', type: 'tags', value: [], placeholder: '留空表示默认权限，多个用逗号分隔' },
      ]);
      const error = el('div', { class: 'field error hidden' });
      const modal = openModal({
        title: '新建 API Token',
        body: el('div', null, form.node, error),
        actions: [
          { label: '取消' },
          {
            label: '创建',
            kind: 'primary',
            close: false,
            onClick: async () => {
              error.classList.add('hidden');
              const values = form.read();
              if (!values.name || !String(values.name).trim()) {
                error.textContent = '请填写名称';
                error.classList.remove('hidden');
                return;
              }
              modal.setBusy(true);
              try {
                const result = await ctx.api.post('/api/v1/auth/tokens', {
                  name: String(values.name).trim(),
                  scopes: Array.isArray(values.scopes) ? values.scopes : [],
                });
                modal.close();
                showTokenOnce(result && result.token ? String(result.token) : '', values.name);
                renderPanel();
              } catch (err) {
                error.textContent = err && err.message ? err.message : '创建失败';
                error.classList.remove('hidden');
              } finally {
                modal.setBusy(false);
              }
            },
          },
        ],
      });
    }

    function showTokenOnce(token, name) {
      const box = el('div', { class: 'token-box' }, token || '（后端未返回令牌）');
      const copy = el('button', { class: 'btn', type: 'button' }, '复制令牌');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(token);
          toast('已复制到剪贴板', 'ok');
        } catch (err) {
          toast('复制失败，请手动选择文本', 'err');
        }
      });
      openModal({
        title: 'Token 已创建：' + name,
        body: el('div', null,
          el('div', { class: 'notice' }, '请立即复制并妥善保存，关闭本窗口后将无法再次查看。'),
          box,
        ),
        actions: [
          { label: '关闭' },
          { spacer: true },
          { label: '复制令牌', kind: 'primary', onClick: () => { copy.click(); return false; } },
        ],
      });
    }

    /* ---------------------------------------------------------- 在线会话 */

    async function renderSessions() {
      panel.appendChild(loadingCard());
      let sessions = [];
      try {
        const data = await ctx.api.get('/api/v1/auth/sessions');
        sessions = Array.isArray(data) ? data : [];
      } catch (err) {
        if (disposed) return;
        clear(panel);
        panel.appendChild(errorCard('无法读取在线会话', err, () => renderPanel()));
        return;
      }
      if (disposed) return;

      const host = el('div', { class: 'card-body tight' });
      renderTable(host, {
        empty: '当前没有其它在线会话',
        columns: [
          { title: '用户', render: (row) => [el('span', null, String(row.username || '')), row.current ? el('span', { class: 'badge ok' }, '当前会话') : null] },
          { title: '来源 IP', render: (row) => el('span', { class: 'mono muted' }, String(row.ip || '')) },
          {
            title: '客户端',
            render: (row) => el('span', { class: 'muted', style: { fontSize: '12px' } }, String(row.userAgent || '').slice(0, 90)),
          },
          { title: '登录时间', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.createdAt)) },
          { title: '过期时间', width: 180, render: (row) => el('span', { class: 'muted' }, fmtTime(row.expiresAt)) },
        ],
        rows: sessions,
      });
      const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '刷新');
      reloadBtn.addEventListener('click', () => renderPanel());
      clear(panel);
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('span', null, '在线会话'), el('span', { class: 'spacer' }), reloadBtn),
        host,
      ));
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-body muted', style: { fontSize: '13px' } },
          '接口只返回当前有效的会话；如需强制下线，可修改该用户密码或重启服务。'),
      ));
    }

    /* ---------------------------------------------------------- 配置导入导出 */

    function renderConfig() {
      const exportBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '导出配置');
      exportBtn.addEventListener('click', () => exportConfig(exportBtn));

      const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
      const importBtn = el('button', { class: 'btn', type: 'button' }, '选择配置文件并导入');
      importBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if (!(await confirmDialog('导入会覆盖当前的系统、Web、转发、动态域名、证书、存储、WAF、任务与通知配置，确定继续吗？', { danger: true, okLabel: '导入' }))) return;
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch (err) {
          toast('文件不是合法的 JSON', 'err');
          return;
        }
        importBtn.disabled = true;
        try {
          await ctx.api.put('/api/v1/system/config', { config: parsed });
          systemSettings = null;
          toast('配置已导入并重新加载', 'ok');
          renderPanel();
        } catch (err) {
          toast(err && err.message ? err.message : '导入失败', 'err');
        } finally {
          importBtn.disabled = false;
        }
      });

      const reloadBtn = el('button', { class: 'btn', type: 'button' }, '重载配置');
      reloadBtn.addEventListener('click', async () => {
        reloadBtn.disabled = true;
        try {
          await ctx.api.post('/api/v1/system/reload', {});
          systemSettings = null;
          toast('已通知各模块重新加载配置', 'ok');
        } catch (err) {
          toast(err && err.message ? err.message : '重载失败', 'err');
        } finally {
          reloadBtn.disabled = false;
        }
      });

      const rawBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '查看当前配置 JSON');
      rawBtn.addEventListener('click', async () => {
        rawBtn.disabled = true;
        try {
          const data = await ctx.api.get('/api/v1/system/config');
          let text;
          try { text = JSON.stringify(data, null, 2); } catch (err) { text = String(data); }
          const pre = el('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0', maxHeight: '60vh', overflow: 'auto' } }, text);
          openModal({
            title: '当前配置（密钥已脱敏）',
            body: pre,
            wide: true,
            actions: [
              { label: '关闭' },
              { spacer: true },
              { label: '复制', kind: 'primary', onClick: async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast('已复制', 'ok');
                } catch (err) {
                  toast('复制失败', 'err');
                }
                return false;
              } },
            ],
          });
        } catch (err) {
          toast(err && err.message ? err.message : '读取失败', 'err');
        } finally {
          rawBtn.disabled = false;
        }
      });

      clear(panel);
      panel.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('span', null, '配置导入导出')),
        el('div', { class: 'card-body' },
          el('p', { class: 'muted' }, '导出的 JSON 中所有密钥以 ******** 呈现；直接回导时这些字段会沿用现有值。'),
          el('div', { class: 'row' }, exportBtn, rawBtn),
          el('hr', { class: 'divider' }),
          el('p', { class: 'muted' }, '导入会替换配置（用户仅在带有密码哈希时被替换），随后自动重载各模块。'),
          el('div', { class: 'row' }, importBtn, fileInput),
          el('hr', { class: 'divider' }),
          el('p', { class: 'muted' }, '修改配置文件后可用“重载配置”让各模块重新读取，无需重启进程。'),
          el('div', { class: 'row' }, reloadBtn),
        ),
      ));
    }

    async function exportConfig(button) {
      button.disabled = true;
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
        toast(err && err.message ? err.message : '导出失败', 'err');
      } finally {
        button.disabled = false;
      }
    }

    await renderPanel();
    return () => { disposed = true; };
  },
};
