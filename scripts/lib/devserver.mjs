// nunt 开发期脚本的共享工具：临时实例、端口探测、回显服务、管理 API 客户端。
//
// 为什么单独一个文件：scripts/ui-smoke.mjs、scripts/ui-baseline.mjs、scripts/firstload.mjs
// 都需要「起一个真实二进制 + 等健康检查 + 收尾」这同一段逻辑，抄三份必然漂移。
// 这里只放**与检查内容无关**的管道代码，检查逻辑仍然留在各自的脚本里。
//
// 依赖只用于开发期（Node 内置模块），Go 构建与 Docker 镜像不需要 Node。
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 本文件在 scripts/lib/ 下，仓库根要往上两级。
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = path.resolve(HERE, '..');
export const REPO = path.resolve(SCRIPTS, '..');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function portFree(port) {
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

export async function waitFree(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

// spawnServer：Windows 上刚被杀掉的 exe 偶尔会 EBUSY（文件还被映射），重试几次。
export async function spawnServer(exe, args, options) {
  for (let i = 0; i < 12; i += 1) {
    try { return spawn(exe, args, options); }
    catch (err) {
      if (err && err.code === 'EBUSY') { await sleep(2500); continue; }
      throw err;
    }
  }
  throw new Error('spawn ' + exe + ' 一直 EBUSY');
}

/** startEchoServer：本机 TCP 回显服务，给「端口转发」提供真实目标。 */
export function startEchoServer(port) {
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

/** runForwardProbe：走一条真实 TCP 连接（让转发日志有数据）。 */
export function runForwardProbe(addr, timeoutMs) {
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

/* ------------------------------------------------------------------ 管理 API 客户端（播种用） */

export function makeClient(base) {
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

/* ------------------------------------------------------------------ 服务器进程 */

/** startServer：启动真实二进制，等 /healthz 通过，并从 stdout 抓初始管理员密码。 */
export async function startServer(opts, dataDir) {
  const tmpDir = path.join(REPO, '.gocache', 'tmp');
  const fs = await import('node:fs/promises');
  await fs.mkdir(tmpDir, { recursive: true });
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

export function stopServer(server) {
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

/* ------------------------------------------------------------------ 演示数据（脚本公用的那一份） */

export const SAMPLE_INDEX = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>nunt 冒烟演示站点</title></head>',
  '<body><h1>nunt 冒烟演示站点</h1><ul><li><a href="about.html">关于</a></li></ul></body></html>',
  '',
].join(String.fromCharCode(10));

export const SAMPLE_ABOUT = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>关于</title></head><body><h1>关于</h1></body></html>' + String.fromCharCode(10);

export async function prepareSampleSite(dataDir) {
  const fs = await import('node:fs/promises');
  const www = path.join(dataDir, 'www');
  await fs.mkdir(path.join(www, 'assets'), { recursive: true });
  await fs.writeFile(path.join(www, 'index.html'), SAMPLE_INDEX, 'utf8');
  await fs.writeFile(path.join(www, 'about.html'), SAMPLE_ABOUT, 'utf8');
  return www;
}

/**
 * seedDemoData：给「真实数据渲染」用的演示数据。
 *
 * WAF 配置这一步很关键：默认配置里 WAF 是关闭的，页面的「请求测试」永远返回「未拦截」。
 * 这里显式打开引擎 + CRS + block 模式，并声明 enforcementMode=enforce，
 * 这样冒烟里的攻击 payload 才会**必然被拦截**（blocked=true / 403 / 命中 CRS 规则 ID）。
 */
export async function seedDemoData(client, opts, www) {
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
  // WAF：打开引擎 + CRS + block，并把 enforcementMode 切到 enforce。
  // 只改响应、不改判定，但「请求测试」的 403 断言需要它（见 docs/CONTRACT.md 第 8.4 节）。
  const wafPayload = {
    enable: true,
    mode: 'block',
    useCrs: true,
    paranoiaLevel: 1,
    executingLevel: 1,
    inboundThreshold: 5,
    outboundThreshold: 4,
    disabledRules: [],
    ruleFiles: [],
    extraRules: '',
    adminProtect: false,
    bodyLimitKb: 1024,
    logOnly: false,
    enforcementMode: 'enforce',
    defaultBodyPolicy: 'full',
    peekBytes: 65536,
    peekTimeoutMs: 250,
    notifyBodyRatio: 0,
  };
  await step('WAF 配置（引擎 + CRS + enforce）', 'put', '/api/v1/waf/config', wafPayload);

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
