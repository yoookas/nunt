#!/usr/bin/env node
/**
 * nunt 前端冒烟（阶段 3 固化版）：浅色主题 axe + 12 页逐页交互。
 *
 * 这个脚本把阶段 1/2 各批散落在 .gocache/tmp 里的临时检查合并成一份可重复运行的检查：
 *   1. 真实二进制 + 无头 Chromium，**浅色主题**（和 ui-baseline 的深色互补）；
 *   2. 浏览器表单登录（真实登录流程）；
 *   3. 12 个页面逐个挂载 + 截图 + axe 四档扫描（wcag2a/2aa/21a/21aa/best-practice）；
 *   4. 每页至少一条关键交互（新建对话框、真实转发日志、未启用规则提示、
 *      密钥类型取值、nunt-tags 字段、请求测试…）；
 *   5. console / 未捕获异常 / 失败请求 / 4xx·5xx / 外部请求 全量统计。
 *
 * 输出：<out>/ui-smoke.json（机器数据）+ <out>/*.png（关键步骤截图）；
 * 任何检查失败或 axe 非 0 时以非零码退出，方便 CI 直接当门禁用。
 *
 * 用法：
 *   node scripts/ui-smoke.mjs [--out .gocache/ui-smoke] [--exe nunt.exe] [--port 16601]
 *                             [--base http://127.0.0.1:16601] [--password xxx]
 *                             [--headed] [--keep-data] [--settle 900]
 *
 * --base 给了就连接已在运行的服务（此时必须给 --password 或用 NUNT_ADMIN_PASSWORD），
 * 否则脚本自己启动二进制并播种演示数据（推荐，CI 用的就是这条路径）。
 *
 * 依赖只用于开发期（playwright + axe-core），Go 构建与 Docker 镜像不需要 Node。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const AXE_SOURCE = await fsp.readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_VERSION = require('axe-core/package.json').version;
const PLAYWRIGHT_VERSION = require('playwright/package.json').version;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
const PAGES = [
  { id: 'dashboard', title: '概览' },
  { id: 'web', title: 'Web 服务' },
  { id: 'forward', title: '端口转发' },
  { id: 'ddns', title: '动态域名' },
  { id: 'acme', title: '证书' },
  { id: 'storage', title: '存储' },
  { id: 'files', title: '文件' },
  { id: 'waf', title: 'WAF' },
  { id: 'task', title: '计划任务' },
  { id: 'notify', title: '通知' },
  { id: 'logs', title: '日志' },
  { id: 'settings', title: '设置' },
];

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    exe: path.join(REPO, 'nunt.exe'),
    // 管理端口的默认值：nunt 默认监听 :16601，脚本自己启动的实例也用这个；
    // 只有当实例被配置成别的地址时才需要 --port（ui-baseline 同理）。
    port: 16601,
    out: path.join(REPO, '.gocache', 'ui-smoke'),
    base: '',
    password: process.env.NUNT_ADMIN_PASSWORD || '',
    dataDir: '',
    keepData: false,
    headed: false,
    settle: 900,
    webPort: 18090,
    forwardPort: 12230,
    echoPort: 12231,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--exe': opts.exe = path.resolve(next()); break;
      case '--port': opts.port = Number(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--base': opts.base = next(); break;
      case '--password': opts.password = next(); break;
      case '--data-dir': opts.dataDir = path.resolve(next()); break;
      case '--settle': opts.settle = Number(next()); break;
      case '--web-port': opts.webPort = Number(next()); break;
      case '--forward-port': opts.forwardPort = Number(next()); break;
      case '--echo-port': opts.echoPort = Number(next()); break;
      case '--keep-data': opts.keepData = true; break;
      case '--headed': opts.headed = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error('未知参数：' + arg);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ 小工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(msg) { process.stdout.write('[smoke] ' + msg + '\n'); }

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (free) => { if (!done) { done = true; socket.destroy(); resolve(free); } };
    socket.setTimeout(800);
    socket.on('connect', () => finish(false));
    socket.on('timeout', () => finish(true));
    socket.on('error', () => finish(true));
  });
}

async function waitFree(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

// spawnServer：Windows 上刚被杀掉的 exe 偶尔会 EBUSY（文件还被映射），重试几次。
async function spawnServer(exe, args, options) {
  for (let i = 0; i < 12; i += 1) {
    try { return spawn(exe, args, options); }
    catch (err) {
      if (err && err.code === 'EBUSY') { await sleep(2500); continue; }
      throw err;
    }
  }
  throw new Error('spawn ' + exe + ' 一直 EBUSY');
}

/* ------------------------------------------------------------------ 管理 API 客户端（播种用） */

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  async function call(method, apiPath, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(base + apiPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length) cookie = setCookie[0].split(';')[0];
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (err) { data = text; } }
    return { status: res.status, ok: res.ok, data };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b === undefined ? {} : b),
    put: (p, b) => call('PUT', p, b === undefined ? {} : b),
    del: (p) => call('DELETE', p),
    setCsrf: (v) => { csrf = v; },
  };
}

/* ------------------------------------------------------------------ 转发目标（本机 TCP 回显服务） */

function startEchoServer(port) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.setEncoding('utf8');
      socket.write('nunt-forward-demo' + String.fromCharCode(10));
      socket.on('data', (chunk) => { socket.write(chunk); });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      close: () => new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
    }));
  });
}

function runForwardProbe(addr, timeoutMs) {
  const parts = String(addr).split(':');
  const host = parts[0] || '127.0.0.1';
  const port = Number(parts[1]);
  return new Promise((resolve) => {
    let received = '';
    let settled = false;
    let quiet = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quiet) clearTimeout(quiet);
      try { socket.destroy(); } catch (err) { /* 忽略 */ }
      resolve(result);
    };
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => finish(received.length
      ? { ok: true, received }
      : { ok: false, error: '连接或回显超时（' + timeoutMs + 'ms）' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => { socket.write('nunt-forward-probe' + String.fromCharCode(10)); });
    // 转发链路不会主动关闭连接（中转是双向长连接），所以收到回显后等一小段静默就判定成功。
    socket.on('data', (chunk) => {
      received += chunk;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish({ ok: true, received }), 300);
    });
    socket.on('error', (err) => finish({ ok: false, error: String((err && err.message) || err) }));
    socket.on('close', () => finish(received.length ? { ok: true, received } : { ok: false, error: '连接被关闭但没有回显' }));
  });
}

/* ------------------------------------------------------------------ 服务器进程 */

async function startServer(opts, dataDir) {
  const tmpDir = path.join(REPO, '.gocache', 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const child = await spawnServer(opts.exe, ['-d', dataDir], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir }),
  });
  const out = { stdout: '', stderr: '' };
  let password = '';
  let exited = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out.stdout += chunk;
    if (!password) {
      const m = /Administrator pass\s*:\s*(\S+)/.exec(out.stdout);
      if (m) password = m[1];
    }
  });
  child.stderr.on('data', (chunk) => { out.stderr += chunk; });
  child.on('exit', (code) => { exited = code; });

  const base = 'http://127.0.0.1:' + opts.port;
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error('nunt 提前退出，exit code = ' + exited + String.fromCharCode(10) + out.stderr + out.stdout);
    if (password) {
      try { const res = await fetch(base + '/healthz'); if (res.ok) { healthy = true; break; } } catch (err) { /* 还没起来 */ }
    }
    await sleep(200);
  }
  if (!password) throw new Error('30 秒内没有从 stdout 抓到初始管理员密码');
  if (!healthy) throw new Error('服务没有在 30 秒内通过 /healthz 健康检查');
  return { child, base, password, out };
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.child || server.child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => {
      try { server.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      resolve();
    }, 5000);
    server.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { server.child.kill(); } catch (e) { clearTimeout(timer); resolve(); }
  });
}

/* ------------------------------------------------------------------ 演示数据 */

const SAMPLE_INDEX = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>nunt 冒烟演示站点</title></head>',
  '<body><h1>nunt 冒烟演示站点</h1><ul><li><a href="about.html">关于</a></li></ul></body></html>',
  '',
].join(String.fromCharCode(10));

const SAMPLE_ABOUT = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>关于</title></head><body><h1>关于</h1></body></html>' + String.fromCharCode(10);

async function prepareSampleSite(dataDir) {
  const www = path.join(dataDir, 'www');
  await fsp.mkdir(path.join(www, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(www, 'index.html'), SAMPLE_INDEX, 'utf8');
  await fsp.writeFile(path.join(www, 'about.html'), SAMPLE_ABOUT, 'utf8');
  return www;
}

async function seedDemoData(client, opts, www) {
  const steps = [];
  async function step(name, method, apiPath, body) {
    let result;
    try { result = await client[method](apiPath, body); }
    catch (err) { result = { status: 0, ok: false, data: null }; }
    steps.push({
      name,
      method: method.toUpperCase(),
      path: apiPath,
      status: result.status,
      ok: !!result.ok,
      error: result.ok ? '' : (result.data && result.data.error ? result.data.error.message : 'HTTP ' + result.status),
      id: result.data && result.data.id ? result.data.id : '',
    });
    return result;
  }

  await step('存储挂载（本地目录）', 'post', '/api/v1/storage/mounts', {
    name: '冒烟演示目录', enable: true, type: 'local', root: www, readOnly: false, remark: '冒烟演示数据',
  });
  await step('Web 规则：静态托管', 'post', '/api/v1/web/rules', {
    name: '冒烟静态站点', enable: true, type: 'static', listen: ['127.0.0.1:' + opts.webPort],
    domains: ['smoke.demo.local'], path: '/', priority: 20, tls: { mode: 'off', hsts: false },
    waf: true, access: { mode: 'off' },
    static: { root: www, index: ['index.html'], listing: true, spa: false, cacheSeconds: 0 },
    remark: '冒烟演示数据',
  });
  await step('Web 规则：反向代理', 'post', '/api/v1/web/rules', {
    name: '冒烟反向代理', enable: false, type: 'proxy', listen: ['127.0.0.1:' + (opts.webPort + 1)],
    domains: ['app.smoke.demo.local'], path: '/', priority: 30, tls: { mode: 'off', hsts: false },
    waf: false, access: { mode: 'off' },
    proxy: { targets: ['http://127.0.0.1:18099'], balance: 'roundrobin', timeoutSec: 30 },
    remark: '冒烟演示数据',
  });

  const forward = await step('端口转发规则', 'post', '/api/v1/forward/rules', {
    name: '冒烟 TCP 转发', enable: true, protocol: 'tcp',
    srcAddr: '127.0.0.1:' + opts.forwardPort, dstAddr: '127.0.0.1:' + opts.echoPort,
    access: { mode: 'off' }, timeoutSec: 300, maxConns: 200, maxConnsPerIP: 50, remark: '冒烟演示数据',
  });

  const ddnsOn = await step('DDNS 规则（启用）', 'post', '/api/v1/ddns/rules', {
    name: '冒烟动态域名', enable: true, provider: 'cloudflare',
    creds: { apiToken: 'smoke-not-a-real-credential' },
    domain: 'example.com', subDomains: ['home'], recordType: 'A', ttl: 600,
    ipv4: { enable: true, mode: 'static', value: '203.0.113.10' },
    ipv6: { enable: false, mode: 'static', value: '' }, intervalSec: 3600, remark: '冒烟演示数据',
  });
  await step('DDNS 规则（停用）', 'post', '/api/v1/ddns/rules', {
    name: '冒烟停用规则', enable: false, provider: 'cloudflare',
    creds: { apiToken: 'smoke-not-a-real-credential' },
    domain: 'example.com', subDomains: ['off'], recordType: 'A', ttl: 600,
    ipv4: { enable: true, mode: 'static', value: '203.0.113.11' },
    ipv6: { enable: false, mode: 'static', value: '' }, intervalSec: 3600, remark: '冒烟演示数据（停用）',
  });

  await step('证书任务（未启用）', 'post', '/api/v1/acme/jobs', {
    name: '冒烟证书任务', enable: false, domains: ['demo.example.com'], keyType: 'ec256',
    challenge: 'http', renewDays: 30, remark: '冒烟演示数据（未启用）',
  });
  await step('通知 Webhook', 'put', '/api/v1/notify/webhooks', [{
    id: '', name: '冒烟运维通知', enable: true, url: 'https://example.com/hooks/nunt-smoke',
    method: 'POST', headers: { 'Content-Type': 'application/json' }, events: ['system.alert', 'ddns.error'],
  }]);
  await step('计划任务', 'post', '/api/v1/task/items', {
    name: '冒烟每日巡检', enable: true, cron: '0 4 * * *',
    actions: [
      { type: 'module.toggle', target: 'web', value: 'restart' },
      { type: 'notify.webhook', value: '冒烟巡检完成' },
    ],
    remark: '冒烟演示数据',
  });
  await step('API Token', 'post', '/api/v1/auth/tokens', { name: '冒烟只读 Token', scopes: ['read'] });
  // 系统设置：给「设置」页的 nunt-tags 字段（管理端 IP 白名单）真实数据。
  await step('系统设置（管理端 IP 白名单）', 'put', '/api/v1/system/settings', {
    adminListen: ':' + opts.port,
    adminAllowIps: ['127.0.0.1', '10.0.0.0/8'],
    trustProxy: false,
    logLevel: 'info',
    sessionTtlHours: 24,
    loginMaxFail: 5,
    loginLockMinutes: 15,
    theme: 'dark',
    checkUpdate: false,
    baseUrl: '',
  });

  // 真的走一条 TCP 连接，让转发日志对话框有数据。
  const forwardId = forward && forward.data ? forward.data.id : '';
  let traffic = { ok: false, error: '规则未创建成功' };
  if (forwardId) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      traffic = await runForwardProbe('127.0.0.1:' + opts.forwardPort, 3000);
      if (traffic.ok) break;
      await sleep(500);
    }
    steps.push({
      name: '端口转发：真实 TCP 连接', method: 'TCP', path: '127.0.0.1:' + opts.forwardPort,
      status: traffic.ok ? 200 : 0, ok: !!traffic.ok, error: traffic.ok ? '' : (traffic.error || '没有回显'),
      id: forwardId,
    });
  }

  return {
    steps,
    forwardRuleId: forwardId,
    ddnsRuleId: ddnsOn && ddnsOn.data ? ddnsOn.data.id : '',
    www,
  };
}

/* ------------------------------------------------------------------ 浏览器检查 */

function newBucket() {
  return { console: [], pageErrors: [], failedRequests: [], httpErrors: [], external: [] };
}

function isLocalRequest(url, base) {
  const value = String(url || '');
  if (value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('about:')) return true;
  return value.startsWith(base);
}

function isSSE(url) { return /\/api\/v1\/events/.test(url || ''); }

function snapshotBucket(bucket) {
  return {
    console: bucket.console.slice(),
    pageErrors: bucket.pageErrors.slice(),
    failedRequests: bucket.failedRequests.filter((e) => !isSSE(e.url)),
    abortedRequests: bucket.failedRequests.filter((e) => isSSE(e.url)),
    httpErrors: bucket.httpErrors.filter((e) => !isSSE(e.url)),
    external: bucket.external.slice(),
  };
}

function clearBucket(bucket) {
  bucket.console.length = 0;
  bucket.pageErrors.length = 0;
  bucket.failedRequests.length = 0;
  bucket.httpErrors.length = 0;
  bucket.external.length = 0;
}

// runAxe：注入本地 axe-core（page.evaluate 走调试协议，不受 CSP 限制、零外部请求）。
async function runAxe(page) {
  try {
    await page.evaluate(AXE_SOURCE);
    return await page.evaluate(async (tags) => {
      if (!window.axe || typeof window.axe.run !== 'function') throw new Error('axe 没有注入成功');
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
      const rounds = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      const violations = result.violations.map((v) => {
        rounds[v.impact] = (rounds[v.impact] || 0) + v.nodes.length;
        return {
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => (n.target || []).join(' >> ')),
        };
      });
      return { version: window.axe.version, violations, counts: rounds, passCount: result.passes.length, incomplete: result.incomplete.length };
    }, TAGS);
  } catch (err) {
    return { error: String((err && err.message) || err), violations: [], counts: { critical: 0, serious: 0, moderate: 0, minor: 0 }, passCount: 0, incomplete: 0 };
  }
}

async function gotoPage(page, base, opts, id) {
  await page.goto(base + '/#/' + id, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const content = document.querySelector('#content');
    return !!content && content.children.length > 0;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(opts.settle);
}

/* ------------------------------------------------------------------ 断言小工具（都在页面里跑） */

// toast 堆栈在右上角，会压住顶栏与页面右上角的按钮并拦截指针事件。
// 两个坑：Shoelace 的 toast 在鼠标悬停时会「暂停」自动消失（@mouseenter=pauseAutoHide），
// 而自动化里指针常常正好停在右上角；所以先把指针挪开再等，实在不走就把残留的提示摘掉。
async function waitToastsGone(page, timeoutMs) {
  try { await page.mouse.move(4, 860); } catch (err) { /* 忽略 */ }
  try {
    await page.waitForFunction(() => !document.querySelector('.sl-toast-stack sl-alert'), null, { timeout: timeoutMs || 6000 });
  } catch (err) { /* 还在就清掉 */ }
  await page.evaluate(() => {
    const stack = document.querySelector('.sl-toast-stack');
    if (!stack) return;
    stack.querySelectorAll('sl-alert').forEach((alert) => alert.remove());
    if (!stack.querySelector('sl-alert')) stack.remove();
  });
}

async function clickLocator(page, locator) {
  await waitToastsGone(page);
  await locator.click({ timeout: 8000 });
}

async function clickButton(page, text, scope) {
  await clickLocator(page, page.locator((scope || '#content') + ' sl-button', { hasText: text }).first());
}

async function clickDialogButton(page, text) {
  await clickLocator(page, page.locator('sl-dialog[open] sl-button', { hasText: text }).first());
}

async function waitDialog(page, labelPart) {
  await page.waitForFunction((wanted) => {
    const dlg = document.querySelector('sl-dialog[open]');
    if (!dlg) return false;
    const label = dlg.getAttribute('label') || '';
    return wanted ? label.indexOf(wanted) >= 0 : true;
  }, labelPart || '', { timeout: 8000 });
}

async function closeDialogIfOpen(page) {
  const open = await page.locator('sl-dialog[open]').count();
  if (!open) return;
  await page.evaluate(() => {
    const dlg = document.querySelector('sl-dialog[open]');
    if (dlg && typeof dlg.hide === 'function') dlg.hide();
    else if (dlg) dlg.removeAttribute('open');
  });
  await page.waitForTimeout(400);
}

async function rowsOf(page, scope) {
  return page.locator((scope || '#content') + ' .nunt-table tbody tr').count();
}

async function setField(page, name, value) {
  const result = await page.evaluate((args) => {
    const host = document.querySelector('[data-nunt-field="' + args.name + '"]');
    if (!host) return '找不到字段 ' + args.name;
    if (host.tagName.toLowerCase() === 'nunt-tags') {
      host.value = Array.isArray(args.value) ? args.value : [String(args.value)];
      host.dispatchEvent(new CustomEvent('nunt-change', { bubbles: true, composed: true }));
      return 'ok';
    }
    host.value = args.value;
    const evt = (host.tagName.toLowerCase() === 'sl-select') ? 'sl-change' : 'sl-input';
    host.dispatchEvent(new CustomEvent(evt, { bubbles: true, composed: true }));
    return 'ok';
  }, { name, value });
  if (result !== 'ok') throw new Error(result);
  await page.waitForTimeout(200);
}

async function fieldVisible(page, name) {
  return page.evaluate((wanted) => {
    const wrap = document.querySelector('[data-nunt-wrap="' + wanted + '"]');
    if (!wrap) return false;
    if (wrap.classList.contains('hidden')) return false;
    const rect = wrap.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, name);
}

async function lastToast(page) {
  return page.evaluate(() => {
    const stack = document.querySelector('.sl-toast-stack');
    if (!stack) return '';
    const alerts = Array.from(stack.querySelectorAll('sl-alert'));
    const last = alerts[alerts.length - 1];
    return last ? (last.textContent || '').trim() : '';
  });
}

async function tagsInfo(page, name) {
  return page.evaluate((wanted) => {
    const host = document.querySelector('nunt-tags[data-nunt-field="' + wanted + '"]');
    if (!host) return { found: false };
    const input = host.querySelector('sl-input');
    const shadow = input && input.shadowRoot ? input.shadowRoot : null;
    const label = shadow ? shadow.querySelector('label') : null;
    const inner = shadow ? shadow.querySelector('input') : null;
    return {
      found: true,
      value: Array.isArray(host.value) ? host.value.slice() : [],
      inputLabel: input ? input.getAttribute('label') : null,
      innerName: inner ? (inner.getAttribute('aria-label') || '') : '',
      labelText: label ? (label.textContent || '').trim() : '',
      chips: host.querySelectorAll('sl-tag').length,
      outerLabel: !!host.closest('.nunt-field').querySelector('.nunt-field-label'),
    };
  }, name);
}

/* ------------------------------------------------------------------ 12 页交互 */

const INTERACTIONS = {
  async dashboard(page, ctx) {
    const cards = await page.locator('#content h2').count();
    ctx.check('dashboard', '概览卡片渲染（h2 标题 >= 3）', cards >= 3, 'h2 数量 ' + cards);
    await clickButton(page, '刷新');
    await page.waitForTimeout(1200);
    const still = await page.locator('#content h2').count();
    ctx.check('dashboard', '「刷新」后模块卡片仍在', still >= 3, 'h2 数量 ' + still);
  },

  async web(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('web', '规则表有演示数据（>= 2 行）', rows >= 2, '行数 ' + rows);
    await clickButton(page, '新建规则');
    await waitDialog(page, 'Web 规则');
    ctx.check('web', '「新建 Web 规则」对话框打开', true, '');
    await setField(page, 'type', 'proxy');
    await page.waitForTimeout(600);
    const rate = await fieldVisible(page, 'proxyRateLimit');
    const body = await fieldVisible(page, 'proxyMaxBody');
    ctx.check('web', '反向代理暴露「限速（请求/秒）」与「请求体上限（字节）」', rate && body, '限速可见 ' + rate + '，请求体上限可见 ' + body);
    await page.screenshot({ path: path.join(ctx.out, 'light-web-proxy-hardening.png'), fullPage: true });

    // sl-dialog 的阴影 <header> 会被 axe 当成第二个 banner（landmark-no-duplicate-banner /
    // landmark-unique）。kit 的 openDialog 会把它降级成 role="presentation"，这里验证真的消掉了。
    const dlgAxe = await runAxe(page);
    const landmark = (dlgAxe.violations || []).filter((v) => v.id === 'landmark-no-duplicate-banner' || v.id === 'landmark-unique');
    ctx.check('web', '对话框打开时没有 sl-dialog 的 landmark 误报', landmark.length === 0,
      landmark.length ? landmark.map((v) => v.id + '(' + v.nodes + ')').join(', ') : '0 条（其余对话框级违规：' + (dlgAxe.violations || []).map((v) => v.id).join(',') + '）');

    await closeDialogIfOpen(page);
    const open = await page.locator('sl-dialog[open]').count();
    ctx.check('web', '取消后对话框关闭', open === 0, '仍打开的对话框 ' + open);
  },

  async forward(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('forward', '转发规则表有数据', rows >= 1, '行数 ' + rows);
    const before = ctx.requests.length;
    await clickLocator(page, page.locator('#content sl-button[title="转发日志"]').first());
    await waitDialog(page, '转发日志');
    await page.waitForTimeout(1500);
    const lines = await page.locator('.pforward-log-line').count();
    const text = lines ? await page.locator('.pforward-log-line').first().innerText() : '';
    ctx.check('forward', '转发日志对话框有真实日志行（真实 TCP 连接产生）', lines >= 1 && text.indexOf('->') >= 0,
      '行数 ' + lines + '，首行「' + text.replace(/\s+/g, ' ').slice(0, 80) + '」');
    await page.screenshot({ path: path.join(ctx.out, 'light-forward-log.png'), fullPage: true });
    await clickDialogButton(page, '关闭');
    await page.waitForTimeout(600);
    const stopped = ctx.requests.length;
    await page.waitForTimeout(6000);
    const after = ctx.requests.length;
    const polled = ctx.requests.slice(stopped).filter((r) => r.url.indexOf('/api/v1/forward/logs') >= 0).length;
    ctx.check('forward', '关闭对话框后 5 秒轮询真的停止', polled === 0, '关闭后新增日志请求 ' + polled + ' 次（总请求 ' + before + '→' + after + '）');
  },

  async ddns(page, ctx) {
    // A2：后端真实字段是 failures，界面必须显示它（旧字段 fail/failCount 只作兜底）。
    await page.route('**/api/v1/ddns/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rules: [{ id: ctx.seed.ddnsRuleId, name: '冒烟动态域名', ip: '203.0.113.10', success: 12, failures: 7, message: '冒烟：最近一次更新成功' }] }),
    }));
    await gotoPage(page, ctx.base, ctx.opts, 'ddns');
    await page.waitForTimeout(800);
    const counts = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('#content .nunt-table'));
      const status = tables[1];
      if (!status) return '';
      const row = status.querySelector('tbody tr');
      if (!row) return '';
      return Array.from(row.querySelectorAll('sl-badge')).map((b) => (b.textContent || '').trim()).join('/');
    });
    ctx.check('ddns', '运行状态显示后端真实失败计数 failures=7', counts === '12/7', '成功/失败徽标 = ' + (counts || '（空）'));
    await page.unroute('**/api/v1/ddns/status');

    // A3：未启用规则点「立即执行」必须提示「该规则未启用，已跳过」，且不发 POST /run。
    const disabledRow = page.locator('#content .nunt-table tbody tr', { hasText: '冒烟停用规则' }).first();
    ctx.check('ddns', '存在演示用的停用规则行', (await disabledRow.count()) > 0, '');
    const before = ctx.requests.length;
    await clickLocator(page, disabledRow.locator('sl-button[title="立即执行"]'));
    await page.waitForTimeout(900);
    const toast = await lastToast(page);
    const runs = ctx.requests.slice(before).filter((r) => /\/api\/v1\/ddns\/rules\/[^/]+\/run$/.test(r.url)).length;
    ctx.check('ddns', '未启用规则点「立即执行」提示「该规则未启用，已跳过」', toast.indexOf('该规则未启用，已跳过') >= 0, 'toast「' + toast + '」');
    ctx.check('ddns', '未启用规则不发出 POST /run', runs === 0, '新增 /run 请求 ' + runs + ' 次');
    await page.screenshot({ path: path.join(ctx.out, 'light-ddns-skip.png'), fullPage: true });
  },

  async acme(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('acme', '证书任务表有数据', rows >= 1, '行数 ' + rows);
    await clickButton(page, '新建任务');
    await waitDialog(page, '证书');
    const info = await page.evaluate(() => {
      const sel = document.querySelector('sl-dialog[open] [data-nunt-field="keyType"]');
      if (!sel) return null;
      return { value: sel.value, options: Array.from(sel.querySelectorAll('sl-option')).map((o) => o.getAttribute('value')) };
    });
    const wanted = ['ec256', 'ec384', 'rsa2048', 'rsa4096'];
    const ok = !!info && info.value === 'ec256' && wanted.every((v) => info.options.indexOf(v) >= 0) &&
      info.options.indexOf('ecdsa') < 0;
    ctx.check('acme', '密钥类型选项是后端取值 ec256/ec384/rsa2048/rsa4096（默认 ec256）', ok,
      info ? ('默认 ' + info.value + '，选项 ' + info.options.join(',')) : '找不到 keyType 字段');
    await page.screenshot({ path: path.join(ctx.out, 'light-acme-keytype.png'), fullPage: true });
    await closeDialogIfOpen(page);
  },

  async storage(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('storage', '存储挂载表有数据', rows >= 1, '行数 ' + rows);
    await clickButton(page, '新建挂载');
    await waitDialog(page, '挂载');
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll('sl-dialog[open] [data-nunt-field]')).map((n) => n.getAttribute('data-nunt-field')));
    const wanted = ['name', 'type', 'root', 'readOnly', 'remark'];
    const missing = wanted.filter((f) => fields.indexOf(f) < 0);
    ctx.check('storage', '「新建挂载」对话框字段齐全', missing.length === 0, missing.length ? '缺少 ' + missing.join(',') : fields.length + ' 个字段');
    await closeDialogIfOpen(page);
  },

  async files(page, ctx) {
    await page.waitForTimeout(800);
    const mounts = await page.locator('#content .pfiles-mount sl-option').count();
    ctx.check('files', '文件页拿到存储挂载点', mounts >= 1, '挂载点选项 ' + mounts);
    await clickButton(page, '根目录');
    await page.waitForTimeout(1200);
    const rows = await rowsOf(page);
    const names = rows ? await page.locator('#content .nunt-table tbody tr').first().innerText() : '';
    ctx.check('files', '根目录下列出真实文件条目', rows >= 1, '行数 ' + rows + '，首行「' + names.replace(/\s+/g, ' ').slice(0, 60) + '」');
    await page.screenshot({ path: path.join(ctx.out, 'light-files-root.png'), fullPage: true });
  },

  async waf(page, ctx) {
    const heads = await page.evaluate(() => Array.from(document.querySelectorAll('#content h2')).map((h) => (h.textContent || '').trim()));
    const wanted = ['WAF 配置', '请求体检查策略', '规则文件 / 规则组', '请求测试', '拦截日志'];
    const missing = wanted.filter((t) => heads.indexOf(t) < 0);
    ctx.check('waf', '五张卡片标题齐全', missing.length === 0, missing.length ? '缺少 ' + missing.join(' / ') : heads.join(' / '));
    await setField(page, 'url', 'http://127.0.0.1:' + ctx.opts.webPort + '/?id=1%20union%20select%201');
    await clickButton(page, '测试');
    await page.waitForTimeout(2500);
    const result = await page.evaluate(() => {
      const text = document.querySelector('#content').textContent || '';
      if (text.indexOf('已被拦截') >= 0) return '已被拦截';
      if (text.indexOf('未拦截') >= 0) return '未拦截';
      return '';
    });
    ctx.check('waf', '请求测试返回结果（拦截判定渲染出来）', result.length > 0, result ? ('判定：' + result) : '没有结果');
    await page.screenshot({ path: path.join(ctx.out, 'light-waf-test.png'), fullPage: true });
  },

  async task(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('task', '计划任务表有数据', rows >= 1, '行数 ' + rows);
    await clickButton(page, '新建任务');
    await waitDialog(page, '任务');
    const hasCron = await fieldVisible(page, 'cron');
    const hasExample = await page.locator('sl-dialog[open] sl-button', { hasText: '每天 03:30' }).count();
    ctx.check('task', '「新建任务」对话框含 Cron 与常用示例', hasCron && hasExample > 0, 'cron 可见 ' + hasCron + '，示例按钮 ' + hasExample);
    await closeDialogIfOpen(page);
  },

  async notify(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('notify', 'Webhook 表有数据', rows >= 1, '行数 ' + rows);
    await clickButton(page, '新建 Webhook');
    await waitDialog(page, 'Webhook');
    const events = await page.evaluate(() => {
      const field = document.querySelector('sl-dialog[open] [data-nunt-field="events"]');
      if (!field) return { options: 0, multiple: false };
      return { options: field.querySelectorAll('sl-option').length, multiple: field.hasAttribute('multiple') };
    });
    ctx.check('notify', '「新建 Webhook」对话框含事件多选', events.options >= 3 && events.multiple,
      '可选事件 ' + events.options + '，multiple=' + events.multiple);
    await closeDialogIfOpen(page);
  },

  async logs(page, ctx) {
    const rows = await rowsOf(page);
    ctx.check('logs', '日志页渲染出日志行', rows >= 1, '行数 ' + rows);
    const before = await page.locator('#content .nunt-table tbody tr').count();
    const pickLevel = (value) => page.evaluate((v) => {
      const sel = document.querySelector('#content .plogs-level');
      if (!sel) return false;
      sel.value = v;
      sel.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
      return true;
    }, value);
    const switched = await pickLevel('error');
    await page.waitForTimeout(900);
    const after = await page.locator('#content .nunt-table tbody tr').count();
    const countText = await page.evaluate(() => {
      const el = document.querySelector('#content .plogs-count');
      return el ? (el.textContent || '').trim() : '';
    });
    ctx.check('logs', '级别过滤生效（切到 error 后行数不增加）', switched && after <= before && before > 0,
      before + ' 行 → ' + after + ' 行（' + countText + '）');
    await pickLevel('');
    await page.waitForTimeout(600);
  },

  async settings(page, ctx) {
    const tabs = await page.locator('#content sl-tab').count();
    ctx.check('settings', '五个设置 tab', tabs >= 5, 'tab 数 ' + tabs);
    const tags = await tagsInfo(page, 'adminAllowIps');
    ctx.check('settings', '管理端 IP 白名单用 nunt-tags（内层输入有可见 label）',
      !!tags.found && tags.chips >= 2 && !!tags.labelText && !tags.outerLabel,
      'chips ' + tags.chips + '，内层 label「' + tags.labelText + '」，外层重复标签 ' + tags.outerLabel + '，值 ' + JSON.stringify(tags.value));
    await page.screenshot({ path: path.join(ctx.out, 'light-settings-tags.png'), fullPage: true });

    await clickLocator(page, page.locator('#content sl-tab', { hasText: 'API Token' }).first());
    await page.waitForTimeout(800);
    await clickButton(page, '新建 Token');
    await waitDialog(page, 'Token');
    const scopes = await tagsInfo(page, 'scopes');
    ctx.check('settings', '新建 Token 的「权限范围」用 nunt-tags', !!scopes.found && !!scopes.labelText,
      scopes.found ? ('内层 label「' + scopes.labelText + '」') : '找不到 nunt-tags');
    if (scopes.found) {
      await setField(page, 'scopes', ['read', 'write']);
      const after = await tagsInfo(page, 'scopes');
      ctx.check('settings', 'nunt-tags 能加出多枚标签', after.chips === 2, '标签数 ' + after.chips + '，值 ' + JSON.stringify(after.value));
    }
    await page.screenshot({ path: path.join(ctx.out, 'light-settings-token.png'), fullPage: true });
    await closeDialogIfOpen(page);
  },
};

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('用法：node scripts/ui-smoke.mjs [--out dir] [--exe nunt.exe] [--port 16601] [--base url] [--password xxx] [--headed] [--keep-data]' + String.fromCharCode(10));
    return;
  }
  await fsp.mkdir(opts.out, { recursive: true });

  let server = null;
  let echo = null;
  let base = opts.base;
  let dataDir = '';
  let password = opts.password;
  const started = !!opts.base;
  let exitCode = 0;
  const checks = [];
  const requests = [];
  const screenshots = [];
  let seed = { steps: [], forwardRuleId: '', ddnsRuleId: '' };
  let browser = null;

  const ctx = { opts, out: opts.out, base: '', seed, requests, check };

  function check(area, name, ok, detail) {
    checks.push({ area, name, ok: !!ok, detail: detail || '' });
    if (!ok) log('  x [' + area + '] ' + name + '：' + (detail || ''));
    return !!ok;
  }

  try {
    if (started) {
      base = opts.base;
      if (!password) throw new Error('--base 模式下必须用 --password 或 NUNT_ADMIN_PASSWORD 提供管理员密码');
      const res = await fetch(base + '/healthz');
      if (!res.ok) throw new Error('--base 指向的服务没有通过 /healthz：' + base);
      log('使用已在运行的服务：' + base);
    } else {
      dataDir = opts.dataDir || path.join(REPO, '.gocache', 'ui-smoke-data', String(Date.now()));
      await fsp.mkdir(dataDir, { recursive: true });
      for (const port of [opts.port, opts.webPort, opts.webPort + 1, opts.forwardPort, opts.echoPort]) {
        if (!(await waitFree(port, 60))) throw new Error('端口 ' + port + ' 被占用超过 60 秒');
      }
      const www = await prepareSampleSite(dataDir);
      echo = await startEchoServer(opts.echoPort);
      server = await startServer(opts, dataDir);
      base = server.base;
      password = password || server.password;
      log('服务就绪：' + base + '（数据目录 ' + dataDir + '）');

      const client = makeClient(base);
      const login = await client.post('/api/v1/auth/login', { username: 'admin', password: server.password });
      if (!login.ok) throw new Error('API 登录失败');
      client.setCsrf(login.data.csrf);
      if (login.data.mustChangePassword) {
        password = 'ui-smoke-admin-2024';
        const changed = await client.post('/api/v1/auth/password', { current: server.password, new: password });
        if (!changed.ok) throw new Error('修改初始密码失败');
        const relogin = await client.post('/api/v1/auth/login', { username: 'admin', password });
        if (!relogin.ok) throw new Error('改密后重新登录失败');
        client.setCsrf(relogin.data.csrf);
      }
      seed = await seedDemoData(client, opts, www);
      log('演示数据：' + seed.steps.filter((s) => s.ok).length + '/' + seed.steps.length + ' 成功');
      for (const s of seed.steps) if (!s.ok) log('  x ' + s.name + '：' + s.error);
    }
    ctx.base = base;
    ctx.seed = seed;

    browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
    });
    await context.addInitScript(() => {
      try { localStorage.setItem('nunt.theme', 'light'); localStorage.setItem('nunt.session', '1'); } catch (err) { /* 忽略 */ }
    });
    const page = await context.newPage();
    const bucket = newBucket();
    let current = 'login';

    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const loc = msg.location();
      bucket.console.push({ page: current, type, text: String(msg.text()).slice(0, 400), location: loc ? (loc.url || '') + ':' + (loc.lineNumber || 0) : '' });
    });
    page.on('pageerror', (err) => { bucket.pageErrors.push({ page: current, message: String((err && err.message) || err).slice(0, 600) }); });
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      bucket.failedRequests.push({ page: current, url: req.url(), method: req.method(), failure: failure ? failure.errorText : '' });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) bucket.httpErrors.push({ page: current, url: res.url(), status: res.status(), method: res.request().method() });
    });
    page.on('request', (req) => {
      requests.push({ page: current, url: req.url(), method: req.method() });
      if (!isLocalRequest(req.url(), base)) bucket.external.push({ page: current, url: req.url(), method: req.method() });
    });

    // 1) 登录（真实表单；浅色主题）
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="username"]', { timeout: 20000 });
    screenshots.push('light-login.png');
    await page.screenshot({ path: path.join(opts.out, 'light-login.png'), fullPage: true });
    const themeClass = await page.evaluate(() => document.documentElement.className);
    check('shell', '登录页处于浅色主题', themeClass.indexOf('sl-theme-light') >= 0, 'html class = ' + themeClass);
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForSelector('.topbar', { timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);
    const alert = page.locator('.login-alert:not(.hidden)');
    if (await alert.count()) throw new Error('浏览器登录失败：' + (await alert.first().textContent()));
    await page.waitForTimeout(800);
    check('shell', '浏览器表单登录成功（外壳顶栏出现）', true, '');
    const navCount = await page.locator('.app-nav-item').count();
    check('shell', '侧边栏 12 个导航项', navCount === 12, '导航项 ' + navCount);
    clearBucket(bucket);

    // 2) 主题切换（浅 → 深 → 浅）
    await clickLocator(page, page.locator('#themeBtn'));
    await page.waitForTimeout(500);
    const dark = await page.evaluate(() => document.documentElement.classList.contains('sl-theme-dark'));
    await clickLocator(page, page.locator('#themeBtn'));
    await page.waitForTimeout(500);
    const light = await page.evaluate(() => document.documentElement.classList.contains('sl-theme-light'));
    check('shell', '主题切换深/浅两向都生效', dark && light, '深色 ' + dark + '，浅色 ' + light);

    // 3) 12 页：挂载 + 浅色 axe + 关键交互
    const a11yPages = [];
    for (const info of PAGES) {
      current = info.id;
      clearBucket(bucket);
      log('检查页面 #/' + info.id);
      await gotoPage(page, base, opts, info.id);
      const shot = 'light-' + info.id + '.png';
      await page.screenshot({ path: path.join(opts.out, shot), fullPage: true });
      screenshots.push(shot);
      const metrics = await page.evaluate(() => {
        const content = document.querySelector('#content');
        return {
          title: (document.querySelector('.topbar .title') || {}).textContent || '',
          contentChildren: content ? content.children.length : 0,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      check(info.id, '页面挂载并渲染内容', metrics.contentChildren > 0 && String(metrics.title).trim().length > 0,
        '顶栏「' + String(metrics.title).trim() + '」，内容子节点 ' + metrics.contentChildren);
      const a11y = await runAxe(page);
      const counts = a11y.counts || {};
      check(info.id, '浅色主题 axe 四档全 0',
        !a11y.error && !counts.critical && !counts.serious && !counts.moderate && !counts.minor,
        a11y.error ? ('扫描失败：' + a11y.error) : ('critical ' + counts.critical + ' / serious ' + counts.serious + ' / moderate ' + counts.moderate + ' / minor ' + counts.minor));
      a11yPages.push({ id: info.id, url: base + '/#/' + info.id, screenshot: shot, metrics, a11y, bucket: snapshotBucket(bucket) });

      const run = INTERACTIONS[info.id];
      if (run) {
        try { await run(page, ctx); }
        catch (err) { check(info.id, '关键交互执行', false, String((err && err.message) || err)); await closeDialogIfOpen(page); }
      }
      clearBucket(bucket);
    }

    // 4) 平台级统计（把前面各页的桶合并）
    const consoleAll = a11yPages.reduce((n, p) => n + p.bucket.console.length, 0);
    const pageErrors = a11yPages.reduce((n, p) => n + p.bucket.pageErrors.length, 0);
    const failed = a11yPages.reduce((n, p) => n + p.bucket.failedRequests.length, 0);
    const httpErrors = a11yPages.reduce((n, p) => n + p.bucket.httpErrors.length, 0);
    const external = a11yPages.reduce((n, p) => n + p.bucket.external.length, 0);
    const aborted = a11yPages.reduce((n, p) => n + p.bucket.abortedRequests.length, 0);
    check('global', 'console 报错+警告 0', consoleAll === 0, 'console ' + consoleAll);
    check('global', '未捕获异常 0', pageErrors === 0, 'pageerror ' + pageErrors);
    check('global', '失败请求 0', failed === 0, '失败请求 ' + failed + '（SSE 中断 ' + aborted + ' 条不计）');
    check('global', 'HTTP 4xx/5xx 0', httpErrors === 0, '4xx/5xx ' + httpErrors);
    check('global', '外部请求 0', external === 0, '外部请求 ' + external);
    const axeTotals = a11yPages.reduce((acc, p) => {
      const c = p.a11y.counts || {};
      acc.critical += c.critical || 0; acc.serious += c.serious || 0; acc.moderate += c.moderate || 0; acc.minor += c.minor || 0;
      return acc;
    }, { critical: 0, serious: 0, moderate: 0, minor: 0 });
    check('global', '12 页 axe 合计四档全 0',
      !axeTotals.critical && !axeTotals.serious && !axeTotals.moderate && !axeTotals.minor,
      'critical ' + axeTotals.critical + ' / serious ' + axeTotals.serious + ' / moderate ' + axeTotals.moderate + ' / minor ' + axeTotals.minor);

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const byArea = {};
    for (const c of checks) {
      byArea[c.area] = byArea[c.area] || { total: 0, failed: 0 };
      byArea[c.area].total += 1;
      if (!c.ok) byArea[c.area].failed += 1;
    }
    const report = {
      generatedAt: new Date().toISOString(),
      base,
      out: opts.out,
      theme: 'light',
      startedServer: !started,
      dataDir: started ? '' : dataDir,
      axeVersion: AXE_VERSION,
      axeRuntimeVersion: (a11yPages.find((p) => p.a11y && p.a11y.version) || { a11y: {} }).a11y.version || 'n/a',
      playwrightVersion: PLAYWRIGHT_VERSION,
      nodeVersion: process.version,
      userAgent,
      seed,
      checks,
      summary: {
        total: checks.length,
        passed: checks.filter((c) => c.ok).length,
        failed: checks.filter((c) => !c.ok).length,
        byArea,
        axe: axeTotals,
        pages: a11yPages.length,
      },
      a11y: { tags: TAGS, pages: a11yPages.map((p) => ({ id: p.id, url: p.url, counts: p.a11y.counts, violations: p.a11y.violations, incomplete: p.a11y.incomplete })) },
      buckets: {
        console: a11yPages.reduce((a, p) => a.concat(p.bucket.console), []),
        pageErrors: a11yPages.reduce((a, p) => a.concat(p.bucket.pageErrors), []),
        failedRequests: a11yPages.reduce((a, p) => a.concat(p.bucket.failedRequests), []),
        httpErrors: a11yPages.reduce((a, p) => a.concat(p.bucket.httpErrors), []),
        external: a11yPages.reduce((a, p) => a.concat(p.bucket.external), []),
      },
      // 截图清单直接从输出目录读，避免逐个交互手工登记漏项。
      screenshots: (await fsp.readdir(opts.out)).filter((f) => f.endsWith('.png')).sort(),
    };
    await fsp.writeFile(path.join(opts.out, 'ui-smoke.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10), 'utf8');
    await fsp.writeFile(path.join(opts.out, 'ui-smoke.md'), buildMarkdown(report), 'utf8');

    log('检查点 ' + report.summary.total + ' 个：通过 ' + report.summary.passed + '，失败 ' + report.summary.failed);
    log('浅色主题 axe：critical ' + axeTotals.critical + ' / serious ' + axeTotals.serious + ' / moderate ' + axeTotals.moderate + ' / minor ' + axeTotals.minor);
    log('机器数据与截图：' + opts.out);
    if (report.summary.failed > 0 || axeTotals.critical || axeTotals.serious || axeTotals.moderate || axeTotals.minor) exitCode = 1;
    log(exitCode === 0 ? 'UI-SMOKE: PASS' : 'UI-SMOKE: FAIL');
  } catch (err) {
    exitCode = 1;
    process.stderr.write('[smoke] 失败：' + ((err && err.stack) || err) + String.fromCharCode(10));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    if (echo) await echo.close();
    if (!opts.keepData && dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exitCode = exitCode;
}

function buildMarkdown(report) {
  const lines = [];
  const push = (...xs) => { for (const x of xs) lines.push(x); };
  push('# nunt 前端冒烟报告（' + report.theme + ' 主题）', '');
  push('- 生成时间：' + report.generatedAt);
  push('- 服务：' + report.base + (report.startedServer ? '（脚本自行启动的临时实例）' : '（复用已在运行的实例）'));
  push('- axe-core：' + report.axeVersion + '（运行时 ' + report.axeRuntimeVersion + '，规则标签 ' + TAGS.join(', ') + '）');
  push('- 浏览器：' + report.userAgent, '');
  push('## 1. 结论', '');
  push('| 指标 | 数值 |', '| --- | --- |');
  push('| 检查点 | ' + report.summary.total + ' |');
  push('| 通过 | ' + report.summary.passed + ' |');
  push('| 失败 | ' + report.summary.failed + ' |');
  push('| 页面数 | ' + report.summary.pages + ' |');
  push('| axe critical / serious / moderate / minor | ' + report.summary.axe.critical + ' / ' + report.summary.axe.serious + ' / ' + report.summary.axe.moderate + ' / ' + report.summary.axe.minor + ' |');
  push('| console / 未捕获异常 / 失败请求 / 4xx·5xx / 外部请求 | ' + report.buckets.console.length + ' / ' + report.buckets.pageErrors.length + ' / ' + report.buckets.failedRequests.length + ' / ' + report.buckets.httpErrors.length + ' / ' + report.buckets.external.length + ' |', '');
  push('## 2. 检查点明细', '');
  push('| 区域 | 检查点 | 结果 | 说明 |', '| --- | --- | --- | --- |');
  for (const c of report.checks) push('| ' + c.area + ' | ' + c.name + ' | ' + (c.ok ? 'PASS' : '**FAIL**') + ' | ' + String(c.detail).replace(/\|/g, '/') + ' |');
  push('', '## 3. 逐页 axe（浅色主题）', '');
  push('| 页面 | critical | serious | moderate | minor | 说明 |', '| --- | --- | --- | --- | --- | --- |');
  for (const p of report.a11y.pages) {
    const c = p.counts || {};
    push('| #/' + p.id + ' | ' + (c.critical || 0) + ' | ' + (c.serious || 0) + ' | ' + (c.moderate || 0) + ' | ' + (c.minor || 0) + ' | ' + (p.violations.length ? p.violations.map((v) => v.id + '(' + v.nodes + ')').join(', ') : '—') + ' |');
  }
  push('', '## 4. 截图', '');
  for (const s of report.screenshots) push('- ' + s);
  push('');
  return lines.join(String.fromCharCode(10));
}

main().catch((err) => {
  process.stderr.write('[smoke] 未捕获错误：' + ((err && err.stack) || err) + String.fromCharCode(10));
  process.exitCode = 1;
});
