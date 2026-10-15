# Shoelace vendor 快照

这个目录是 vendor 进来的第三方代码，不要手改；升级请跑同步脚本。

| 项 | 值 |
| --- | --- |
| 包名 | @shoelace-style/shoelace |
| 构建 | cdn（cdn = 依赖已内联、无裸模块说明符的浏览器直载版） |
| 版本 | 2.20.1（固定版本，不用范围） |
| 许可证 | MIT |
| 来源 URL | https://registry.npmjs.org/@shoelace-style/shoelace/-/shoelace-style-shoelace-2.20.1.tgz |
| 上游仓库 | https://github.com/shoelace-style/shoelace |
| 同步脚本 | scripts/sync-vendor.ps1 |
| 生成时间 | 2026-10-15 16:09:59 |

## 同步与校验命令

    # 方式一：用 package.json 里锁定的版本（需要先 pnpm install）
    pwsh -File scripts/sync-vendor.ps1

    # 方式二：直接从 npm 下载 tgz 解包，不需要 pnpm/node
    pwsh -File scripts/sync-vendor.ps1 -Download

    # 校验（比对下面「校验基线」里的文件数与字节数）
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly

## 目录结构

- nunt-shoelace.js        本仓库生成的入口（import 选中的组件 + setBasePath）
- components/<name>/      组件实现（只包含选中的组件）
- chunks/                 Rollup 共享 chunk（按相对导入闭包裁剪）
- utilities/ internal/    base-path、icon-library 等内部工具
- themes/light.css dark.css  设计 token（浅色在 :root，深色在 .sl-theme-dark）
- assets/icons/*.svg     用到的 Bootstrap Icons 图标

## 组件清单（42 个）

    alert, animation, badge, breadcrumb, breadcrumb-item, button, button-group, card, checkbox, details, dialog, divider, drawer, dropdown, format-bytes, format-date, format-number, icon, icon-button, input, menu, menu-item, menu-label, mutation-observer, option, popup, progress-bar, radio, radio-group, relative-time, resize-observer, select, skeleton, spinner, switch, tab, tab-group, tab-panel, tag, textarea, tooltip, visually-hidden

为什么用 cdn/ 而不是 dist/：

- dist/ 的文件里保留了 from "lit"、from "@shoelace-style/localize" 这类裸模块说明符，
  浏览器无法解析，需要打包器或 import map；
- 后台 CSP 是 script-src 'self'，内联 import map（<script type="importmap">）会被拦截，
  外链 import map 浏览器也还不支持，所以「零构建 + 零 CSP 变更」只剩下唯一一条路：
  用上游已经内联好依赖的 cdn/ 构建；
- 代价：cdn/chunks 比 dist/chunks 大（lit 被内联进 chunk），整棵树 640KiB / gzip 187KiB 量级。

同步脚本会把「树里不允许出现裸模块说明符」当作硬校验，出现即失败。

说明：Shoelace 2.x 没有表格组件（sl-table 不存在），表格继续用原生 <table> + 设计 token；
「toast」也没有独立组件，用 <sl-alert toast> 实现。

## 图标清单（84 个）

    speedometer2, globe, arrow-left-right, arrow-repeat, patch-check, hdd-stack, folder2-open, shield-check, clock-history, bell, journal-text, sliders, plus-lg, pencil, trash, play-fill, pause-fill, arrow-clockwise, download, upload, x-lg, check-lg, search, gear, moon, sun, box-arrow-right, chevron-down, chevron-right, chevron-left, three-dots-vertical, info-circle, exclamation-triangle, check-circle, x-circle, question-circle, clipboard, eye, eye-slash, folder, file-earmark, cloud-arrow-up, terminal, key, person, people, plus-circle, dash-circle, funnel, lock, unlock, exclamation-octagon, link-45deg, lightbulb, lightning-charge, cpu, ethernet, wifi, diagram-3, list-ul, calendar-event, send, share, copy, save, trash3, x, check, folder-plus, file-earmark-arrow-up, arrows-collapse-vertical, signpost-split, shield-lock, server, hdd-network, activity, graph-up, collection, database, usb-drive, box-arrow-in-right, pencil-square, toggle-on, toggle-off

完整图标集（2050 个 SVG）未全部 vendor：那会让仓库和二进制多出约 1.6MB。
需要新图标时把它加到 sync-vendor.ps1 的 -Icons 列表后重跑；要整套就加 -AllIcons。

## 体积

| 范围 | 文件数 | 未压缩 | gzip 估算 |
| --- | --- | --- | --- |
| 整个 vendor/shoelace | 285 | 655202 字节（639.8 KiB） | 191435 字节（186.9 KiB） |
| 其中 components/ | 42 | 30770 字节 | 9981 字节 |
| 其中 assets/icons/ | 84 | 45598 字节 | 26142 字节 |

## 校验基线（-VerifyOnly 比对用，请勿手工修改）

version=2.20.1
files=285
bytes=655202
gzip=191435
icons=84
components=42
generated=2026-10-15T16:09:59+08:00
