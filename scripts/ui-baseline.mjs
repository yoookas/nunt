#!/usr/bin/env node
/**
 * nunt 前端基线采集脚本（迁移计划阶段 0）。
 *
 * 做什么：
 *   1. 启动编译好的 nunt.exe（临时数据目录，管理端口默认 16601）；
 *   2. 从 stdout 抓初始管理员密码，先走管理 API 完成一次登录（必要时改掉初始密码），
 *      再用真实浏览器登录表单完成一次登录；
 *   3. 通过管理 API 造演示数据（静态托管规则 / 端口转发 / DDNS / WAF / 通知 / 计划任务等）；
 *   4. 逐页访问 12 个页面：等网络空闲（尽力）-> 全页截图 -> 收集 console 报错与失败请求；
 *   5. 每页注入本地安装的 axe-core 做无障碍扫描；
 *   6. 输出 docs/screenshots/before/ 下的截图、a11y.json、baseline.json、REPORT.md。
 *
 * 依赖只用于开发期（playwright + axe-core），Go 构建与 Docker 镜像不需要 Node。
 *
 * 用法：
 *   node scripts/ui-baseline.mjs [--exe nunt.exe] [--port 16601] [--out docs/screenshots/before]
 *                                [--data-dir <dir>] [--keep-data] [--headed] [--settle 800]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const AXE_PATH = require.resolve('axe-core/axe.min.js');
// axe 源码读一次，之后每页用 page.evaluate 注入（见 runAxe 的说明）。
const AXE_SOURCE = await fsp.readFile(AXE_PATH, 'utf8');
const AXE_VERSION = require('axe-core/package.json').version;
const PLAYWRIGHT_VERSION = require('playwright/package.json').version;

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = {
    exe: path.join(REPO, 'nunt.exe'),
    port: 16601,
    out: path.join(REPO, 'docs', 'screenshots', 'before'),
    dataDir: '',
    keepData: false,
    headed: false,
    settle: 800,
    webPort: 18080,
    forwardPort: 12222,
    label: '迁移前',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--exe': opts.exe = path.resolve(next()); break;
      case '--port': opts.port = Number(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--data-dir': opts.dataDir = path.resolve(next()); break;
      case '--settle': opts.settle = Number(next()); break;
      case '--web-port': opts.webPort = Number(next()); break;
      case '--forward-port': opts.forwardPort = Number(next()); break;
      case '--label': opts.label = next(); break;
      case '--keep-data': opts.keepData = true; break;
      case '--headed': opts.headed = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error('未知参数：' + arg);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ 页面清单 */

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

const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/* ------------------------------------------------------------------ 小工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nowISO() { return new Date().toISOString(); }

function log(msg) { process.stdout.write('[baseline] ' + msg + '\n'); }

function portFree(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || '127.0.0.1' });
    let done = false;
    const finish = (free) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(800);
    socket.on('connect', () => finish(false));
    socket.on('timeout', () => finish(true));
    socket.on('error', () => finish(true));
  });
}

// waitFree 轮询等待端口空出来：16601 是 nunt 的默认管理端口，本机可能已经有
// 别的实例在用，等一会儿比直接失败更实用。
async function waitFree(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

function truncate(text, max) {
  const s = String(text === undefined || text === null ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ------------------------------------------------------------------ HTTP 客户端（造数据用） */

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  async function call(method, apiPath, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(base + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

function apiError(result) {
  if (result && result.data && result.data.error && result.data.error.message) return result.data.error.message;
  if (result && typeof result.data === 'string') return truncate(result.data, 200);
  return 'HTTP ' + (result ? result.status : '?');
}

/* ------------------------------------------------------------------ 服务器进程 */

async function startServer(opts, dataDir) {
  // TMP/TEMP 指向仓库内的 .gocache/tmp：Coraza 编译规则集时会做一次 temp 目录
  // 写权限探测（checkfsfile），在受限环境里系统临时目录可能不允许写入，会让
  // WAF 配置直接保存失败。
  const tmpDir = path.join(REPO, '.gocache', 'tmp');
  await fsp.mkdir(tmpDir, { recursive: true });
  const child = spawn(opts.exe, ['-d', dataDir], {
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
    if (exited !== null) throw new Error('nunt 提前退出，exit code = ' + exited + '\n' + out.stderr + out.stdout);
    if (password) {
      try {
        const res = await fetch(base + '/healthz');
        if (res.ok) { healthy = true; break; }
      } catch (err) { /* 还没起来 */ }
    }
    await sleep(200);
  }
  if (!password) throw new Error('30 秒内没有从 stdout 抓到初始管理员密码；输出：\n' + out.stdout + '\n' + out.stderr);
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
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<title>nunt 演示静态站点</title>',
  '<link rel="stylesheet" href="style.css">',
  '</head><body>',
  '<h1>nunt 演示静态站点</h1>',
  '<p>这个目录由基线脚本创建，用来给「Web 服务」页面提供一条真实的静态托管规则。</p>',
  '<ul><li><a href="about.html">关于页面</a></li></ul>',
  '</body></html>',
  '',
].join('\n');

const SAMPLE_ABOUT = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>关于</title></head>',
  '<body><h1>关于</h1><p>基线演示数据。</p></body></html>',
  '',
].join('\n');

const SAMPLE_CSS = 'body{font-family:system-ui,sans-serif;margin:40px;line-height:1.7}h1{font-size:22px}\n';

async function prepareSampleSite(dataDir) {
  const www = path.join(dataDir, 'www');
  await fsp.mkdir(path.join(www, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(www, 'index.html'), SAMPLE_INDEX, 'utf8');
  await fsp.writeFile(path.join(www, 'about.html'), SAMPLE_ABOUT, 'utf8');
  await fsp.writeFile(path.join(www, 'style.css'), SAMPLE_CSS, 'utf8');
  await fsp.writeFile(path.join(www, 'assets', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#4c8dff"/></svg>\n', 'utf8');
  return www;
}

async function seedDemoData(client, opts, www) {
  const steps = [];
  async function step(name, method, apiPath, body) {
    let result;
    try {
      result = await client[method](apiPath, body);
    } catch (err) {
      result = { status: 0, ok: false, data: null };
    }
    result.method = method.toUpperCase();
    result.path = apiPath;
    steps.push({
      name,
      method: result.method,
      path: apiPath,
      status: result.status,
      ok: !!result.ok,
      error: result.ok ? '' : apiError(result),
      id: result.data && result.data.id ? result.data.id : '',
    });
    return result;
  }

  /* 1. 存储挂载：给「存储」「文件」两个页面提供真实数据 */
  const mount = await step('存储挂载（本地目录）', 'post', '/api/v1/storage/mounts', {
    name: '演示站点目录',
    enable: true,
    type: 'local',
    root: www,
    readOnly: false,
    remark: '基线演示数据',
  });

  /* 2. 静态托管规则（必须）：指向临时目录里的示例文件 */
  const staticRule = await step('Web 规则：静态托管', 'post', '/api/v1/web/rules', {
    name: '演示静态站点',
    enable: true,
    type: 'static',
    listen: ['127.0.0.1:' + opts.webPort],
    domains: ['static.demo.local'],
    path: '/',
    priority: 20,
    tls: { mode: 'off', hsts: false },
    waf: true,
    access: { mode: 'off' },
    static: { root: www, index: ['index.html'], listing: true, spa: false, cacheSeconds: 0 },
    remark: '基线演示数据',
  });

  /* 3. 一条反代规则，让「Web 服务」列表不止一行 */
  await step('Web 规则：反向代理', 'post', '/api/v1/web/rules', {
    name: '演示反向代理',
    enable: false,
    type: 'proxy',
    listen: ['127.0.0.1:' + (opts.webPort + 1)],
    domains: ['app.demo.local'],
    path: '/',
    priority: 30,
    tls: { mode: 'off', hsts: false },
    waf: false,
    access: { mode: 'off' },
    proxy: {
      targets: ['http://127.0.0.1:18081', 'http://127.0.0.1:18082'],
      balance: 'roundrobin',
      timeoutSec: 30,
      headers: { 'X-Demo': '1' },
    },
    remark: '基线演示数据',
  });

  /* 4. 端口转发规则 */
  await step('端口转发规则', 'post', '/api/v1/forward/rules', {
    name: '演示 TCP 转发',
    enable: true,
    protocol: 'tcp',
    srcAddr: '127.0.0.1:' + opts.forwardPort,
    dstAddr: '127.0.0.1:22',
    access: { mode: 'off' },
    timeoutSec: 300,
    maxConns: 200,
    maxConnsPerIP: 50,
    remark: '基线演示数据',
  });

  /* 5. DDNS 规则 */
  await step('DDNS 规则', 'post', '/api/v1/ddns/rules', {
    name: '演示动态域名',
    enable: true,
    provider: 'cloudflare',
    creds: { apiToken: 'demo-token-not-a-real-credential' },
    domain: 'example.com',
    subDomains: ['home'],
    recordType: 'A',
    ttl: 600,
    ipv4: { enable: true, mode: 'static', value: '203.0.113.10' },
    ipv6: { enable: false, mode: 'static', value: '' },
    intervalSec: 3600,
    remark: '基线演示数据（凭据是假值，不会真的调用服务商）',
  });

  /* 6. WAF 配置（保存失败时退一步重试） */
  const wafPayload = {
    enable: true,
    mode: 'block',
    useCrs: true,
    paranoiaLevel: 1,
    executingLevel: 1,
    inboundThreshold: 5,
    outboundThreshold: 4,
    disabledRules: ['920350'],
    ruleFiles: [],
    extraRules: '',
    adminProtect: false,
    bodyLimitKb: 1024,
    logOnly: false,
    enforcementMode: 'observe',
    defaultBodyPolicy: 'full',
    peekBytes: 65536,
    peekTimeoutMs: 250,
    notifyBodyRatio: 0.2,
  };
  const waf = await step('WAF 配置', 'put', '/api/v1/waf/config', wafPayload);
  if (!waf.ok) {
    await step('WAF 配置（去掉 disabledRules 重试）', 'put', '/api/v1/waf/config',
      Object.assign({}, wafPayload, { disabledRules: [] }));
  }

  /* 7. 通知 webhook */
  await step('通知 Webhook', 'put', '/api/v1/notify/webhooks', [{
    id: '',
    name: '演示运维通知',
    enable: true,
    url: 'https://example.com/hooks/nunt-demo',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Token': 'demo-secret-value' },
    events: ['system.alert', 'ddns.error', 'cert.failed'],
  }]);

  /* 8. 计划任务 */
  await step('计划任务', 'post', '/api/v1/task/items', {
    name: '演示每日巡检',
    enable: true,
    cron: '0 4 * * *',
    actions: [
      { type: 'module.toggle', target: 'web', value: 'restart' },
      { type: 'http.request', url: 'https://example.com/healthz', method: 'GET', headers: { 'User-Agent': 'nunt-demo' } },
      { type: 'notify.webhook', value: '每日巡检完成' },
    ],
    remark: '基线演示数据',
  });

  /* 9. 证书任务（不启用，避免真的向 ACME 服务商发请求） */
  await step('证书任务（未启用）', 'post', '/api/v1/acme/jobs', {
    name: '演示证书任务',
    enable: false,
    domains: ['demo.example.com', 'www.demo.example.com'],
    keyType: 'ec256',
    challenge: 'http',
    renewDays: 30,
    remark: '基线演示数据（未启用）',
  });

  /* 10. API Token + 第二个管理员，让「设置」页面有内容 */
  await step('API Token', 'post', '/api/v1/auth/tokens', { name: '演示只读 Token', scopes: ['read'] });
  await step('第二个管理员账号', 'post', '/api/v1/auth/users', { username: 'demo-operator', password: 'demo-operator-2024', enabled: true });

  return { steps, mountId: mount && mount.data ? mount.data.id : '', staticRuleId: staticRule && staticRule.data ? staticRule.data.id : '' };
}

/* ------------------------------------------------------------------ 浏览器采集 */

function newBucket() {
  // external 记录任何离开本服务的请求（CSP 只允许 self，零外部请求是硬指标）。
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

// runAxe 把本地安装的 axe-core 注入页面并跑一次扫描。
//
// 注意：不能用 page.addScriptTag()——它插入的是内联 <script>，会被这个项目的
// CSP（script-src 'self'）拦截，结果就是「扫描成功但零结果」的假象。
// page.evaluate 走调试协议（Runtime.evaluate），既不受 CSP 限制，也不会产生
// 任何外部网络请求，仍是纯本地注入。
async function runAxe(page) {
  try {
    await page.evaluate(AXE_SOURCE);
    return await page.evaluate(async (tags) => {
      if (!window.axe || typeof window.axe.run !== 'function') throw new Error('axe 没有注入成功');
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
      const violations = result.violations.map((v) => ({
        id: v.id,
        impact: v.impact || 'minor',
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 3).map((n) => (n.target || []).join(' ')),
      }));
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of violations) counts[v.impact] = (counts[v.impact] || 0) + v.nodes;
      return {
        version: window.axe.version,
        violations,
        counts,
        passCount: result.passes.length,
        incomplete: result.incomplete.length,
      };
    }, A11Y_TAGS);
  } catch (err) {
    return {
      error: String((err && err.message) || err),
      violations: [],
      counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
      passCount: 0,
      incomplete: 0,
    };
  }
}

async function collectPage(page, opts, pageInfo, bucket) {
  const url = opts.base + '/#/' + pageInfo.id;
  const started = Date.now();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 只改 hash 不会重新加载文档，而基线关心的是「真正打开这一页」时的报错，
  // 所以再强制一次完整加载。
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

  let mounted = true;
  try {
    await page.waitForFunction(() => {
      const content = document.querySelector('#content');
      return !!content && content.children.length > 0;
    }, null, { timeout: 15000 });
  } catch (err) { mounted = false; }

  let networkIdle = true;
  try {
    // SSE（/api/v1/events）是常驻连接，网络永远不会真正空闲；这里尽力等待，
    // 超时不算失败，只记录结果。
    await page.waitForLoadState('networkidle', { timeout: 6000 });
  } catch (err) { networkIdle = false; }
  await page.waitForTimeout(opts.settle);

  const shotName = pageInfo.id + '.png';
  await page.screenshot({ path: path.join(opts.out, shotName), fullPage: true });

  const metrics = await page.evaluate(() => {
    const content = document.querySelector('#content');
    const titleEl = document.querySelector('.topbar .title');
    return {
      title: titleEl ? titleEl.textContent : '',
      hash: location.hash,
      contentChildren: content ? content.children.length : 0,
      bodyHeight: document.documentElement.scrollHeight,
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      modals: document.querySelectorAll('.modal').length,
    };
  });

  const a11y = await runAxe(page);

  return Object.assign({
    id: pageInfo.id,
    title: pageInfo.title,
    url,
    screenshot: shotName,
    mounted,
    networkIdle,
    durationMs: Date.now() - started,
    metrics,
    a11y,
  }, snapshotBucket(bucket));
}

async function runBrowser(opts, loginPassword) {
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const bucket = newBucket();
  let current = 'login';

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    bucket.console.push({
      page: current,
      type,
      text: truncate(msg.text(), 400),
      location: loc ? (loc.url || '') + ':' + (loc.lineNumber || 0) : '',
    });
  });
  page.on('pageerror', (err) => {
    bucket.pageErrors.push({ page: current, message: truncate((err && err.message) || String(err), 600) });
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    bucket.failedRequests.push({ page: current, url: req.url(), method: req.method(), failure: failure ? failure.errorText : '' });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) bucket.httpErrors.push({ page: current, url: res.url(), status: res.status(), method: res.request().method() });
  });
  page.on('request', (req) => {
    if (!isLocalRequest(req.url(), opts.base)) {
      bucket.external.push({ page: current, url: req.url(), method: req.method() });
    }
  });

  // 真实浏览器登录：走登录表单，而不是把 cookie 直接塞进去。
  await page.goto(opts.base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 20000 });
  await page.screenshot({ path: path.join(opts.out, 'login.png'), fullPage: true });
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', loginPassword);
  await Promise.all([
    page.waitForSelector('.topbar', { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  const alert = page.locator('.login-alert:not(.hidden)');
  if (await alert.count()) {
    throw new Error('浏览器登录失败：' + (await alert.first().textContent()));
  }
  await page.waitForTimeout(600);
  const loginA11y = await runAxe(page);
  const login = Object.assign({ screenshot: 'login.png', a11y: loginA11y }, snapshotBucket(bucket));

  const pages = [];
  for (const pageInfo of PAGES) {
    current = pageInfo.id;
    clearBucket(bucket);
    log('采集页面 #/' + pageInfo.id);
    pages.push(await collectPage(page, opts, pageInfo, bucket));
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  return { pages, userAgent, login };
}

/* ------------------------------------------------------------------ 报告 */

const B = '\u0060';
const FENCE = '\u0060\u0060\u0060';

function axeSummary(pages) {
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const p of pages) {
    const counts = (p.a11y && p.a11y.counts) || {};
    for (const key of Object.keys(totals)) totals[key] += counts[key] || 0;
  }
  return totals;
}

function fmtList(items, render, emptyText) {
  if (!items || !items.length) return emptyText;
  return items.map(render).join('\n');
}

function buildReport(data) {
  const lines = [];
  const push = (...xs) => { for (const x of xs) lines.push(x); };
  push('# 前端基线报告（' + (data.label || '迁移前') + '）', '');
  push('> 由 ' + B + 'scripts/ui-baseline.mjs' + B + ' 生成，配合 ' + B + 'docs/PLAN-frontend-webcomponents.md' + B + ' 阶段 0 使用。');
  push('> 重新运行脚本会覆盖本文件的机器部分，但会保留 ' + B + 'VISUAL-REVIEW.md' + B + ' 中的人工视觉复核内容。', '');
  push('- 生成时间：' + data.generatedAt);
  push('- 二进制：' + B + data.exe + B + '（' + data.exeBytes + ' 字节）');
  push('- 数据目录：' + B + data.dataDir + B + (data.dataDirKept ? '（已保留）' : '（运行结束后已删除）'));
  push('- 浏览器：' + data.userAgent);
  push('- 视口：1440x900，color-scheme dark，语言 zh-CN');
  push('- axe-core：' + data.axeVersion + '（本地注入，运行时版本 ' + data.axeRuntimeVersion + '；规则标签 ' + A11Y_TAGS.join(', ') + '）');
  push('- 运行环境：' + data.nodeVersion + ' / playwright ' + data.playwrightVersion, '');
  push('## 1. 结论速览', '');
  push('| 指标 | 数值 |', '| --- | --- |');
  push('| 页面数 | ' + data.pages.length + ' |');
  push('| 页面未挂载出内容 | ' + data.pages.filter((p) => !p.mounted).length + ' |');
  push('| 达到网络空闲的页面 | ' + data.pages.filter((p) => p.networkIdle).length + '/' + data.pages.length + ' |');
  push('| console 报错+警告 | ' + data.pages.reduce((n, p) => n + p.console.length, 0) + ' |');
  push('| 未捕获异常（pageerror） | ' + data.pages.reduce((n, p) => n + p.pageErrors.length, 0) + ' |');
  push('| 失败请求 | ' + data.pages.reduce((n, p) => n + p.failedRequests.length, 0) + ' |');
  push('| HTTP 4xx/5xx 响应 | ' + data.pages.reduce((n, p) => n + p.httpErrors.length, 0) + ' |');
  push('| 外部请求（离开本服务） | ' + data.pages.reduce((n, p) => n + (p.external ? p.external.length : 0), 0) + ' |');
  push('| axe 严重 critical | ' + data.a11yTotals.critical + ' |');
  push('| axe 重要 serious | ' + data.a11yTotals.serious + ' |');
  push('| axe 中等 moderate | ' + data.a11yTotals.moderate + ' |');
  push('| axe 轻微 minor | ' + data.a11yTotals.minor + ' |');
  push('| 横向溢出的页面 | ' + data.pages.filter((p) => p.metrics.horizontalOverflow).length + ' |');
  push('| 文档高度平均值 | ' + Math.round(data.pages.reduce((n, p) => n + p.metrics.bodyHeight, 0) / data.pages.length) + 'px |', '');
  push('演示数据播种：' + data.seed.steps.filter((s) => s.ok).length + '/' + data.seed.steps.length + ' 成功。', '');
  push('## 2. 演示数据（由管理 API 播种）', '');
  push('| 步骤 | 请求 | 状态 | 结果 |', '| --- | --- | --- | --- |');
  for (const s of data.seed.steps) {
    push('| ' + s.name + ' | ' + B + s.method + ' ' + s.path + B + ' | ' + s.status + ' | ' +
      (s.ok ? 'OK' + (s.id ? '（id=' + s.id + '）' : '') : '**失败**：' + s.error) + ' |');
  }
  push('', '## 3. 逐页结果', '');
  const login = data.login;
  push('### 登录页（附加）', '');
  push('![登录页](' + login.screenshot + ')', '');
  push('- 截图：[' + login.screenshot + '](' + login.screenshot + ')');
  push('- console 报错与警告：' + (login.console.length ? '' : '（无）'));
  if (login.console.length) push('', FENCE + 'text', fmtList(login.console, (c) => '[' + c.type + '] ' + c.text, ''), FENCE);
  push('- 失败请求：' + (login.failedRequests.length ? '' : '（无）'));
  if (login.failedRequests.length) push('', FENCE + 'text', fmtList(login.failedRequests, (f) => f.method + ' ' + f.url + '  ' + f.failure, ''), FENCE);
  push('- 外部请求：' + ((login.external && login.external.length) ? '' : '（无）'));
  if (login.external && login.external.length) push('', FENCE + 'text', fmtList(login.external, (f) => f.method + ' ' + f.url, ''), FENCE);
  if (login.a11y) push('- axe：严重 ' + login.a11y.counts.critical + ' / 重要 ' + login.a11y.counts.serious + ' / 中等 ' + login.a11y.counts.moderate + ' / 轻微 ' + login.a11y.counts.minor + '（通过项 ' + login.a11y.passCount + '）');
  push('');
  for (const p of data.pages) {
    push('### ' + p.title + '（' + B + '#/' + p.id + B + '）', '');
    push('![#/' + p.id + '](' + p.screenshot + ')', '');
    push('- 截图：[' + p.screenshot + '](' + p.screenshot + ') ｜ URL ' + B + p.url + B);
    push('- 挂载：' + (p.mounted ? '是' : '**否**') + ' ｜ 网络空闲：' + (p.networkIdle ? '是' : '否（SSE 常驻，见第 5 节）') + ' ｜ 采集耗时 ' + p.durationMs + 'ms');
    push('- 顶栏标题 ' + B + String(p.metrics.title || '').trim() + B + ' ｜ 内容子节点 ' + p.metrics.contentChildren +
      ' ｜ 文档高度 ' + p.metrics.bodyHeight + 'px ｜ 视口宽 ' + p.metrics.viewportWidth +
      (p.metrics.horizontalOverflow ? ' ｜ **横向溢出**（scrollWidth ' + p.metrics.docWidth + '）' : ''));
    push('- axe：严重 ' + p.a11y.counts.critical + ' / 重要 ' + p.a11y.counts.serious + ' / 中等 ' + p.a11y.counts.moderate + ' / 轻微 ' + p.a11y.counts.minor +
      '（通过项 ' + p.a11y.passCount + '，待人工确认 ' + p.a11y.incomplete + '）' +
      (p.a11y.error ? ' ｜ **扫描失败**：' + p.a11y.error : ''));
    push('', '**console 报错与警告**', '', FENCE + 'text', fmtList(p.console, (c) => '[' + c.type + '] ' + c.text + (c.location ? '  (' + c.location + ')' : ''), '（无）'), FENCE);
    push('', '**未捕获异常**', '', FENCE + 'text', fmtList(p.pageErrors, (e) => e.message, '（无）'), FENCE);
    push('', '**失败请求**', '', FENCE + 'text', fmtList(p.failedRequests, (f) => f.method + ' ' + f.url + '  ' + f.failure, '（无）'), FENCE);
    push('', '**HTTP 4xx/5xx**', '', FENCE + 'text', fmtList(p.httpErrors, (h) => h.status + ' ' + h.method + ' ' + h.url, '（无）'), FENCE);
    push('', '**外部请求**', '', FENCE + 'text', fmtList(p.external, (f) => f.method + ' ' + f.url, '（无）'), FENCE);
    push('', '**axe 违规明细**', '');
    if (!p.a11y.violations.length) {
      push('（无）');
    } else {
      push('| 规则 | 影响 | 节点数 | 说明 | 示例选择器 |', '| --- | --- | --- | --- | --- |');
      for (const v of p.a11y.violations) {
        push('| ' + B + v.id + B + ' | ' + v.impact + ' | ' + v.nodes + ' | ' + v.help + ' | ' + B + v.targets.join(B + ', ' + B) + B + ' |');
      }
    }
    push('');
  }
  push('## 4. axe 汇总（严重 / 重要）', '');
  push('| 页面 | critical | serious | moderate | minor | 主要规则 |', '| --- | --- | --- | --- | --- | --- |');
  for (const p of data.pages) {
    const top = p.a11y.violations.slice(0, 4).map((v) => v.id).join(', ') || '—';
    push('| #/' + p.id + ' | ' + p.a11y.counts.critical + ' | ' + p.a11y.counts.serious + ' | ' + p.a11y.counts.moderate + ' | ' + p.a11y.counts.minor + ' | ' + top + ' |');
  }
  push('| **合计** | **' + data.a11yTotals.critical + '** | **' + data.a11yTotals.serious + '** | **' + data.a11yTotals.moderate + '** | **' + data.a11yTotals.minor + '** | |', '');
  const byRule = new Map();
  for (const p of data.pages) {
    for (const v of p.a11y.violations) {
      const cur = byRule.get(v.id) || { id: v.id, impact: v.impact, help: v.help, nodes: 0, pages: [] };
      cur.nodes += v.nodes;
      if (cur.pages.indexOf(p.id) < 0) cur.pages.push(p.id);
      byRule.set(v.id, cur);
    }
  }
  const rules = Array.from(byRule.values()).sort((a, b) => b.nodes - a.nodes);
  push('跨页面重复出现的规则（按节点数排序）：', '');
  if (!rules.length) {
    push('（无）');
  } else {
    push('| 规则 | 影响 | 总节点数 | 出现页面 | 说明 |', '| --- | --- | --- | --- | --- |');
    for (const r of rules) push('| ' + B + r.id + B + ' | ' + r.impact + ' | ' + r.nodes + ' | ' + r.pages.join(', ') + ' | ' + r.help + ' |');
  }
  push('', '## 5. 关于「网络空闲」与 SSE', '');
  push(B + '/api/v1/events' + B + ' 是一条 SSE 长连接，文档加载完成后仍有一条挂起请求，因此');
  push(B + 'waitForLoadState(' + "'networkidle'" + ')' + B + ' 基本不会满足（脚本按 6 秒超时处理，结果记在上面的「网络空闲」列）。');
  push('这不是业务缺陷，但会干扰任何基于 networkidle 的自动化测试：迁移后应改为等待明确的就绪信号。', '');
  push('切换页面时被主动中断的 SSE 请求（未计入失败请求）：' + data.pages.reduce((n, p) => n + p.abortedRequests.length, 0) + ' 条。', '');
  if (data.visualReview) {
    push('## 6. 视觉问题清单（人工复核）', '', data.visualReview.trim(), '');
  }
  push('---', '');
  push('原始数据见同目录 ' + B + 'baseline.json' + B + '（含每页 console/请求/axe 明细），无障碍统计见 ' + B + 'a11y.json' + B + '。', '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('用法：node scripts/ui-baseline.mjs [--exe nunt.exe] [--port 16601] [--out dir] [--data-dir dir] [--keep-data] [--headed]\n');
    return;
  }
  await fsp.mkdir(opts.out, { recursive: true });

  const exeStat = await fsp.stat(opts.exe).catch(() => null);
  if (!exeStat) throw new Error('找不到二进制：' + opts.exe + '（先执行 go build -o nunt.exe ./cmd/nunt）');

  // 临时数据目录放在仓库的 .gocache/ 下（已 gitignore）：系统临时目录在受限
  // 环境里可能不允许写入，而这里创建 config.json 需要写权限。运行结束会删除。
  const dataDir = opts.dataDir || path.join(REPO, '.gocache', 'ui-baseline', String(Date.now()));
  await fsp.mkdir(dataDir, { recursive: true });
  log('数据目录 ' + dataDir);

  for (const port of [opts.port, opts.webPort, opts.webPort + 1, opts.forwardPort]) {
    if (!(await waitFree(port, 60))) throw new Error('端口 ' + port + ' 被占用超过 60 秒，基线脚本需要干净端口');
  }

  const www = await prepareSampleSite(dataDir);
  let server = null;
  let exitCode = 0;
  try {
    server = await startServer(opts, dataDir);
    log('服务就绪：' + server.base + '（已从 stdout 抓到初始管理员密码）');

    const client = makeClient(server.base);
    const login = await client.post('/api/v1/auth/login', { username: 'admin', password: server.password });
    if (!login.ok) throw new Error('API 登录失败：' + apiError(login));
    client.setCsrf(login.data.csrf);
    let loginPassword = server.password;
    if (login.data.mustChangePassword) {
      loginPassword = 'baseline-admin-2024';
      const changed = await client.post('/api/v1/auth/password', { current: server.password, new: loginPassword });
      if (!changed.ok) throw new Error('修改初始密码失败：' + apiError(changed));
      const relogin = await client.post('/api/v1/auth/login', { username: 'admin', password: loginPassword });
      if (!relogin.ok) throw new Error('改密后重新登录失败：' + apiError(relogin));
      client.setCsrf(relogin.data.csrf);
      log('初始密码已按强制改密流程换掉，浏览器登录使用脚本设定的新密码');
    } else {
      log('初始密码无需修改');
    }

    const seed = await seedDemoData(client, opts, www);
    log('演示数据：' + seed.steps.filter((s) => s.ok).length + '/' + seed.steps.length + ' 成功');
    for (const s of seed.steps) if (!s.ok) log('  x ' + s.name + '：' + s.error);

    const shot = await runBrowser(Object.assign({}, opts, { base: server.base }), loginPassword);
    const a11yTotals = axeSummary(shot.pages);

    const generatedAt = nowISO();
    const visualReview = await fsp.readFile(path.join(opts.out, 'VISUAL-REVIEW.md'), 'utf8').catch(() => '');
    const report = {
      generatedAt,
      label: opts.label,
      exe: opts.exe,
      exeBytes: exeStat.size,
      dataDir,
      dataDirKept: !!opts.keepData,
      base: server.base,
      userAgent: shot.userAgent,
      axeVersion: AXE_VERSION,
      playwrightVersion: PLAYWRIGHT_VERSION,
      nodeVersion: process.version,
      adminPort: opts.port,
      seed,
      login: shot.login,
      pages: shot.pages,
      a11yTotals,
      axeRuntimeVersion: (shot.pages.find((p) => p.a11y && p.a11y.version) || { a11y: {} }).a11y.version || 'n/a',
      visualReview,
    };
    const a11y = {
      generatedAt,
      tool: {
        axe: AXE_VERSION,
        playwright: PLAYWRIGHT_VERSION,
        chromium: shot.userAgent,
        viewport: '1440x900',
        colorScheme: 'dark',
      },
      tags: A11Y_TAGS,
      summary: Object.assign({ pages: shot.pages.length }, a11yTotals),
      pages: shot.pages.map((p) => ({
        id: p.id,
        url: p.url,
        counts: p.a11y.counts,
        violations: p.a11y.violations,
        passCount: p.a11y.passCount,
        incomplete: p.a11y.incomplete,
        error: p.a11y.error || '',
      })),
    };
    await fsp.writeFile(path.join(opts.out, 'a11y.json'), JSON.stringify(a11y, null, 2) + '\n', 'utf8');
    await fsp.writeFile(path.join(opts.out, 'baseline.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await fsp.writeFile(path.join(opts.out, 'REPORT.md'), buildReport(report), 'utf8');
    log('已写出 REPORT.md / a11y.json / baseline.json 到 ' + opts.out);

    const totalConsole = shot.pages.reduce((n, p) => n + p.console.length, 0);
    const totalFailed = shot.pages.reduce((n, p) => n + p.failedRequests.length, 0);
    const totalExternal = shot.pages.reduce((n, p) => n + (p.external ? p.external.length : 0), 0);
    log('汇总：console ' + totalConsole + '，失败请求 ' + totalFailed + '，外部请求 ' + totalExternal +
      '，axe 严重 ' + a11yTotals.critical + '，重要 ' + a11yTotals.serious);
  } catch (err) {
    exitCode = 1;
    process.stderr.write('[baseline] 失败：' + ((err && err.stack) || err) + '\n');
  } finally {
    await stopServer(server);
    if (!opts.keepData) {
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log('保留数据目录 ' + dataDir);
    }
  }
  process.exitCode = exitCode;
}

main().catch((err) => {
  process.stderr.write('[baseline] 未捕获错误：' + ((err && err.stack) || err) + '\n');
  process.exitCode = 1;
});
