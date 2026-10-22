#!/usr/bin/env node
/**
 * kit 交互冒烟（阶段 1）：用真实二进制 + 无头 Chromium 走一遍 notify 页的
 * 「新建 → 校验失败 → 保存 → 提示 → 删除 → 确认」全流程，证明 kit 的
 * nunt-table / formGrid / openDialog / toast / confirmDialog 真的能用。
 *
 * 输出：docs/screenshots/phase1/notify-dialog.png、notify-saved.png、kit-smoke.json
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT = path.join(REPO, 'docs', 'screenshots', 'phase1');
let server = null;

// fillField：sl-input 的真实 input 在 shadow root 里，Playwright 的 fill 不跨边界找它，
// 这里直接给宿主设值并派发 sl-input（和用户输入走同一条回调路径）。
async function fillField(page, root, name, value) {
  const result = await page.evaluate((args) => {
    const scope = document.querySelector(args.root);
    if (!scope) return '找不到容器 ' + args.root;
    const host = scope.querySelector('[data-nunt-field="' + args.name + '"]');
    if (!host) {
      const dialogs = Array.from(document.querySelectorAll('sl-dialog')).map((d) =>
        'label=' + d.getAttribute('label') + ' open=' + d.open + ' html=' + d.innerHTML.replace(/\s+/g, ' ').slice(0, 160));
      return '找不到字段 ' + args.name + '｜对话框：' + dialogs.join(' ｜ ');
    }
    host.value = args.value;
    host.dispatchEvent(new CustomEvent('sl-input', { bubbles: true, composed: true }));
    return 'ok';
  }, { root, name, value });
  if (result !== 'ok') throw new Error('fillField: ' + result);
}
const PORT = 3113;
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const dataDir = path.join(REPO, '.gocache', 'kit-smoke', String(Date.now()));
  await fsp.mkdir(path.join(REPO, '.gocache', 'tmp'), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  for (let i = 0; i < 40; i += 1) { if (await portFree(PORT)) break; await sleep(1000); }

  const child = server = spawn(path.join(REPO, 'nunt.exe'), ['-d', dataDir], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      TMP: path.join(REPO, '.gocache', 'tmp'),
      TEMP: path.join(REPO, '.gocache', 'tmp'),
    }),
  });
  let stdout = '';
  let stderr = '';
  let password = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!password) {
      const m = /Administrator pass\s*:\s*(\S+)/.exec(stdout);
      if (m) password = m[1];
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (password) {
      try { const res = await fetch(BASE + '/healthz'); if (res.ok) { healthy = true; break; } } catch (err) { /* 等待 */ }
    }
    await sleep(200);
  }
  if (!healthy) throw new Error('服务没有就绪：' + stdout + stderr);

  let login = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  let loginData = await login.json();
  let cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])[0] || '';
  if (loginData.mustChangePassword) {
    const next = 'kit-smoke-admin-2024';
    await fetch(BASE + '/api/v1/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0], 'X-CSRF-Token': loginData.csrf },
      body: JSON.stringify({ current: password, new: next }),
    });
    login = await fetch(BASE + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: next }),
    });
    loginData = await login.json();
    cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])[0] || '';
  }
  const sessionValue = cookie.split(';')[0].split('=').slice(1).join('=');

  const browser = await chromium.launch({ headless: true });
  globalThis.__browser = browser;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' });
  await context.addCookies([{ name: 'nunt_session', value: sessionValue, domain: '127.0.0.1', path: '/' }]);
  await context.addInitScript(() => {
    try { localStorage.setItem('nunt.session', '1'); localStorage.setItem('nunt.theme', 'dark'); } catch (err) { /* 忽略 */ }
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const external = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('request', (req) => {
    if (!req.url().startsWith(BASE) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) external.push(req.url());
  });

  const steps = [];
  const record = (name, ok, detail) => { steps.push({ step: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); };

  await page.goto(BASE + '/#/notify', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 20000 });
  await page.waitForTimeout(900);
  record('打开通知页', await page.locator('nunt-table').count() > 0);

  // 新建 → 空名字直接保存，应显示字段错误
  await page.click('.card-header sl-button:has-text("新建 Webhook")');
  await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });
  await page.waitForTimeout(400);
  record('对话框打开', await page.locator('sl-dialog[open] nunt-form').count() > 0);
  await page.click('sl-dialog[open] sl-button:has-text("保存")');
  await page.waitForTimeout(400);
  const nameError = await page.locator('sl-dialog[open] .nunt-field-hint.is-error').first().textContent().catch(() => '');
  record('空名称校验', String(nameError || '').includes('请填写名称'), nameError);
  await page.screenshot({ path: path.join(OUT, 'notify-dialog.png') });

  // 填表单 → 保存
  await fillField(page, 'sl-dialog[open]', 'name', '冒烟测试通知');
  await fillField(page, 'sl-dialog[open]', 'url', 'https://example.com/hooks/kit-smoke');
  await page.click('sl-dialog[open] sl-button:has-text("保存")');
  await page.waitForTimeout(1200);
  const rowsAfterSave = await page.locator('.nunt-table tbody tr').count();
  const toastCount = await page.locator('.sl-toast-stack sl-alert').count();
  record('保存后表格出现 1 行', rowsAfterSave === 1, 'rows=' + rowsAfterSave);
  record('保存后有 toast', toastCount >= 1, 'toasts=' + toastCount);
  await page.screenshot({ path: path.join(OUT, 'notify-saved.png') });

  // 删除 → 确认框 → 行数归零
  await page.click('.nunt-table tbody tr sl-button:has-text("删除")');
  await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });
  await page.waitForTimeout(400);
  const confirmText = await page.locator('sl-dialog[open] .nunt-dialog-text').first().textContent().catch(() => '');
  record('确认框文案', String(confirmText || '').includes('确定要删除'), confirmText);
  await page.click('sl-dialog[open] sl-button:has-text("删除")');
  await page.waitForTimeout(1400);
  const rowsAfterDelete = await page.locator('.nunt-table tbody tr').count();
  record('删除后没有数据行', rowsAfterDelete === 0, 'rows=' + rowsAfterDelete);

  await browser.close();
  child.kill();
  await sleep(400);
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});

  const report = {
    at: new Date().toISOString(),
    steps,
    consoleErrors,
    externalRequests: external,
    screenshots: ['notify-dialog.png', 'notify-saved.png'],
  };
  await fsp.writeFile(path.join(OUT, 'kit-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const ok = steps.every((s) => s.ok) && consoleErrors.length === 0 && external.length === 0;
  process.stdout.write(ok ? 'KIT-SMOKE: PASS\n' : 'KIT-SMOKE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  if (server) { try { server.kill(); } catch (e) { /* 忽略 */ } }
  if (globalThis.__browser) { try { await globalThis.__browser.close(); } catch (e) { /* 忽略 */ } }
  process.stderr.write('kit-smoke 失败：' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
