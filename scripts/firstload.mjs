#!/usr/bin/env node
/**
 * nunt 首屏传输实测（登录页 / 外壳 / 单页增量）。
 *
 * 为什么有这个脚本：docs/FRONTEND-REPORT.md 第 5 节的「217 个请求 / 361,729 字节」是首屏优化的
 * 唯一口径，必须能被同一套方法复现。这里把它固化成脚本，before/after 用同一条命令跑。
 *
 * 方法（与第 5 节一致，不做任何估算）：
 *   1. 真实二进制（--exe，默认仓库根的 nunt.exe）+ 无头 Chromium；
 *   2. **全新 context、冷缓存**：每次测量都新开一个 browser context（Playwright 默认无缓存）；
 *   3. 记录每个响应的 Request.sizes() = responseBodySize + responseHeadersSize（编码后 body + 响应头），
 *      同时记 transferSize 与 Content-Encoding / Content-Length 供交叉核对（服务端 br 协商）；
 *   4. 三个阶段各自独立计时：
 *        A 登录页首屏（未登录：HTML + 主题 CSS + 外壳 JS + 它按需加载的 vendor 模块）
 *        B 登录动作 + 进入外壳（增量）
 *        C 外壳内切到 #/web（只算新增的模块与接口）
 *
 * 用法：
 *   node scripts/firstload.mjs [--exe nunt.exe] [--out .gocache/firstload] [--label before]
 *                              [--page web] [--port 3113] [--web-port 18090]
 *
 * 输出：<out>/firstload.json（机器数据）+ 控制台汇总表；不需要 --base（自己起实例并播种）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import {
  REPO, sleep, waitFree, startEchoServer, makeClient, startServer, stopServer,
  prepareSampleSite, seedDemoData,
} from './lib/devserver.mjs';

function parseArgs(argv) {
  const opts = {
    exe: path.join(REPO, 'nunt.exe'),
    out: path.join(REPO, '.gocache', 'firstload'),
    label: 'current',
    page: 'web',
    port: 3113,
    webPort: 18090,
    forwardPort: 12230,
    echoPort: 12231,
    settle: 1200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--exe': opts.exe = path.resolve(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--label': opts.label = next(); break;
      case '--page': opts.page = next(); break;
      case '--port': opts.port = Number(next()); break;
      case '--web-port': opts.webPort = Number(next()); break;
      case '--forward-port': opts.forwardPort = Number(next()); break;
      case '--echo-port': opts.echoPort = Number(next()); break;
      case '--settle': opts.settle = Number(next()); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error('未知参数：' + arg);
    }
  }
  return opts;
}

function log(msg) { process.stdout.write('[firstload] ' + msg + String.fromCharCode(10)); }

function isStatic(url, base) {
  const value = String(url || '');
  if (!value.startsWith(base)) return false;
  const rest = value.slice(base.length);
  return !rest.startsWith('/api/') && rest !== '/healthz';
}

/** bucketOf：把一条请求归到「自有代码 / vendor 组件 / vendor 图标 / 主题 CSS / API」之一。 */
function bucketOf(url) {
  const value = String(url || '');
  const noQuery = value.split('?')[0];
  if (noQuery.indexOf('/vendor/shoelace/themes/') >= 0) return 'theme-css';
  if (noQuery.indexOf('/vendor/shoelace/assets/icons/') >= 0) return 'vendor-icons';
  if (noQuery.indexOf('/vendor/shoelace/') >= 0) return 'vendor-components';
  if (noQuery.indexOf('/vendor/lit/') >= 0) return 'vendor-components';
  if (noQuery.indexOf('/api/') >= 0) return 'api';
  if (noQuery.endsWith('.js') || noQuery.endsWith('.css') || noQuery.endsWith('.html') || noQuery.endsWith('/')) return 'own-code';
  return 'other';
}

async function measure(opts, base, password) {
  const browser = await chromium.launch({ headless: true });
  const records = [];
  const phases = {};
  let phase = 'idle';
  const pending = new Set();
  const missingComponents = [];

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  page.on('response', (res) => {
    const task = (async () => {
      let sizes = { responseBodySize: 0, responseHeadersSize: 0, requestBodySize: 0, requestHeadersSize: 0 };
      try { sizes = await res.request().sizes(); } catch (err) { /* 拿不到就按 0 计 */ }
      records.push({
        phase,
        url: res.url(),
        status: res.status(),
        fromServiceWorker: res.fromServiceWorker ? res.fromServiceWorker() : false,
        contentType: res.headers()['content-type'] || '',
        contentEncoding: res.headers()['content-encoding'] || 'identity',
        contentLength: Number(res.headers()['content-length'] || 0),
        bodySize: sizes.responseBodySize,
        headersSize: sizes.responseHeadersSize,
        total: sizes.responseBodySize + sizes.responseHeadersSize,
        requestBodySize: sizes.requestBodySize,
      });
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  page.on('console', (msg) => {
    const text = String(msg.text());
    if (/not been registered|has already been defined|Failed to upgrade/.test(text)) missingComponents.push({ phase, text: text.slice(0, 200) });
  });
  page.on('pageerror', (err) => missingComponents.push({ phase, text: 'pageerror: ' + String((err && err.message) || err).slice(0, 200) }));

  // A) 登录页首屏（未登录、冷缓存）
  phase = 'A-login';
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 20000 });
  await page.waitForTimeout(opts.settle);
  await drain(pending);
  phases['A-login'] = snapshot(records, 'A-login');

  // B) 登录动作 + 进入外壳（增量）
  phase = 'B-shell';
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForSelector('.topbar', { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(opts.settle);
  await drain(pending);
  phases['B-shell'] = snapshot(records, 'B-shell');

  // C) 外壳内切到目标页（增量）
  phase = 'C-page';
  await page.evaluate((id) => { window.location.hash = '#/' + id; }, opts.page);
  await page.waitForSelector('#content .card', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(opts.settle);
  await drain(pending);
  phases['C-page'] = snapshot(records, 'C-page');

  const userAgent = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  return { phases, records, missingComponents, userAgent };
}

async function drain(pending) {
  // 等所有 sizes() 都落盘；网络空闲后可能还有 SSE 之类长连接，最多等 5 秒。
  const deadline = Date.now() + 5000;
  while (pending.size && Date.now() < deadline) await sleep(50);
}

function snapshot(records, name) {
  const list = records.filter((r) => r.phase === name);
  const buckets = {};
  let total = 0;
  let transfer = 0;
  let body = 0;
  let headers = 0;
  for (const r of list) {
    const key = bucketOf(r.url);
    const b = buckets[key] || (buckets[key] = { requests: 0, bytes: 0 });
    b.requests += 1;
    b.bytes += r.total;
    total += r.total;
    transfer += r.contentLength || r.bodySize;
    body += r.bodySize;
    headers += r.headersSize;
  }
  const encodings = {};
  for (const r of list) encodings[r.contentEncoding || 'identity'] = (encodings[r.contentEncoding || 'identity'] || 0) + 1;
  return {
    requests: list.length,
    bytes: total,
    bodyBytes: body,
    headerBytes: headers,
    transferBytes: transfer,
    encodings,
    buckets,
    // 请求清单（按字节降序）——报告里引用得到具体是哪些模块。
    top: list.slice().sort((a, b) => b.total - a.total).slice(0, 30).map((r) => ({
      url: r.url.replace(/^https?:\/\/[^/]+/, ''), status: r.status, bytes: r.total, encoding: r.contentEncoding,
    })),
    urls: list.map((r) => r.url.replace(/^https?:\/\/[^/]+/, '')),
  };
}

function fmtTable(phases) {
  const lines = [];
  lines.push('阶段                      请求数      传输字节     其中 body      响应头   br/gzip/identity');
  for (const name of Object.keys(phases)) {
    const p = phases[name];
    const enc = p.encodings || {};
    lines.push(
      name.padEnd(22) + String(p.requests).padStart(8) + String(p.bytes).padStart(14) +
      String(p.bodyBytes).padStart(14) + String(p.headerBytes).padStart(11) + '   ' +
      [enc.br || 0, enc.gzip || 0, enc.identity || 0].join('/'),
    );
  }
  return lines.join(String.fromCharCode(10));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('用法：node scripts/firstload.mjs [--exe nunt.exe] [--out dir] [--label before] [--page web]' + String.fromCharCode(10));
    return;
  }
  await fsp.mkdir(opts.out, { recursive: true });
  const dataDir = path.join(REPO, '.gocache', 'firstload-data', String(Date.now()));
  await fsp.mkdir(dataDir, { recursive: true });
  for (const port of [opts.port, opts.webPort, opts.webPort + 1, opts.forwardPort, opts.echoPort]) {
    if (!(await waitFree(port, 60))) throw new Error('端口 ' + port + ' 被占用超过 60 秒');
  }
  const www = await prepareSampleSite(dataDir);
  const echo = await startEchoServer(opts.echoPort);
  let server = null;
  try {
    server = await startServer(opts, dataDir);
    log('服务就绪：' + server.base + '（数据目录 ' + dataDir + '）');
    const client = makeClient(server.base);
    const login = await client.post('/api/v1/auth/login', { username: 'admin', password: server.password });
    if (!login.ok) throw new Error('API 登录失败');
    client.setCsrf(login.data.csrf);
    let password = server.password;
    if (login.data.mustChangePassword) {
      password = 'firstload-admin-2024';
      const changed = await client.post('/api/v1/auth/password', { current: server.password, new: password });
      if (!changed.ok) throw new Error('修改初始密码失败');
      const relogin = await client.post('/api/v1/auth/login', { username: 'admin', password });
      if (!relogin.ok) throw new Error('改密后重新登录失败');
      client.setCsrf(relogin.data.csrf);
    }
    const seed = await seedDemoData(client, opts, www);
    log('演示数据：' + seed.steps.filter((s) => s.ok).length + '/' + seed.steps.length + ' 成功');

    const measured = await measure(opts, server.base, password);
    const report = {
      generatedAt: new Date().toISOString(),
      label: opts.label,
      page: opts.page,
      exe: opts.exe,
      base: server.base,
      method: 'Playwright 全新 context（冷缓存）；字节 = Request.sizes() 的 responseBodySize + responseHeadersSize',
      userAgent: measured.userAgent,
      phases: measured.phases,
      missingComponents: measured.missingComponents,
      seed: seed.steps.map((s) => ({ name: s.name, ok: s.ok, status: s.status })),
    };
    await fsp.writeFile(path.join(opts.out, 'firstload.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10), 'utf8');
    log(fmtTable(measured.phases));
    const loginPhase = measured.phases['A-login'];
    log('合计 A+B+C：' + (loginPhase.requests + measured.phases['B-shell'].requests + measured.phases['C-page'].requests) + ' 个请求 / ' +
      (loginPhase.bytes + measured.phases['B-shell'].bytes + measured.phases['C-page'].bytes) + ' 字节');
    log('未注册组件类报错：' + measured.missingComponents.length);
    log('数据：' + path.join(opts.out, 'firstload.json'));
  } finally {
    await stopServer(server);
    await echo.close();
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => { process.exitCode = 0; }).catch((err) => {
  process.stderr.write('[firstload] 失败：' + ((err && err.stack) || err) + String.fromCharCode(10));
  process.exitCode = 1;
});
