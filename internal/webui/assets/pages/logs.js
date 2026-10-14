// 日志页：历史日志 + SSE 实时追加，支持级别过滤、关键字搜索、自动滚动、导出。
import { el, toast, fmtTime, downloadText, clear } from '../lib/ui.js';

const MAX_LINES = 3000;
const LEVELS = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

function normalizeLog(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { time: null, level: 'info', msg: entry, attrs: null };
  if (typeof entry !== 'object') return { time: null, level: 'info', msg: String(entry), attrs: null };
  const attrs = entry.attrs && typeof entry.attrs === 'object' ? entry.attrs : null;
  return {
    time: entry.time || entry.timestamp || null,
    level: String(entry.level || entry.lvl || 'info').toLowerCase(),
    msg: String(entry.msg || entry.message || ''),
    attrs,
  };
}

function attrsText(attrs) {
  if (!attrs) return '';
  const parts = [];
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    let text;
    if (value === null || value === undefined) text = '';
    else if (typeof value === 'object') {
      try { text = JSON.stringify(value); } catch (err) { text = String(value); }
    } else text = String(value);
    parts.push(key + '=' + text);
  }
  return parts.length ? '  ' + parts.join('  ') : '';
}

function levelClass(level) {
  const value = String(level || '').toLowerCase();
  if (value.startsWith('err') || value === 'fatal') return 'level-error';
  if (value.startsWith('warn')) return 'level-warn';
  if (value.startsWith('deb')) return 'level-debug';
  return 'level-info';
}

function lineText(item) {
  return fmtTime(item.time) + '  ' + String(item.level || 'info').toUpperCase().padEnd(5, ' ') + '  ' + item.msg + attrsText(item.attrs);
}

export default {
  id: 'logs',
  title: '日志',
  async mount(root, ctx) {
    let disposed = false;
    const entries = [];
    let autoScroll = true;
    let follow = true;
    let level = '';
    let keyword = '';
    let rendered = 0;

    const view = el('div', { class: 'log-view' });
    const counter = el('span', { class: 'sub' }, '0 条');
    const levelSelect = el('select', { class: 'select', style: { width: '130px' }, 'aria-label': '日志级别' },
      LEVELS.map((item) => el('option', { value: item.value }, item.label)));
    const searchInput = el('input', { class: 'input', placeholder: '搜索关键字…', style: { width: '200px' }, 'aria-label': '搜索日志' });
    const scrollToggle = el('label', { class: 'switch' },
      el('input', { type: 'checkbox', checked: true }),
      el('span', { class: 'track' }),
      el('span', null, '自动滚动'),
    );
    const followToggle = el('label', { class: 'switch' },
      el('input', { type: 'checkbox', checked: true }),
      el('span', { class: 'track' }),
      el('span', null, '实时跟随'),
    );

    function visibleItems() {
      const min = level ? (LEVEL_RANK[level] || 0) : 0;
      const key = keyword.trim().toLowerCase();
      const out = [];
      for (const item of entries) {
        if (min && (LEVEL_RANK[item.level] || 20) < min) continue;
        if (key) {
          const haystack = (item.msg + ' ' + attrsText(item.attrs)).toLowerCase();
          if (haystack.indexOf(key) < 0) continue;
        }
        out.push(item);
      }
      return out;
    }

    function lineNode(item) {
      const node = el('div', { class: 'log-line ' + levelClass(item.level) },
        el('span', { class: 'ts' }, fmtTime(item.time)),
        el('span', { class: 'lv' }, item.level || 'info'),
        el('span', { class: 'msg' }, item.msg),
      );
      const extra = attrsText(item.attrs);
      if (extra) node.querySelector('.msg').appendChild(el('span', { class: 'attrs' }, extra));
      return node;
    }

    function renderAll() {
      const items = visibleItems();
      clear(view);
      if (!items.length) {
        view.appendChild(el('div', { class: 'muted', style: { padding: '10px' } }, entries.length ? '没有匹配的日志' : '暂无日志'));
      } else {
        const frag = document.createDocumentFragment();
        for (const item of items.slice(-MAX_LINES)) frag.appendChild(lineNode(item));
        view.appendChild(frag);
      }
      rendered = items.length;
      counter.textContent = items.length === entries.length
        ? entries.length + ' 条'
        : items.length + ' / ' + entries.length + ' 条';
      if (autoScroll) view.scrollTop = view.scrollHeight;
    }

    function appendItem(item) {
      entries.push(item);
      if (entries.length > MAX_LINES * 2) entries.splice(0, entries.length - MAX_LINES * 2);
      if (disposed) return;
      const min = level ? (LEVEL_RANK[level] || 0) : 0;
      const key = keyword.trim().toLowerCase();
      if (min && (LEVEL_RANK[item.level] || 20) < min) return;
      if (key && (item.msg + ' ' + attrsText(item.attrs)).toLowerCase().indexOf(key) < 0) return;
      const placeholder = view.querySelector('.muted');
      if (placeholder) placeholder.remove();
      view.appendChild(lineNode(item));
      rendered += 1;
      while (view.childElementCount > MAX_LINES) view.removeChild(view.firstChild);
      counter.textContent = rendered + ' / ' + entries.length + ' 条';
      if (autoScroll) view.scrollTop = view.scrollHeight;
    }

    view.addEventListener('scroll', () => {
      const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
      autoScroll = nearBottom;
      const box = scrollToggle.querySelector('input');
      if (box.checked !== nearBottom) box.checked = nearBottom;
    });

    levelSelect.addEventListener('change', () => {
      level = levelSelect.value;
      renderAll();
    });
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        keyword = searchInput.value;
        renderAll();
      }, 160);
    });
    scrollToggle.querySelector('input').addEventListener('change', (event) => {
      autoScroll = event.target.checked;
      if (autoScroll) view.scrollTop = view.scrollHeight;
    });
    followToggle.querySelector('input').addEventListener('change', (event) => {
      follow = event.target.checked;
    });

    const clearBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '清屏');
    clearBtn.addEventListener('click', () => {
      entries.length = 0;
      rendered = 0;
      renderAll();
      toast('已清空当前视图（不影响服务端日志）');
    });

    const exportBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '导出');
    exportBtn.addEventListener('click', () => {
      const items = visibleItems();
      if (!items.length) {
        toast('没有可导出的日志', 'warn');
        return;
      }
      const text = items.map(lineText).join('\n');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadText('nunt-logs-' + stamp + '.log', text + '\n', 'text/plain;charset=utf-8');
      toast('已导出 ' + items.length + ' 条日志', 'ok');
    });

    const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '重新加载');
    reloadBtn.addEventListener('click', () => load(true));

    const toolbar = el('div', { class: 'toolbar' },
      levelSelect, searchInput, scrollToggle, followToggle,
      el('span', { class: 'spacer' }),
      counter, clearBtn, exportBtn, reloadBtn,
    );

    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('span', null, '运行日志'),
        el('span', { class: 'spacer' }), el('span', { class: 'sub' }, '实时推送 + 服务端缓存')),
      el('div', { class: 'card-body' },
        toolbar,
        view,
      ),
    ));

    async function load(reset) {
      if (reset) {
        entries.length = 0;
        rendered = 0;
      }
      reloadBtn.disabled = true;
      try {
        const data = await ctx.api.get('/api/v1/system/logs', { limit: 500 });
        if (disposed) return;
        const list = data && Array.isArray(data.entries) ? data.entries : [];
        const items = list.map(normalizeLog).filter(Boolean);
        entries.length = 0;
        for (const item of items) entries.push(item);
        if (data && data.level) levelSelect.title = '服务端日志级别：' + data.level;
        renderAll();
      } catch (err) {
        if (!disposed) {
          view.appendChild(el('div', { class: 'muted', style: { padding: '10px' } }, '加载日志失败：' + (err.message || '')));
        }
      } finally {
        reloadBtn.disabled = false;
      }
    }

    const off = ctx.onSSE((payload) => {
      if (disposed || !follow || !payload || payload.type !== 'log') return;
      const item = normalizeLog(payload.data);
      if (item) appendItem(item);
    });

    renderAll();
    await load(true);

    return () => {
      disposed = true;
      if (searchTimer) clearTimeout(searchTimer);
      off();
    };
  },
};
