package filebrowser

// pageConfigPlaceholder is replaced with the JSON page configuration when the
// page is rendered.
const pageConfigPlaceholder = "/*__FB_CONFIG__*/"

// pageHTML is the whole user interface of a file browser site. It is a single
// document with inline CSS and JavaScript on purpose: the site must work
// without any external asset and without a build step.
const pageHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>文件管理</title>
<style>
:root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1c1f23; --muted:#6b7280; --card:#ffffff; --line:#e3e6ea; --accent:#2f6feb; --danger:#c2372c; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181c; --fg:#e6e8eb; --muted:#9aa1aa; --card:#1e2126; --line:#2c3037; --accent:#6ea8fe; --danger:#f0776c; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
header.top { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding:14px 20px; background:var(--card); border-bottom:1px solid var(--line); }
header.top .title { font-size:16px; font-weight:600; }
.tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.tools input[type=search] { padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; min-width:180px; }
button, .link { font:inherit; cursor:pointer; }
button { padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:inherit; }
button:hover { border-color:var(--accent); color:var(--accent); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.link { border:0; background:none; padding:2px 6px; color:var(--accent); }
button.link.danger { color:var(--danger); }
.crumbs { padding:10px 20px; display:flex; gap:4px; flex-wrap:wrap; align-items:center; color:var(--muted); }
.crumbs a { color:var(--accent); text-decoration:none; }
.crumbs .pill { background:var(--accent); color:#fff; border-radius:10px; padding:1px 8px; font-size:12px; margin-right:6px; }
.dropzone { margin:12px 20px; padding:14px; border:2px dashed var(--line); border-radius:10px; text-align:center; color:var(--muted); }
.dropzone.over { border-color:var(--accent); color:var(--accent); }
.bulk { margin:0 20px 10px; padding:8px 12px; background:var(--card); border:1px solid var(--line); border-radius:8px; display:flex; gap:10px; align-items:center; }
table { width:100%; border-collapse:collapse; background:var(--card); border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
th, td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--line); }
th { font-weight:600; color:var(--muted); cursor:pointer; user-select:none; white-space:nowrap; }
td.num { white-space:nowrap; color:var(--muted); text-align:right; }
td.sel, th.sel { width:36px; text-align:center; cursor:default; }
tr:hover td { background:rgba(127,127,127,.07); }
td.name { display:flex; align-items:center; gap:8px; }
td.name a { color:inherit; text-decoration:none; }
td.name a:hover { color:var(--accent); text-decoration:underline; }
.ico { display:inline-flex; width:20px; height:20px; color:var(--muted); }
.ico svg { width:20px; height:20px; }
.ico.dir { color:#e0a33e; }
.ico.image { color:#3fa66b; } .ico.video { color:#8b5cf6; } .ico.audio { color:#e0679a; }
.ico.archive { color:#c98a2e; } .ico.code { color:#2f6feb; } .ico.pdf { color:#c2372c; } .ico.doc { color:#1f7a8c; }
td.ops { white-space:nowrap; text-align:right; }
td.empty { text-align:center; color:var(--muted); padding:28px; }
.pager { display:flex; gap:10px; align-items:center; padding:12px 20px; color:var(--muted); }
.pager select { padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; }
.uploads { position:fixed; right:16px; bottom:16px; width:300px; display:flex; flex-direction:column; gap:8px; }
.upload { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:12px; box-shadow:0 4px 14px rgba(0,0,0,.12); }
.upload .uname { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.upload .bar { height:4px; background:var(--line); border-radius:3px; margin:6px 0 2px; overflow:hidden; }
.upload .bar i { display:block; height:100%; width:0; background:var(--accent); transition:width .15s; }
.upload .ustat { color:var(--muted); }
#toast { position:fixed; left:16px; bottom:16px; display:flex; flex-direction:column; gap:8px; z-index:40; }
.toast { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:6px; padding:8px 12px; box-shadow:0 4px 14px rgba(0,0,0,.12); max-width:420px; }
.toast.error { border-left-color:var(--danger); }
.toast.ok { border-left-color:#3fa66b; }
.overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:50; }
.dialog { background:var(--card); border-radius:10px; padding:18px; width:min(420px,92vw); display:flex; flex-direction:column; gap:10px; }
.dialog h3 { margin:0; }
.dialog label { display:flex; flex-direction:column; gap:4px; color:var(--muted); }
.dialog label.row { flex-direction:row; align-items:center; gap:8px; }
.dialog input { padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; }
.dialog .hint { margin:0; color:var(--muted); font-size:12px; }
.dialog .actions { display:flex; justify-content:flex-end; gap:8px; }
#share-result { display:flex; gap:6px; }
#share-url { flex:1; }
</style>
</head>
<body>
<header class="top">
  <div class="title" id="title">文件管理</div>
  <div class="tools">
    <input id="q" type="search" placeholder="搜索当前目录">
    <button id="btn-upload" hidden>上传</button>
    <button id="btn-mkdir" hidden>新建文件夹</button>
    <button id="btn-refresh">刷新</button>
  </div>
</header>
<nav class="crumbs" id="crumbs"></nav>
<div class="dropzone" id="drop" hidden>把文件拖到这里上传</div>
<div class="bulk" id="bulk" hidden>
  <span id="bulk-count"></span>
  <button id="btn-download">下载所选</button>
  <button id="btn-delete">删除所选</button>
  <button id="btn-clear">取消选择</button>
</div>
<table>
  <thead>
    <tr>
      <th class="sel"><input type="checkbox" id="sel-all"></th>
      <th data-sort="name">名称</th>
      <th data-sort="size">大小</th>
      <th data-sort="time">修改时间</th>
      <th></th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<div class="pager" id="pager"></div>
<div class="uploads" id="uploads"></div>
<div id="toast"></div>
<input type="file" id="file-input" multiple hidden>
<script>window.__FB = /*__FB_CONFIG__*/;</script>
<script>
(function () {
  'use strict';
  var CFG = window.__FB || {};
  var API = CFG.api || '/_api';
  var can = CFG.can || {};
  var root = CFG.root || '/';
  var state = { path: CFG.start || root, page: 1, size: 200, sort: 'name', order: 'asc', q: '', data: null, sel: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n = n / 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n >= 10 ? 0 : 1) + ' ' + u[i];
  }
  function fmtTime(t) {
    if (!t) return '-';
    var d = new Date(t);
    if (isNaN(d.getTime())) return '-';
    function p(x) { return x < 10 ? '0' + x : '' + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function toast(msg, kind) {
    var box = document.getElementById('toast');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }
  function api(path, options) {
    var opts = options || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error && data.error.message) || ('请求失败 (' + res.status + ')');
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function withinRoot(p) {
    if (root === '/' || !root) return true;
    return p === root || p.indexOf(root + '/') === 0;
  }
  var ICONS = {
    dir: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    video: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-3v10l-4-3z"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    archive: '<path d="M4 4h16v6H4z"/><path d="M5 10h14v10H5z"/><path d="M12 4v6"/>',
    code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
    text: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 9h7M9 13h7M9 17h4"/>'
  };
  function icon(kind) {
    var p = ICONS[kind] || ICONS.file;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }
  function crumbs(p) {
    var parts = p.split('/').filter(Boolean);
    var out = ['<a href="#" data-nav="/">' + esc(CFG.title || '根目录') + '</a>'];
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc += '/' + parts[i];
      out.push('<span class="sep">/</span>');
      out.push('<a href="#" data-nav="' + esc(acc) + '">' + esc(parts[i]) + '</a>');
    }
    return out.join('');
  }
  function render() {
    var d = state.data;
    if (!d) return;
    document.getElementById('title').textContent = CFG.title || '文件管理';
    document.title = (CFG.title || '文件管理') + ' - ' + (d.path || '/');
    var cr = crumbs(d.path);
    if (CFG.mode === 'share') cr = '<span class="pill">分享</span>' + cr;
    document.getElementById('crumbs').innerHTML = cr;

    var rows = d.entries || [];
    var html = rows.map(function (e) {
      var ops = [];
      if (e.dir) {
        ops.push('<button class="link" data-open="' + esc(e.path) + '">打开</button>');
        if (CFG.download) ops.push('<button class="link" data-zip="' + esc(e.path) + '">打包下载</button>');
      } else if (CFG.download) {
        ops.push('<button class="link" data-dl="' + esc(e.path) + '">下载</button>');
      }
      if (can.rename) ops.push('<button class="link" data-rename="' + esc(e.path) + '" data-name="' + esc(e.name) + '">重命名</button>');
      if (can.delete) ops.push('<button class="link danger" data-del="' + esc(e.path) + '">删除</button>');
      if (CFG.shareEnabled) ops.push('<button class="link" data-share="' + esc(e.path) + '">分享</button>');
      return '<tr>' +
        '<td class="sel"><input type="checkbox" data-sel="' + esc(e.path) + '"' + (state.sel[e.path] ? ' checked' : '') + '></td>' +
        '<td class="name"><span class="ico ' + esc(e.kind) + '">' + icon(e.kind) + '</span>' +
        (e.dir ? '<a href="#" data-open="' + esc(e.path) + '">' + esc(e.name) + '</a>' : '<span>' + esc(e.name) + '</span>') + '</td>' +
        '<td class="num">' + (e.dir ? '-' : fmtSize(e.size)) + '</td>' +
        '<td class="num">' + fmtTime(e.modTime) + '</td>' +
        '<td class="ops">' + ops.join('') + '</td>' +
        '</tr>';
    }).join('');
    if (!html) html = '<tr><td colspan="5" class="empty">' + (state.q ? '没有匹配的文件' : '空目录') + '</td></tr>';
    document.getElementById('rows').innerHTML = html;

    var total = d.total || 0, pages = d.pages || 1, page = d.page || 1;
    document.getElementById('pager').innerHTML =
      '<button class="link" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + page + ' / ' + pages + ' 页，共 ' + total + ' 项</span>' +
      '<button class="link" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
      '<select id="page-size">' +
      [50, 200, 500, 1000].map(function (n) { return '<option value="' + n + '"' + (n === state.size ? ' selected' : '') + '>' + n + ' 条/页</option>'; }).join('') +
      '</select>';

    var selCount = Object.keys(state.sel).length;
    var bulk = document.getElementById('bulk');
    bulk.hidden = selCount === 0;
    document.getElementById('bulk-count').textContent = '已选择 ' + selCount + ' 项';
  }
  function load(p, keepPage) {
    if (p !== undefined && p !== null) state.path = p;
    if (!withinRoot(state.path)) state.path = root;
    if (!keepPage) state.page = 1;
    var qs = new URLSearchParams();
    qs.set('path', state.path);
    qs.set('page', String(state.page));
    qs.set('size', String(state.size));
    qs.set('sort', state.sort);
    qs.set('order', state.order);
    if (state.q) qs.set('q', state.q);
    return api('/list?' + qs.toString()).then(function (data) {
      state.data = data;
      state.path = data.path;
      state.page = data.page;
      state.sel = {};
      render();
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  function download(path) {
    var a = document.createElement('a');
    a.href = API + '/download?path=' + encodeURIComponent(path);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function zipDir(path) {
    window.location.href = API + '/zip?path=' + encodeURIComponent(path);
  }
  function removePaths(paths) {
    if (!paths.length) return;
    if (!window.confirm('确定删除选中的 ' + paths.length + ' 项吗？目录会连同内容一起删除。')) return;
    api('/delete', { method: 'POST', body: { paths: paths } }).then(function (res) {
      var failed = (res && res.failed) || [];
      if (failed.length) toast('部分删除失败：' + failed.map(function (f) { return f.name + ' ' + f.error; }).join('；'), 'error');
      else toast('已删除 ' + paths.length + ' 项', 'ok');
      load(state.path, true);
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  function mkdir() {
    var name = window.prompt('新建文件夹名称');
    if (!name) return;
    api('/mkdir', { method: 'POST', body: { path: state.path, name: name } })
      .then(function () { toast('已创建 ' + name, 'ok'); load(state.path, true); })
      .catch(function (err) { toast(err.message, 'error'); });
  }
  function rename(path, current) {
    var name = window.prompt('重命名为', current);
    if (!name || name === current) return;
    api('/rename', { method: 'POST', body: { path: path, name: name } })
      .then(function () { toast('已重命名', 'ok'); load(state.path, true); })
      .catch(function (err) { toast(err.message, 'error'); });
  }
  function openShareDialog(path) {
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML =
      '<div class="dialog"><h3>创建分享链接</h3>' +
      '<label>有效期（分钟）<input id="share-ttl" type="number" min="1" value="' + (CFG.shareTtlMinutes || 1440) + '"></label>' +
      '<label class="row"><input id="share-dl" type="checkbox" checked> 允许下载</label>' +
      '<p class="hint">链接创建后无需登录即可浏览该路径。</p>' +
      '<div class="actions"><button id="share-cancel">取消</button><button id="share-ok" class="primary">创建</button></div>' +
      '<div id="share-result" hidden><input id="share-url" readonly><button id="share-copy">复制</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.getElementById('share-cancel').onclick = close;
    document.getElementById('share-ok').onclick = function () {
      api('/share', {
        method: 'POST',
        body: {
          path: path,
          ttlMinutes: parseInt(document.getElementById('share-ttl').value, 10) || 0,
          allowDownload: document.getElementById('share-dl').checked
        }
      }).then(function (share) {
        var url = new URL(share.url || ('/_share/' + share.token), window.location.origin).href;
        var box = document.getElementById('share-result');
        box.hidden = false;
        document.getElementById('share-url').value = url;
        document.getElementById('share-copy').onclick = function () {
          var input = document.getElementById('share-url');
          input.select();
          try { document.execCommand('copy'); toast('链接已复制', 'ok'); } catch (e) { toast('请手动复制', 'info'); }
        };
      }).catch(function (err) { toast(err.message, 'error'); });
    };
  }
  function uploadRow(name) {
    var box = document.getElementById('uploads');
    var el = document.createElement('div');
    el.className = 'upload';
    el.innerHTML = '<span class="uname">' + esc(name) + '</span><div class="bar"><i></i></div><span class="ustat">等待</span>';
    box.appendChild(el);
    return el;
  }
  function uploadOne(file, confirmOverwrite) {
    var row = uploadRow(file.name);
    var bar = row.querySelector('i');
    var stat = row.querySelector('.ustat');
    var fd = new FormData();
    fd.append('file', file, file.name);
    var url = API + '/upload?path=' + encodeURIComponent(state.path) + (confirmOverwrite ? '&confirm=1' : '');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round(e.loaded * 100 / e.total);
      bar.style.width = pct + '%';
      stat.textContent = pct + '%';
    };
    xhr.onerror = function () { stat.textContent = '网络错误'; toast(file.name + ' 上传失败', 'error'); };
    xhr.onload = function () {
      var res = null;
      try { res = JSON.parse(xhr.responseText); } catch (e) { res = null; }
      var failed = (res && res.failed) || [];
      var savedOk = res && res.saved && res.saved.length > 0;
      if (xhr.status >= 200 && xhr.status < 300 && savedOk) {
        stat.textContent = '完成';
        bar.style.width = '100%';
        setTimeout(function () { row.remove(); }, 2500);
        load(state.path, true);
        return;
      }
      var item = failed.filter(function (f) { return f.name === file.name; })[0] || failed[0];
      if (item && item.code === 'exists' && !confirmOverwrite) {
        stat.textContent = '已存在';
        row.remove();
        if (window.confirm(file.name + ' 已存在，是否覆盖？')) uploadOne(file, true);
        return;
      }
      stat.textContent = (item && item.error) || '失败';
      toast(file.name + '：' + ((item && item.error) || '上传失败'), 'error');
    };
    stat.textContent = '上传中';
    xhr.send(fd);
  }
  function uploadFiles(files) {
    if (!can.upload) { toast('当前站点不允许上传', 'error'); return; }
    for (var i = 0; i < files.length; i++) uploadOne(files[i], false);
  }
  function bind() {
    document.getElementById('crumbs').addEventListener('click', function (e) {
      var a = e.target.closest('[data-nav]');
      if (!a) return;
      e.preventDefault();
      load(a.getAttribute('data-nav'));
    });
    document.getElementById('rows').addEventListener('click', function (e) {
      var t = e.target.closest('button, a');
      if (!t) return;
      if (t.hasAttribute('data-open')) { e.preventDefault(); load(t.getAttribute('data-open')); return; }
      if (t.hasAttribute('data-dl')) { download(t.getAttribute('data-dl')); return; }
      if (t.hasAttribute('data-zip')) { zipDir(t.getAttribute('data-zip')); return; }
      if (t.hasAttribute('data-rename')) { rename(t.getAttribute('data-rename'), t.getAttribute('data-name')); return; }
      if (t.hasAttribute('data-del')) { removePaths([t.getAttribute('data-del')]); return; }
      if (t.hasAttribute('data-share')) { openShareDialog(t.getAttribute('data-share')); return; }
    });
    document.getElementById('rows').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-sel]');
      if (!cb) return;
      var p = cb.getAttribute('data-sel');
      if (cb.checked) state.sel[p] = true; else delete state.sel[p];
      render();
    });
    document.getElementById('sel-all').addEventListener('change', function (e) {
      var on = e.target.checked;
      state.sel = {};
      if (on) (state.data.entries || []).forEach(function (x) { state.sel[x.path] = true; });
      render();
    });
    document.getElementById('btn-delete').onclick = function () { removePaths(Object.keys(state.sel)); };
    document.getElementById('btn-download').onclick = function () {
      var paths = Object.keys(state.sel);
      if (paths.length === 1) download(paths[0]);
      else toast('请一次选择一个文件下载，或对目录使用打包下载', 'info');
    };
    document.getElementById('btn-clear').onclick = function () { state.sel = {}; render(); };
    var q = document.getElementById('q');
    var timer = null;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = q.value.trim(); load(state.path); }, 280);
    });
    document.getElementById('btn-refresh').onclick = function () { load(state.path, true); };
    var mk = document.getElementById('btn-mkdir');
    if (mk) mk.onclick = mkdir;
    var up = document.getElementById('btn-upload');
    var input = document.getElementById('file-input');
    if (up) up.onclick = function () { input.click(); };
    input.addEventListener('change', function () { uploadFiles(input.files); input.value = ''; });
    document.getElementById('pager').addEventListener('click', function (e) {
      var b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      state.page = parseInt(b.getAttribute('data-page'), 10) || 1;
      load(state.path, true);
    });
    document.getElementById('pager').addEventListener('change', function (e) {
      if (e.target.id !== 'page-size') return;
      state.size = parseInt(e.target.value, 10) || 200;
      load(state.path);
    });
    var heads = document.querySelectorAll('th[data-sort]');
    for (var i = 0; i < heads.length; i++) {
      (function (th) {
        th.addEventListener('click', function () {
          var key = th.getAttribute('data-sort');
          if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
          else { state.sort = key; state.order = 'asc'; }
          load(state.path, true);
        });
      })(heads[i]);
    }
    var dz = document.getElementById('drop');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
      });
      dz.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
      });
      document.addEventListener('dragover', function (e) { e.preventDefault(); });
      document.addEventListener('drop', function (e) { e.preventDefault(); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { var o = document.querySelector('.overlay'); if (o) o.remove(); }
    });
    if (can.upload) {
      input.removeAttribute('disabled');
      if (up) up.hidden = false;
      if (dz) dz.hidden = false;
    }
  }
  bind();
  load(CFG.start || root);
})();
</script>
</body>
</html>
`
