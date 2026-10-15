#!/usr/bin/env node
/**
 * Shoelace vendor 冒烟测试（阶段 1 的验收工具之一）。
 *
 * 为什么需要它：vendor 进来的 ESM 是一大堆相对导入，少拷一个 chunk、图标路径
 * 写错、或者漏了主题 CSS，都要等真的打开页面才发现。这个脚本用零依赖的静态
 * 文件服务 + 无头 Chromium 把整棵依赖树跑一遍：
 *   - 选中的组件必须都在 customElements 里注册成功；
 *   - 任何 404 / 加载失败的请求都算失败；
 *   - sl-icon 必须真的从本地 vendor 目录取到 SVG；
 *   - 不能出现指向外部的请求（后台 CSP 只允许 self）；
 *   - 顺便截一张图，人能一眼看出样式是否成立。
 *
 * 用法：node scripts/vendor-smoke.mjs [--headed]
 */

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VENDOR = path.join(REPO, 'internal', 'webui', 'assets', 'vendor', 'shoelace');
const OUT = path.join(REPO, 'docs', 'screenshots', 'vendor');

// 需要验证的组件：和 sync-vendor.ps1 的 -Components 对应。
const COMPONENTS = [
  'sl-alert', 'sl-badge', 'sl-breadcrumb', 'sl-breadcrumb-item', 'sl-button', 'sl-button-group',
  'sl-card', 'sl-checkbox', 'sl-details', 'sl-dialog', 'sl-divider', 'sl-drawer', 'sl-dropdown',
  'sl-format-bytes', 'sl-format-date', 'sl-format-number', 'sl-icon', 'sl-icon-button', 'sl-input',
  'sl-menu', 'sl-menu-item', 'sl-menu-label', 'sl-option', 'sl-popup', 'sl-progress-bar', 'sl-radio',
  'sl-radio-group', 'sl-relative-time', 'sl-select', 'sl-skeleton', 'sl-spinner', 'sl-switch',
  'sl-tab', 'sl-tab-group', 'sl-tab-panel', 'sl-tag', 'sl-textarea', 'sl-tooltip', 'sl-visually-hidden',
];

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN" class="sl-theme-dark">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>vendor smoke</title>',
  '<link rel="stylesheet" href="./themes/light.css">',
  '<link rel="stylesheet" href="./themes/dark.css">',
  '<style>body{font-family:system-ui,sans-serif;padding:24px;background:var(--sl-color-neutral-0);color:var(--sl-color-neutral-900)}',
  'section{margin-bottom:18px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}</style>',
  '</head>',
  '<body>',
  '<section>',
  '  <sl-button variant="primary">主按钮</sl-button>',
  '  <sl-button variant="danger" outline>删除</sl-button>',
  '  <sl-button size="small" loading>加载中</sl-button>',
  '  <sl-icon-button name="pencil" label="编辑"></sl-icon-button>',
  '  <sl-badge variant="success">成功</sl-badge>',
  '  <sl-tag variant="warning" size="small">标签</sl-tag>',
  '</section>',
  '<section>',
  '  <sl-input label="名称" value="demo" help-text="帮助文本" style="width:200px"></sl-input>',
  '  <sl-select label="模式" value="a" style="width:170px">',
  '    <sl-option value="a">检测模式</sl-option>',
  '    <sl-option value="b">拦截模式</sl-option>',
  '  </sl-select>',
  '  <sl-switch checked>启用</sl-switch>',
  '  <sl-checkbox checked>同意</sl-checkbox>',
  '  <sl-radio-group label="协议" value="tcp">',
  '    <sl-radio value="tcp">TCP</sl-radio>',
  '    <sl-radio value="udp">UDP</sl-radio>',
  '  </sl-radio-group>',
  '  <sl-textarea label="备注" rows="2" style="width:200px"></sl-textarea>',
  '</section>',
  '<section>',
  '  <sl-alert variant="warning" open style="width:300px">这是一条告警</sl-alert>',
  '  <sl-alert variant="primary" toast open style="width:260px">这是一条 toast</sl-alert>',
  '  <sl-spinner style="font-size:1.5rem"></sl-spinner>',
  '  <sl-progress-bar value="40" style="width:170px"></sl-progress-bar>',
  '  <sl-skeleton style="width:110px"></sl-skeleton>',
  '</section>',
  '<section>',
  '  <sl-icon name="gear"></sl-icon>',
  '  <sl-icon name="shield-check"></sl-icon>',
  '  <sl-icon name="folder2-open"></sl-icon>',
  '  <sl-tooltip content="提示内容"><sl-button>悬浮试试</sl-button></sl-tooltip>',
  '  <sl-dropdown>',
  '    <sl-button slot="trigger" caret>下拉</sl-button>',
  '    <sl-menu><sl-menu-item>菜单项一</sl-menu-item><sl-menu-item>菜单项二</sl-menu-item></sl-menu>',
  '  </sl-dropdown>',
  '  <sl-format-bytes value="1234567"></sl-format-bytes>',
  '  <sl-relative-time date="2024-01-01"></sl-relative-time>',
  '</section>',
  '<section>',
  '  <sl-tab-group style="width:400px">',
  '    <sl-tab slot="nav" panel="p1" active>标签一</sl-tab>',
  '    <sl-tab slot="nav" panel="p2">标签二</sl-tab>',
  '    <sl-tab-panel name="p1">第一个面板的内容</sl-tab-panel>',
  '    <sl-tab-panel name="p2">第二个面板的内容</sl-tab-panel>',
  '  </sl-tab-group>',
  '  <sl-details summary="折叠详情" open><p>详情内容</p></sl-details>',
  '  <sl-card style="width:220px"><div slot="header">卡片头</div>卡片内容</sl-card>',
  '  <sl-breadcrumb><sl-breadcrumb-item>首页</sl-breadcrumb-item><sl-breadcrumb-item>设置</sl-breadcrumb-item></sl-breadcrumb>',
  '</section>',
  '<sl-divider></sl-divider>',
  '<sl-dialog label="对话框" open style="--width:300px">对话框内容</sl-dialog>',
  '<sl-drawer label="抽屉" open style="--size:260px">抽屉内容</sl-drawer>',
  '<script type="module">',
  "  import './nunt-shoelace.js';",
  '  window.__SMOKE = { ready: false };',
  "  customElements.whenDefined('sl-button').then(async () => {",
  '    await new Promise((r) => setTimeout(r, 600));',
  "    const icon = document.querySelector('sl-icon');",
  '    const iconSvg = icon && icon.shadowRoot ? icon.shadowRoot.querySelector("svg") : null;',
  "    const button = document.querySelector('sl-button');",
  '    window.__SMOKE = {',
  '      ready: true,',
  '      iconLoaded: !!iconSvg,',
  '      buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : 0,',
  "      spinnerAnimating: !!document.querySelector('sl-spinner').shadowRoot,",
  '    };',
  '  });',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/' || url.pathname === '/smoke.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(PAGE);
        return;
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const full = path.join(VENDOR, rel);
      if (!full.startsWith(VENDOR)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const data = await fsp.readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + req.url);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const headed = process.argv.includes('--headed');
  await fsp.mkdir(OUT, { recursive: true });
  const started = await startServer();
  const base = 'http://127.0.0.1:' + started.port;
  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

  const consoleErrors = [];
  const failed = [];
  const external = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('requestfailed', (req) => failed.push(req.url() + ' ' + (req.failure() ? req.failure().errorText : '')));
  page.on('response', (res) => { if (res.status() >= 400) failed.push(res.status() + ' ' + res.url()); });
  page.on('request', (req) => { if (!req.url().startsWith(base)) external.push(req.url()); });

  await page.goto(base + '/smoke.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SMOKE && window.__SMOKE.ready, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  const smoke = await page.evaluate(() => window.__SMOKE);
  const missing = await page.evaluate(
    (names) => names.filter((n) => !customElements.get(n)),
    COMPONENTS,
  );
  const themeProbe = await page.evaluate(() => {
    const button = document.querySelector('sl-button');
    const style = getComputedStyle(document.documentElement);
    return {
      themeClass: document.documentElement.className,
      primary600: style.getPropertyValue('--sl-color-primary-600').trim(),
      neutral0: style.getPropertyValue('--sl-color-neutral-0').trim(),
      buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : 0,
    };
  });
  await page.screenshot({ path: path.join(OUT, 'shoelace-vendor-smoke.png'), fullPage: true });
  await browser.close();
  started.server.close();

  const ok = !!smoke && smoke.ready === true && missing.length === 0 && smoke.iconLoaded === true &&
    consoleErrors.length === 0 && failed.length === 0 && external.length === 0;
  const report = {
    at: new Date().toISOString(),
    vendorDir: 'internal/webui/assets/vendor/shoelace',
    componentsChecked: COMPONENTS.length,
    missingComponents: missing,
    iconLoaded: smoke ? smoke.iconLoaded : false,
    theme: themeProbe,
    consoleErrors,
    failedRequests: failed,
    externalRequests: external,
    screenshot: 'docs/screenshots/vendor/shoelace-vendor-smoke.png',
    result: ok ? 'PASS' : 'FAIL',
  };
  await fsp.writeFile(path.join(OUT, 'vendor-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write('vendor-smoke 失败：' + ((err && err.stack) || err) + '\n');
  process.exitCode = 1;
});
