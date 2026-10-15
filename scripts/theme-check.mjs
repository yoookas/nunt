#!/usr/bin/env node
/**
 * 主题与窄屏外壳的补充验证（阶段 1）：
 *   1. 浅色主题：<html> 上应是 sl-theme-light，token 生效，notify 页截图 + axe 扫描；
 *   2. 点一次主题按钮：应切回 sl-theme-dark（验证切换逻辑本身）；
 *   3. 窄屏（420x900）：侧边栏收进 sl-drawer，点菜单按钮后抽屉打开并截图。
 * 输出：docs/screenshots/phase1/light-notify.png、narrow-drawer.png、theme-check.json
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
const OUT = path.join(REPO, 'docs', 'screenshots', 'phase1');
const PORT = 16601;
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
  const dataDir = path.join(REPO, '.gocache', 'theme-check', String(Date.now()));
  await fsp.mkdir(path.join(REPO, '.gocache', 'tmp'), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  for (let i = 0; i < 40; i += 1) { if (await portFree(PORT)) break; await sleep(1000); }

  const child = spawn(path.join(REPO, 'nunt.exe'), ['-d', dataDir], {
    cwd: REPO,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      TMP: path.join(REPO, '.gocache', 'tmp'),
      TEMP: path.join(REPO, '.gocache', 'tmp'),
    }),
  });
  let stdout = '';
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
  let stderr = '';
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

  // API 登录（必要时按强制改密流程换密码），拿会话 cookie。
  let login = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  let loginData = await login.json();
  let cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])[0] || '';
  if (loginData.mustChangePassword) {
    const next = 'phase1-admin-2024';
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

  // 造一条 Webhook，让 notify 页的表格/徽标/标签真的渲染出来（否则浅色主题只扫得到空状态）。
  await fetch(BASE + '/api/v1/notify/webhooks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie.split(';')[0], 'X-CSRF-Token': loginData.csrf },
    body: JSON.stringify([{
      id: '',
      name: '主题检查用通知',
      enable: true,
      url: 'https://example.com/hooks/theme-check',
      method: 'POST',
      headers: { 'X-Demo-Token': 'demo' },
      events: ['system.alert', 'ddns.error'],
    }]),
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', colorScheme: 'dark' });
  await context.addCookies([{ name: 'nunt_session', value: sessionValue, domain: '127.0.0.1', path: '/' }]);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nunt.theme', 'light');
      localStorage.setItem('nunt.session', '1');
    } catch (err) { /* 忽略 */ }
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const external = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('request', (req) => { if (!req.url().startsWith(BASE) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) external.push(req.url()); });

  await page.goto(BASE + '/#/notify', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const rows = await page.evaluate(() => document.querySelectorAll('.nunt-table tbody tr').length);
  const lightProbe = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      htmlClass: document.documentElement.className,
      neutral0: style.getPropertyValue('--sl-color-neutral-0').trim(),
      bg: style.getPropertyValue('--bg').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      navActiveColor: getComputedStyle(document.querySelector('.app-nav-item[aria-current="page"]')).color,
    };
  });
  await page.screenshot({ path: path.join(OUT, 'light-notify.png'), fullPage: true });
  await page.evaluate(AXE_SOURCE);
  const lightA11y = await page.evaluate(async (tags) => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of result.violations) counts[v.impact] = (counts[v.impact] || 0) + v.nodes.length;
    return {
      counts,
      violations: result.violations.map((v) => v.id + ':' + v.impact + ':' + v.nodes.length + '  ' +
        v.nodes.slice(0, 3).map((n) => (n.target || []).join(' ')).join(' | ')),
    };
  }, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']);

  // 点主题按钮：应切回深色
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  const toggledClass = await page.evaluate(() => document.documentElement.className);

  // 窄屏：抽屉
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(400);
  const sidebarHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.app-sidebar')).display);
  await page.click('#menuBtn');
  await page.waitForTimeout(700);
  const drawerOpen = await page.evaluate(() => {
    const drawer = document.querySelector('#navDrawer');
    return { exists: !!drawer, open: drawer ? drawer.open === true : false, navInside: !!(drawer && drawer.querySelector('.app-nav-item')) };
  });
  await page.screenshot({ path: path.join(OUT, 'narrow-drawer.png'), fullPage: false });

  await browser.close();
  child.kill();
  await sleep(500);
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});

  const report = {
    at: new Date().toISOString(),
    notifyRows: rows,
    light: lightProbe,
    toggledClassAfterClick: toggledClass,
    lightA11y,
    narrow: { sidebarDisplay: sidebarHidden, drawer: drawerOpen },
    consoleErrors,
    externalRequests: external,
    screenshots: ['light-notify.png', 'narrow-drawer.png'],
  };
  await fsp.writeFile(path.join(OUT, 'theme-check.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const ok = lightProbe.htmlClass.includes('sl-theme-light') && toggledClass.includes('sl-theme-dark') &&
    lightA11y.counts.critical === 0 && consoleErrors.length === 0 && external.length === 0 &&
    drawerOpen.open === true && drawerOpen.navInside === true && sidebarHidden === 'none';
  process.stdout.write(ok ? 'THEME-CHECK: PASS\n' : 'THEME-CHECK: FAIL\n');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write('theme-check 失败：' + ((err && err.stack) || err) + '\n');
  process.exitCode = 1;
});
