// 概览页：系统指标、模块开关、最近日志。
import {
  el, toast, confirmDialog, renderTable, fmtBytes, fmtTime, fmtDuration, clear,
} from '../lib/ui.js';

const REFRESH_MS = 5000;
const LOG_LIMIT = 10;

function levelClass(level) {
  const value = String(level || '').toLowerCase();
  if (value.startsWith('err') || value === 'error' || value === 'fatal') return 'level-error';
  if (value.startsWith('warn')) return 'level-warn';
  if (value.startsWith('deb')) return 'level-debug';
  return 'level-info';
}

function normalizeLog(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { time: null, level: 'info', msg: entry, attrs: null };
  if (typeof entry !== 'object') return { time: null, level: 'info', msg: String(entry), attrs: null };
  const attrs = entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null;
  const extra = typeof entry.data === 'object' && entry.data !== null ? entry.data : null;
  return {
    time: entry.time || entry.timestamp || (extra && extra.time) || null,
    level: entry.level || entry.lvl || 'info',
    msg: String(entry.msg || entry.message || (extra && (extra.msg || extra.message)) || ''),
    attrs,
  };
}

function logLine(entry) {
  const item = normalizeLog(entry);
  if (!item) return null;
  const node = el('div', { class: 'log-line ' + levelClass(item.level) },
    el('span', { class: 'ts' }, fmtTime(item.time)),
    el('span', { class: 'lv' }, item.level || 'info'),
    el('span', { class: 'msg' }, item.msg),
  );
  if (item.attrs) {
    const parts = [];
    for (const key of Object.keys(item.attrs)) {
      const value = item.attrs[key];
      let text;
      if (value === null || value === undefined) text = '';
      else if (typeof value === 'object') {
        try { text = JSON.stringify(value); } catch (err) { text = String(value); }
      } else text = String(value);
      parts.push(key + '=' + text);
    }
    if (parts.length) node.querySelector('.msg').appendChild(el('span', { class: 'attrs' }, '  ' + parts.join('  ')));
  }
  return node;
}

function bar(pct) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const kind = value >= 90 ? ' err' : value >= 75 ? ' warn' : '';
  return el('div', { class: 'bar' + kind }, el('i', { style: { width: value + '%' } }));
}

function metricCard(label, value, sub, extra) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-body' },
      el('div', { class: 'metric' },
        el('div', { class: 'metric-head' },
          el('span', { class: 'metric-label' }, label),
          el('span', { class: 'metric-value' }, value),
        ),
        extra || null,
        sub ? el('div', { class: 'metric-sub' }, sub) : null,
      ),
    ),
  );
}

function moduleCard(mod, ctx, refresh) {
  const name = String(mod.name || '');
  const running = !!mod.running;
  const badge = el('span', { class: 'badge ' + (running ? 'ok' : (mod.error ? 'err' : '')) }, running ? '运行中' : (mod.error ? '异常' : '已停止'));
  const actions = el('div', { class: 'module-actions' });

  const act = async (action, label, button) => {
    if (action === 'stop' && !(await confirmDialog('确定要停止模块「' + (mod.title || name) + '」吗？'))) return;
    button.disabled = true;
    try {
      await ctx.api.post('/api/v1/modules/' + encodeURIComponent(name) + '/' + action, {});
      toast((mod.title || name) + ' 已' + label, 'ok');
      await refresh();
    } catch (err) {
      toast(err && err.message ? err.message : '操作失败', 'err');
    } finally {
      button.disabled = false;
    }
  };

  const mk = (action, label, kind) => {
    const button = el('button', { class: 'btn btn-sm' + (kind ? ' ' + kind : ''), type: 'button' }, label);
    button.addEventListener('click', () => act(action, label, button));
    return button;
  };

  if (running) {
    actions.appendChild(mk('restart', '重启'));
    actions.appendChild(mk('stop', '停止', 'btn-danger'));
  } else {
    actions.appendChild(mk('start', '启动', 'btn-primary'));
  }

  const stats = mod.stats && typeof mod.stats === 'object' ? mod.stats : null;
  const detail = mod.detail || '';
  let statsText = '';
  if (stats) {
    const parts = [];
    for (const key of Object.keys(stats).slice(0, 4)) {
      const value = stats[key];
      if (value === null || value === undefined || typeof value === 'object') continue;
      parts.push(key + ': ' + value);
    }
    statsText = parts.join('  ·  ');
  }

  return el('div', { class: 'card' },
    el('div', { class: 'card-body' },
      el('div', { class: 'module-card' },
        el('div', { class: 'module-head' },
          el('span', { class: 'name' }, String(mod.title || name || '未知模块')),
          badge,
        ),
        el('div', { class: 'module-detail' }, detail || statsText || ''),
        mod.error ? el('div', { class: 'module-err' }, String(mod.error)) : null,
        actions,
      ),
    ),
  );
}

export default {
  id: 'dashboard',
  title: '概览',
  async mount(root, ctx) {
    let disposed = false;
    let stats = null;
    let info = null;
    let ddns = null;
    const logs = [];
    const moduleHost = el('div', { class: 'grid' });
    const logHost = el('div', { class: 'log-view', style: { height: 'auto', maxHeight: '320px' } });
    let timer = null;

    const metricsHost = el('div', { class: 'grid' });

    function renderMetrics() {
      clear(metricsHost);
      const s = stats || {};
      const host = s.host || null;

      metricsHost.appendChild(metricCard('CPU', s.numCpu ? String(s.numCpu) + ' 核' : '—',
        s.goroutines !== undefined ? '协程 ' + s.goroutines + ' 个' : ''));

      const heap = Number(s.heapBytes) || 0;
      const sys = Number(s.sysBytes) || 0;
      metricsHost.appendChild(metricCard('Go 内存', fmtBytes(heap),
        sys ? '系统保留 ' + fmtBytes(sys) : '', heap && sys ? bar((heap / sys) * 100) : null));

      if (host && host.memTotalBytes) {
        const pct = Number(host.memUsedPct) || ((1 - (Number(host.memFreeBytes) || 0) / host.memTotalBytes) * 100);
        metricsHost.appendChild(metricCard('主机内存', pct.toFixed(1) + '%',
          '已用 ' + fmtBytes(host.memTotalBytes - (Number(host.memFreeBytes) || 0)) + ' / 共 ' + fmtBytes(host.memTotalBytes),
          bar(pct)));
      } else {
        metricsHost.appendChild(metricCard('主机内存', '—', '当前平台未提供'));
      }

      if (host && host.diskTotalBytes) {
        const used = host.diskTotalBytes - (Number(host.diskFreeBytes) || 0);
        const pct = (used / host.diskTotalBytes) * 100;
        metricsHost.appendChild(metricCard('磁盘', pct.toFixed(1) + '%',
          '可用 ' + fmtBytes(host.diskFreeBytes) + ' / 共 ' + fmtBytes(host.diskTotalBytes) + (host.diskPath ? '（' + host.diskPath + '）' : ''),
          bar(pct)));
      } else {
        metricsHost.appendChild(metricCard('磁盘', '—', '当前平台未提供'));
      }

      const load = host && (host.load1 !== undefined && host.load1 !== null)
        ? Number(host.load1).toFixed(2) + ' / ' + Number(host.load5 || 0).toFixed(2) + ' / ' + Number(host.load15 || 0).toFixed(2)
        : '—';
      metricsHost.appendChild(metricCard('系统负载', load, '1 / 5 / 15 分钟'));

      metricsHost.appendChild(metricCard('运行时长', fmtDuration(s.uptimeSec),
        info && info.startedAt ? '启动于 ' + fmtTime(info.startedAt) : ''));

      const version = info && info.version ? info.version : '—';
      metricsHost.appendChild(metricCard('版本', version,
        [info && info.commit ? '提交 ' + String(info.commit).slice(0, 10) : '', s.hostname || '', s.os && s.arch ? s.os + '/' + s.arch : '']
          .filter(Boolean).join('  ·  ')));
    }

    function renderModules() {
      clear(moduleHost);
      const list = Array.isArray(ctx.state.modules) ? ctx.state.modules : [];
      if (!list.length) {
        moduleHost.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-title' }, '暂无模块信息')));
        return;
      }
      for (const mod of list) moduleHost.appendChild(moduleCard(mod, ctx, loadModules));
    }

    function renderLogs() {
      clear(logHost);
      if (!logs.length) {
        logHost.appendChild(el('div', { class: 'muted', style: { padding: '8px' } }, '暂无日志'));
        return;
      }
      for (const entry of logs.slice(-LOG_LIMIT)) {
        const line = logLine(entry);
        if (line) logHost.appendChild(line);
      }
      logHost.scrollTop = logHost.scrollHeight;
    }

    function pushLog(entry) {
      logs.push(entry);
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      if (disposed) return;
      const line = logLine(entry);
      if (!line) return;
      const empty = logHost.querySelector('.muted');
      if (empty) empty.remove();
      logHost.appendChild(line);
      while (logHost.childElementCount > LOG_LIMIT) logHost.removeChild(logHost.firstChild);
      logHost.scrollTop = logHost.scrollHeight;
    }

    async function loadStats() {
      try {
        const data = await ctx.api.get('/api/v1/system/stats');
        if (disposed) return;
        stats = data || {};
        renderMetrics();
      } catch (err) {
        if (disposed) return;
        if (!stats) {
          clear(metricsHost);
          metricsHost.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-title' }, '无法获取系统统计'), el('div', { class: 'muted' }, err.message || '')));
        }
      }
    }

    async function loadInfo() {
      try {
        const data = await ctx.api.get('/api/v1/system/info');
        if (disposed) return;
        info = data || {};
        ctx.state.info = info;
        renderMetrics();
      } catch (err) {
        if (disposed) return;
        info = info || {};
      }
    }

    async function loadModules() {
      try {
        const data = await ctx.api.get('/api/v1/modules');
        if (disposed) return;
        ctx.state.modules = Array.isArray(data) ? data : [];
        ctx.state.modulesError = null;
        renderModules();
      } catch (err) {
        if (disposed) return;
        ctx.state.modulesError = err;
        clear(moduleHost);
        moduleHost.appendChild(el('div', { class: 'empty' },
          el('div', { class: 'empty-title' }, '无法获取模块状态'),
          el('div', { class: 'muted' }, err.message || ''),
        ));
      }
    }

    async function loadDDNS() {
      try {
        const data = await ctx.api.get('/api/v1/ddns/status');
        clear(ddnsHost);
        if (data === null || data === undefined) {
          ddnsHost.appendChild(el('span', { class: 'badge' }, '无数据'));
          return;
        }
        const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : [data]);
        ddns = items;
        let ok = 0;
        let err = 0;
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          if (item.error || item.lastError) err += 1;
          else if (item.ip || item.currentIp || item.ok || item.enable || item.enabled) ok += 1;
        }
        ddnsHost.appendChild(el('span', { class: 'badge ' + (err ? 'err' : 'ok') }, err ? err + ' 个异常 / 共 ' + items.length : items.length + ' 条规则'));
        const detail = [];
        for (const item of items.slice(0, 6)) {
          if (!item || typeof item !== 'object') continue;
          const name = item.name || item.domain || item.id || '规则';
          const value = item.ip || item.currentIp || item.value || '';
          detail.push(String(name) + (value ? ': ' + value : ''));
        }
        if (detail.length) ddnsHost.appendChild(el('span', { class: 'muted mono' }, detail.join('   ')));
      } catch (err) {
        clear(ddnsHost);
        ddnsHost.appendChild(el('span', { class: 'badge warn' }, '接口不可用'));
        ddnsHost.appendChild(el('span', { class: 'muted' }, err.message || ''));
      }
    }

    const ddnsHost = el('div', { class: 'row' }, el('span', { class: 'badge' }, '加载中…'));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('span', null, '系统指标'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'sub' }, '每 5 秒自动刷新'),
        el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => refreshAll() } }, '立即刷新'),
      ),
      el('div', { class: 'card-body' }, metricsHost),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('span', null, '动态域名'), el('span', { class: 'spacer' }), el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => { ctx.navigate('ddns'); } } }, '管理规则')),
      el('div', { class: 'card-body' }, ddnsHost),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('span', null, '模块状态'), el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => loadModules() } }, '刷新')),
      el('div', { class: 'card-body' }, moduleHost),
    ));

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('span', null, '最近日志'), el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-sm', type: 'button', on: { click: () => ctx.navigate('logs') } }, '查看全部')),
      el('div', { class: 'card-body tight' }, logHost),
    ));

    const off = ctx.onSSE((payload) => {
      if (!payload || disposed) return;
      if (payload.type === 'log') {
        pushLog(payload.data);
      } else if (payload.type === 'status' || payload.type === 'modules' || payload.type === 'module') {
        loadModules();
        loadStats();
      }
    });

    async function refreshAll() {
      await Promise.all([loadStats(), loadInfo(), loadModules(), loadDDNS()]);
    }

    renderMetrics();
    renderModules();
    renderLogs();
    await refreshAll();
    try {
      const data = await ctx.api.get('/api/v1/system/logs', { limit: 20 });
      if (disposed) return;
      const entries = data && Array.isArray(data.entries) ? data.entries : [];
      logs.length = 0;
      for (const entry of entries) logs.push(entry);
      renderLogs();
    } catch (err) {
      /* 概览页其余部分不受影响 */
    }
    timer = setInterval(() => {
      if (!document.hidden && !disposed) refreshAll();
    }, REFRESH_MS);

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      off();
    };
  },
};
