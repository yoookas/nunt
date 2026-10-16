// 组件入口：核心（每一个页面与外壳都会用到）。
//
// 为什么要有 lib/components/*
//   vendor/shoelace/nunt-shoelace.js（由 scripts/sync-vendor.ps1 生成）把 42 个组件一次性注册，
//   于是登录页首屏也要为整套组件付 217 个请求 / 361 KB 的代价。vendor 不能改（会被同步脚本覆盖），
//   所以在我们自己的 assets 下按域拆成若干个入口模块，**谁用到谁 import**：
//     core（本文件）→ shell / table / form / feedback / tabs / progress / daterange
//   登录页与外壳只引 shell 入口，12 个页面各自引自己需要的入口（页面本来就是动态 import）。
//
// 两条规矩：
//   1. 只 import 真正用到的组件；Shoelace 的 vendor 包是自包含的，每个组件文件会自己带上依赖的 chunk
//      （例如 sl-tag 会自己把 sl-icon-button 拉进来），我们不需要替它补依赖；
//   2. 组件必须在**创建元素之前**注册。本模块是同步 import，页面模块顶部的 `import '../lib/components/…'`
//      会先执行完，之后 Lit 的首次渲染才会 createElement('sl-*')。
import { setBasePath } from '../../vendor/shoelace/utilities/base-path.js';
import '../../vendor/shoelace/components/icon/icon.js';
import '../../vendor/shoelace/components/icon-button/icon-button.js';
import '../../vendor/shoelace/components/badge/badge.js';
import '../../vendor/shoelace/components/button/button.js';
import '../../vendor/shoelace/components/spinner/spinner.js';
import '../../vendor/shoelace/components/alert/alert.js';
// 不在这里注册 sl-tooltip / sl-popup：nunt 的模板里没有 <sl-tooltip>，它们只是给
// Shoelace 自己的 tooltip 指令用的可选依赖，一并在首屏注册要多花约 15 KB br
// （实测：core 由 55 个模块降到 47 个）。哪天有页面真的要用，import 这个入口即可。

// sl-icon 的图标走本地 vendor 目录（零外部请求，符合 CSP）。
setBasePath(new URL('../../vendor/shoelace/', import.meta.url).pathname);

export { setBasePath };
