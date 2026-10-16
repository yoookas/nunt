# nunt 前端迁移最终报告（阶段 0 → 阶段 3）

> 迁移计划见 [PLAN-frontend-webcomponents.md](PLAN-frontend-webcomponents.md)（阶段 0–3 的完成状态已标注），
> 接口、kit 导出清单、测试口径与已知限制见 [CONTRACT.md 第 7 节](CONTRACT.md)。
> 本文的数字都来自仓库里的脚本产物：
> docs/screenshots/{before,phase1,phase2a,phase2b,phase2c,phase2d,phase3}/ 下的 baseline.json / a11y.json / REPORT.md，
> 以及 docs/screenshots/phase3/ui-smoke/ui-smoke.json（浅色主题 66 个检查点）。
> 复现命令见第 7 节。

## 1. 结论

| 项目 | 结果 |
| --- | --- |
| 页面迁移 | 12/12 页全部从手写 DOM 层迁到 Shoelace + Lit + 自研 kit（外壳、登录页、kit 在阶段 1 完成） |
| axe（深色 + 浅色，四档） | **critical 0 / serious 0 / moderate 0 / minor 0**（阶段 0 基线：26 / 110 / 188 / 7） |
| 运行时健康度（12 页） | console 报错 0、未捕获异常 0、失败请求 0、HTTP 4xx·5xx 0、外部请求 0、横向溢出 0 |
| 交互冒烟 | 66 个检查点全部通过（浅色主题，每页至少一条真实交互） |
| 整棵资源树（相对阶段 2 结束） | 原始 **−5,562 字节**、gzip +1,039、br(q6) +707（阶段 3 净减） |
| 整棵资源树（相对真正的迁移前 17 文件） | 原始 +668,670（+122.9%）、gzip +205,773、br(q6) +183,901 —— 增量几乎全是 vendor 组件层（+682,330 原始 / +186,060 br），**自有代码净减 13,660 原始 / 2,159 br** |
| 首屏传输（服务端 br 协商实测） | 登录页首屏 361,729 字节（217 个请求，含响应头），登录 + 外壳 +29 KB，再切一个页面 +21 KB |
| 构建链 | 仍然无 npm：`go:embed` 单二进制，CSP 未改，零外部请求 |
| 页面契约 | `export default { id, title, icon, mount(root, ctx) }` 与 `ctx` 语义未变，`lib/api.js` 未改 |

一句话：**迁移没有省字节，省的是缺陷**。自有代码（12 页 + 外壳 + 样式，含新增 52 KB 的 kit.js）比迁移前小了 13.7 KB，
换来的是 186 KB（br）的一次性组件层成本、两个主题下 0 条 axe 违规，以及第 6 节那 18 个真实缺陷的消失。

## 2. 最终技术栈

| 层 | 内容 | 版本 / 体量 |
| --- | --- | --- |
| 组件库 | Shoelace（vendor 在 `internal/webui/assets/vendor/shoelace/`） | 2.20.1（MIT），42 个组件、285 个文件、655,202 字节 |
| 组件编写层 | Lit（`vendor/lit/`） | 3.3.3（MIT），11 个文件、20,795 字节 |
| 自研共享层 | `assets/lib/kit.js`：表格 / 表单 / 标签输入 / 键值编辑 / 对话框 / 提示 / 状态块 / 卡片容器约定 | 52,428 字节原始、14,190 字节 br |
| 外壳 | `assets/app.js`：hash 路由、页面清单、动态 import、登录页、侧栏/顶栏/窄屏抽屉、SSE、主题 | 33,358 字节原始、9,101 字节 br |
| 样式 | `assets/style.css`：1 主题 token 映射、2 基础排版、3 外壳、4 kit + 容器类、5 登录页 | **519 行 / 18,469 字节**（阶段 0：712 行 / 24,099 字节；阶段 2 结束：748 行 / 30,904 字节） |
| 页面 | `assets/pages/*.js`（12 个），一律 NuntElement 子类 + Lit 模板 + kit | 388,924 字节原始合计 |
| 主题 | `<html>` 上的 `sl-theme-dark` / `sl-theme-light`，nunt 语义变量全部是 Shoelace token 的别名 | 深/浅两套都在 `style.css` 第 1 节 |

vendor 同步与校验：`pwsh -File scripts/sync-vendor.ps1 [-VerifyOnly]`、`pwsh -File scripts/sync-lit.ps1 [-VerifyOnly]`。
两者在阶段 3 的复验输出都是 `[ok]`（285 文件 / 655,202 字节 与 `VERSION.md` 记录一致；lit 11 文件 / 20,795 字节一致）。

## 3. 体积对比

### 3.1 整棵前端资源树（`internal/webui/assets`）

口径：原始 = 文件字节；gzip = zlib level 9；br = brotli（默认 q6，另给 q11 参考）；每个历史点都用同一套脚本重测。

| 状态（提交） | 文件 | 原始 | gzip | br q6 | br q11 |
| --- | --- | --- | --- | --- | --- |
| **阶段 0：迁移前**（6769207） | 17 | **544,273** | **162,981** | **150,714** | 137,656 |
| 阶段 0 记录值（before/REPORT.md 第 7 节，含 vendor 的中间态） | 303 | 1,203,945 | 357,727 | 328,996 | — |
| 阶段 1 结束（bf19d7e） | 316 | 1,291,599 | 387,371 | 355,327 | 328,374 |
| 阶段 2A（5bb6203） | 316 | 1,282,385 | 385,701 | 353,296 | 326,379 |
| 阶段 2B（f736005） | 316 | 1,263,721 | 381,667 | 348,471 | 322,093 |
| 阶段 2C（d6fef66） | 316 | 1,246,291 | 375,954 | 342,010 | 316,834 |
| 阶段 2D = 阶段 2 结束（aa7a186） | 316 | 1,218,505 | 367,715 | 333,908 | 309,269 |
| **阶段 3（工作区）** | 316 | **1,212,943** | **368,754** | **334,615** | 310,049 |

两个对照口径（避免歧义，都列出来）：

| 对照 | Δ 文件 | Δ 原始 | Δ gzip | Δ br q6 |
| --- | --- | --- | --- | --- |
| 阶段 3 − 阶段 2 结束（本批净变化） | 0 | **−5,562**（−0.5%） | +1,039（+0.3%） | +707 |
| 阶段 3 − 阶段 0 记录值（303 文件口径，历史批次一直引用） | +13 | +8,998（+0.7%） | +11,027（+3.1%） | +5,619（+1.7%） |
| 阶段 3 − 真正的迁移前（17 文件，无 vendor） | +299 | +668,670（+122.9%） | +205,773（+126.3%） | +183,901（+122.0%） |

分解（阶段 3 的 316 个文件）：

| 组成 | 文件 | 原始 | br q6 | 说明 |
| --- | --- | --- | --- | --- |
| vendor 组件层（Shoelace + Lit，不含图标/主题） | 212 | 597,764 | 155,150 | 阶段 1 一次性引入 |
| vendor 图标 | 84 | 45,598 | 23,389 | 按需 fetch，登录页只用到 1 KB |
| vendor 主题 CSS（light/dark） | 2 | 38,968 | 7,521 | index.html 直接引入 |
| **vendor 小计** | **298** | **682,330** | **186,060** | |
| 自有代码（index.html/style.css/app.js/lib/*） | 6 | 141,689 | 39,556 | 含新增 kit.js |
| 自有代码（pages/*.js） | 12 | 388,924 | 108,999 | 12 个页面 |
| **自有代码小计** | **18** | **530,613** | **148,555** | 阶段 0 是 544,273 / 150,714 → **−13,660 / −2,159** |

### 3.2 逐文件（阶段 0 → 阶段 3）

| 文件 | 原始 0 | 原始 3 | Δ原始 | br 0 | br 3 | Δbr |
| --- | --- | --- | --- | --- | --- | --- |
| index.html | 988 | 1,408 | +420 | 478 | 713 | +235 |
| style.css | 24,099 | 18,469 | **−5,630** | 5,468 | 5,140 | −328 |
| app.js | 29,447 | 33,358 | +3,911 | 7,374 | 9,101 | +1,727 |
| lib/api.js | 6,975 | 6,975 | 0 | 2,297 | 2,297 | 0 |
| lib/ui.js | 29,051 | 29,051 | 0 | 8,115 | 8,115 | 0 |
| lib/kit.js（阶段 1 新增） | — | 52,428 | +52,428 | — | 14,190 | +14,190 |
| pages/dashboard.js | 14,717 | 24,101 | +9,384 | 3,834 | 6,521 | +2,687 |
| pages/notify.js | 8,360 | 9,733 | +1,373 | 2,494 | 3,291 | +797 |
| pages/logs.js | 9,247 | 16,262 | +7,015 | 2,657 | 5,370 | +2,713 |
| pages/storage.js | 14,346 | 21,492 | +7,146 | 3,623 | 6,158 | +2,535 |
| pages/files.js | 41,287 | 19,526 | −21,761 | 12,087 | 5,541 | −6,546 |
| pages/settings.js | 25,438 | 31,473 | +6,035 | 5,472 | 7,896 | +2,424 |
| pages/forward.js | 38,288 | 21,109 | −17,179 | 11,682 | 6,480 | −5,202 |
| pages/task.js | 42,742 | 27,374 | −15,368 | 12,455 | 7,721 | −4,734 |
| pages/ddns.js | 49,657 | 40,357 | −9,300 | 14,298 | 11,759 | −2,539 |
| pages/acme.js | 47,887 | 41,353 | −6,534 | 13,834 | 11,074 | −2,760 |
| pages/web.js | 59,706 | 52,566 | −7,140 | 17,410 | 15,355 | −2,055 |
| pages/waf.js | 102,115 | 83,578 | −18,537 | 27,192 | 21,833 | −5,359 |
| **合计（阶段 0 与现在都存在的前 17 个文件 + kit.js 不计）** | 544,350 | 478,185 | **−66,165** | 150,770 | 134,365 | **−16,405** |

两个批次里变大的页面（dashboard / logs / storage / settings / notify）原本是「纯命令式 DOM + 自己那套 el()」，
换成 Lit 组件类必然变大（各 +1.4 ~ +9.4 KB）；变小的是原本各自带着整套自包含兜底的页面
（files −21.8 KB、waf −18.5 KB、forward −17.2 KB、task −15.4 KB）。

阶段 3 这一批只动了 8 个资源文件（其余 308 个与阶段 2 结束逐字节相同）：

| 文件 | Δ原始 | Δgzip | Δbr |
| --- | --- | --- | --- |
| style.css（删掉第 6 节遗留层 12,435 字节，补进容器类） | **−12,435** | −1,954 | −1,918 |
| app.js（删掉一行 modal-open 遗留清理） | −48 | −26 | −22 |
| lib/kit.js（nunt-tags 的 label、sl-dialog landmark 运行时补丁） | +2,674 | +1,144 | +540 |
| pages/web.js（限速 / 请求体上限 + 只读字段剥离） | +2,109 | +767 | +688 |
| pages/acme.js（密钥类型对齐后端取值） | +859 | +429 | +386 |
| pages/ddns.js（失败计数字段、未启用规则提示） | +737 | +387 | +776 |
| pages/forward.js（访问日志来源字段别名） | +278 | +152 | +137 |
| pages/settings.js（两个字段换回 nunt-tags） | +264 | +140 | +120 |
| **合计** | **−5,562** | **+1,039** | **+707** |

> gzip 比原始略涨是因为删掉的是高度可压缩的 CSS（12.4 KB 原始只值 1.9 KB gzip），
> 补进来的 JS（中文注释与模板字面量）压缩率低。服务端实际协商的是 br，因此看 br 列更准。

## 4. axe 对比（12 页逐页，四档）

口径：axe-core 4.14.0，规则标签 `wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice`，
视口 1440x900，每页整页扫描（对话框关闭状态）；每批的数字都取自对应目录的 a11y.json。

| 页面 | 阶段 0 | 阶段 1 | 阶段 2A | 阶段 2B | 阶段 2C | 阶段 2D | **阶段 3** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #/dashboard | 1/28/22/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/web | 1/5/23/1 | 0/0/1/1 | 0/0/1/1 | 0/0/1/1 | 0/0/1/1 | 0/0/0/0 | **0/0/0/0** |
| #/forward | 1/5/12/1 | 0/0/1/1 | 0/0/1/1 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/ddns | 1/5/14/1 | 0/0/1/1 | 0/0/1/1 | 0/0/1/1 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/acme | 1/6/14/1 | 0/0/1/1 | 0/0/1/1 | 0/0/1/1 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/storage | 1/6/10/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/files | 2/4/22/1 | 1/0/1/1 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/waf | 9/14/34/1 | 8/0/1/1 | 8/0/1/1 | 8/0/1/1 | 8/0/1/1 | 0/0/0/0 | **0/0/0/0** |
| #/task | 1/5/13/1 | 0/0/1/1 | 0/0/1/1 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/notify | 1/6/11/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/logs | 1/17/9/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| #/settings | 6/9/4/0 | 5/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** |
| **合计（critical/serious/moderate/minor）** | **26/110/188/7** | 14/0/7/7 | 8/0/6/6 | 8/0/4/4 | 8/0/2/2 | 0/0/0/0 | **0/0/0/0** |

除了深色主题的 12 页，阶段 3 还补了两类扫描：

- **浅色主题**：`scripts/ui-smoke.mjs` 对 12 页各扫一次，四档全 0（66 个检查点里的 13 条）；
- **对话框打开状态**：Web 页的「新建规则」对话框打开时，sl-dialog 带来的
  `landmark-no-duplicate-banner` / `landmark-unique` 已经归零（kit 的运行时补丁，见第 6 节）；
  仍然只剩 axe 对「滚出对话框视口的控件」的 `label-title-only` 误判（与滚动位置相关，12 页页面级扫描不受影响）。

## 5. 首屏传输字节（服务端 br 协商实测）

方法：真实二进制 + 无头 Chromium 冷缓存，记录每个响应的 `Request.sizes()`（**编码后 body + 响应头**），
再用 `fetch` 对同一批 URL 分别按 `Accept-Encoding: br / identity` 取 `Content-Length` 交叉核对。

| 场景 | 请求数 | 传输字节 | 其中 body |
| --- | --- | --- | --- |
| A 登录页首屏（未登录：HTML + 主题 CSS + 外壳 JS + vendor 依赖） | 217 | 361,729 | 199,207 |
| B 登录动作 + 进入外壳（增量） | 17 | 28,976 | — |
| C 外壳内切到 #/web（只算新增的模块与接口） | 6 | 21,118 | 16,858 |
| **合计（登录 → 外壳 → 打开一个页面）** | 240 | **411,823** | — |

A 组的构成：自有代码 44,032、vendor 组件层 307,664、vendor 图标 1,026、主题 CSS 9,007
（登录页会一次性拉起整套 sl-* 组件，因此 217 个请求里绝大多数是 vendor 的 chunk）。

C 组的 6 个请求：`/pages/web.js`（15,355）、`/api/v1/web/rules`（516）、
4 个行内图标（plus-lg / journal-text / pencil-square / trash，共 987）。

主要静态资源的 br 字节（服务端实测）：

| 资源 | br 字节 |
| --- | --- |
| /vendor/shoelace/themes/light.css | 3,791 |
| /vendor/shoelace/themes/dark.css | 3,730 |
| /style.css | 5,140 |
| /app.js | 9,101 |
| /lib/ui.js | 8,115 |
| /lib/kit.js | 14,190 |
| /lib/api.js | 2,297 |
| /pages/web.js | 15,355 |
| vendor chunk 里最大的一个（chunk.NDC2Y3JV.js） | 12,906 |

交叉核对：同一批 231 个静态 URL，`identity` 合计 854,686 字节，`br` 合计 223,978 字节，**省 73.8%**
（Content-Encoding 分布：231 个 br、9 个 identity，identity 全是 API 的 JSON）。

> 阶段 0 对照：迁移前的首屏只有 `index.html + style.css + app.js + lib/*.js`（br 合计约 25 KB），
> 没有任何 vendor。现在的 361 KB 里 88% 是组件层 —— 这正是 PLAN 第 1 节第 5 条接受的那个取舍：
> 「更大但更可靠」。压缩、ETag/304 与内存缓存让这份成本只付一次（同一进程内不重复压缩）。

## 6. 迁移期间修掉的真实缺陷

### 6.1 阶段 0 视觉 / 无障碍缺陷 → 现状

| 阶段 0 的问题（before/REPORT.md 第 6 节） | 现状 |
| --- | --- |
| 7 个页面的卡片标题渲染成字面量 `h3`（标题丢失） | 12 页统一 `<h2>` 卡片标题；axe 的 `heading-order` 归零 |
| 顶栏 / 侧栏 / 概览的版本号显示 `[object Object]` | kit 的 `versionText()` 统一取值，三处都是 `dev` |
| files 页把后端 `404 page not found` 原文摊在界面上 | kit 的 `friendlyMessage()`：404 → 「接口不存在或对应模块未启用（HTTP 404）」 |
| 表格列宽失衡：状态列竖排、操作列被裁切、空 `<th>` | `nunt-table` 的 `actions` 列（右对齐、不换行、包在 `.nunt-actions`）+ 列宽提示；`empty-table-header` 归零 |
| 主题切换按钮没有可访问名称（12 页 `button-name` critical） | 外壳的 `sl-icon-button` 带 `label`；12 页 critical 归零 |
| 对比度不足 110 处 | kit 组件只用语义 token（`--text-dim/--text-faint` 逐处校准）；serious 归零 |
| 下拉框/输入框没有可访问名称（`select-name/label` critical） | formGrid 把标签交给 `sl-input/sl-select/sl-textarea` 的 `label`，控件与标签天然关联 |
| 没有 `<h1>`、没有 `main` landmark、内容不在 landmark 里（`region` 188 处） | 外壳顶栏就是 `<h1>` + `<main id="content">`；moderate 归零 |

### 6.2 真实功能缺陷清单（迁移期间定位并修掉）

| # | 缺陷 | 影响 | 出处 / 修法 |
| --- | --- | --- | --- |
| 1 | 7 个页面把 `h3` 渲染成字面量文本 | 卡片标题全丢 | 阶段 1 前 423d59d（本地 `el()` 的 `/^[a-zA-Z]+$/` 不接受数字） |
| 2 | 版本号 `[object Object]` | 三处界面显示错误 | 阶段 1，kit `versionText()` |
| 3 | files 页把 `404 page not found` 原文摊开 | 误导用户 | 阶段 2A，kit `friendlyMessage()` |
| 4 | **代理规则从来存不下来**：提交 `disableCompres`，后端 JSON tag 是 `disableCompression`，`DisallowUnknownFields` 直接 400 | 整条反代规则无法保存 | 阶段 2D，改成后端认识的键名 |
| 5 | 负载均衡取值全不被后端接受（`round_robin/ip_hash/least_conn`） | 新建反代规则默认值就是 `round_robin` → 必然 400 | 阶段 2D，对齐 `roundrobin/random/iphash`，读回旧值按别名归一 |
| 6 | WAF 请求测试多带 `path` 别名 | `POST /api/v1/waf/test` 必 400 | 阶段 2D，只提交 `method/url/body` |
| 7 | BasicAuth「密码留空」被当成删用户 | 保存被拒（enabled without users） | 阶段 2D，按后端语义「留空 = 保留原哈希」做成账号列表 |
| 8 | 页面成员方法名遮蔽 `HTMLElement.remove()` | 页面卸载时报 TypeError、DOM 残留 | 阶段 2B，改名 `removeRule/removeMount/removeTask` |
| 9 | sl-switch 只有 `title`/`aria-label`，没有可见标签 | axe `label-title-only` serious（每行一个） | 阶段 2B，状态文字放进开关的可见标签 |
| 10 | 对话框页脚按钮依赖 `onMount` 时序（`show()` 可能同步 resolve） | 「测试连接」按钮根本没插进页脚 | 阶段 2B，改为 `openDialog` 返回后直接操作 `api.footer` |
| 11 | **ACME 密钥类型下拉给的是 `ecdsa`**，后端 `normalizeKeyType` 只认 `ec256/ec384/rsa2048/rsa4096` | 选 ECDSA 必 400（阶段 2C 记录、阶段 3 修） | 阶段 3：选项改成后端取值，默认 `ec256`，历史值 `ecdsa`/`''` 归一 |
| 12 | DDNS 运行状态读 `fail/failCount`，后端字段是 `failures` | 「失败」次数永远是 0 | 阶段 3：真实字段提到回退链最前（冒烟用桩数据断言显示 7） |
| 13 | 未启用规则点「立即执行」提示「执行成功」 | 后端是静默 no-op 却回 `ok:true`，用户以为真的执行了 | 阶段 3：按启用状态提示「该规则未启用，已跳过」，且不再发出这次请求 |
| 14 | web 状态开关的 PUT 回退会回传只读字段（`active/upstreams/requests/configError`） | `DisallowUnknownFields` → 400，切换失败 | 阶段 3：`writableRule()` 剥离只读字段后再 PUT |
| 15 | forward 访问日志的来源字段名是 `client`，页面只认 `src/source/clientAddr/remoteAddr` | 来源列永远显示 `-` | 阶段 3：真实字段提到最前（截图里能看到 `127.0.0.1:53381 -> 127.0.0.1:12231`） |
| 16 | 转发日志对话框永远是空态（演示数据没有真实流量） | 无法验证日志渲染 | 阶段 3：演示数据补一条真实 TCP 连接（本机回显服务 + 断言日志字段齐全） |
| 17 | sl-dialog 的阴影 `<header>` 造成两条 landmark 误报 | 对话框一打开 axe 报 moderate | 阶段 3：kit 的 `openDialog()` 运行时把该 header 降级为 `role="presentation"`（不改 vendor） |
| 18 | `nunt-tags` 内层 `sl-input` 没有可见标签 | axe `label-title-only` serious | 阶段 3：给 `nunt-tags` 加 `label`（转交内层 `sl-input`），settings 页两个字段换回标签输入 |

> 另外，PLAN 第 0 节列出的「手写组件层已出过 5 个真实缺陷」（`r.routeOf` 崩溃、formGrid 默认值丢失、
> 弹窗 TDZ、顶栏版本不刷新、`navigate` 不触发路由）随阶段 1 的外壳重写一起不复存在 —— 那 5 条是这次迁移的起因。

## 7. 截图索引

| 目录 | 内容 |
| --- | --- |
| [before/](screenshots/before/) | 阶段 0 基线：`login.png` + 12 页整页截图（深色）、`REPORT.md`（含人工视觉复核清单）、`a11y.json`、`baseline.json`、`VISUAL-REVIEW.md` |
| [phase1/](screenshots/phase1/) | 外壳与首屏迁移后：`login.png` + 12 页、`light-notify.png`、`narrow-drawer.png`、`notify-dialog.png`、`notify-saved.png`、`kit-smoke.json`、`theme-check.json`、`PHASE1-NOTES.md` |
| [phase2a/](screenshots/phase2a/) | dashboard / settings / files 迁移后：12 页深色截图 + `light-dashboard.png`、`light-settings.png`、`light-files.png`、`pages-smoke.json`、`PHASE2A-NOTES.md` |
| [phase2b/](screenshots/phase2b/) | logs / storage / forward / task：+ `light-{logs,storage,forward,task}.png`、`PHASE2B-NOTES.md` |
| [phase2c/](screenshots/phase2c/) | ddns / acme：+ `light-{ddns,acme}.png` 与其对话框截图、`PHASE2C-NOTES.md` |
| [phase2d/](screenshots/phase2d/) | web / waf：+ `light-{web,waf}.png`、`light-web-dialog.png`、`PHASE2D-NOTES.md` |
| [phase3/](screenshots/phase3/) | 阶段 3 终验：`login.png` + 12 页深色截图、`REPORT.md`、`a11y.json`、`baseline.json`（演示数据 13/13 成功，含真实 TCP 转发连接） |
| [phase3/ui-smoke/](screenshots/phase3/ui-smoke/) | 浅色主题冒烟：`light-<page>.png` ×12 + `light-login.png` + 8 张交互截图（`light-web-proxy-hardening.png`、`light-forward-log.png`、`light-ddns-skip.png`、`light-acme-keytype.png`、`light-files-root.png`、`light-waf-test.png`、`light-settings-tags.png`、`light-settings-token.png`）、`ui-smoke.json`、`ui-smoke.md` |
| [vendor/](screenshots/vendor/) | vendor 树冒烟（组件注册 + 图标本地可取 + 零 404） |

### 复现命令

    # 构建（不需要 Node）
    go build -o nunt.exe ./cmd/nunt

    # 深色主题 12 页基线：截图 + axe + console/请求统计（13/13 演示数据，含真实 TCP 转发）
    node scripts/ui-baseline.mjs --out docs/screenshots/phase3 --label 'phase3 final'

    # 浅色主题 66 个检查点（登录 + 12 页挂载 + axe + 每页关键交互 + 全局统计）
    node scripts/ui-smoke.mjs --out docs/screenshots/phase3/ui-smoke

    # 主题 / 窄屏外壳、kit 全链路、vendor 树
    node scripts/theme-check.mjs
    node scripts/kit-smoke.mjs
    node scripts/vendor-smoke.mjs

    # vendor 记录校验
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly

CI 里由 `.github/workflows/ci.yml` 的 `frontend` job 跑同一组命令（独立 job，不影响 Go / Docker / govulncheck），
截图与报告作为 artifact 上传。

阶段 3 的实跑结果：

| 检查 | 结果 |
| --- | --- |
| `go build ./...` / `go vet ./...` / `go test ./... -count=1 -p 1` | 全部退出码 0（28 个测试包 ok） |
| `ui-baseline --label 'phase3 final'` | 演示数据 13/13；12 页 axe 0/0/0/0、console 0、pageerror 0、失败请求 0、4xx·5xx 0、外部请求 0、横向溢出 0 |
| `ui-smoke` | 66/66 检查点通过，浅色 axe 0/0/0/0，退出码 0 |
| `kit-smoke.mjs` | PASS（7 步：打开对话框 → 空名校验 → 保存 → toast → 删除确认 → 删除后 0 行；console 0、外部请求 0） |
| `theme-check.mjs` | PASS（浅色 token、主题切换、浅色 axe 0/0/0/0、窄屏 420x900 抽屉打开；console 0、外部请求 0） |
| `sync-vendor.ps1 -VerifyOnly` / `sync-lit.ps1 -VerifyOnly` | `[ok]` / `[ok]` |
| `.github/workflows/ci.yml` | PyYAML 解析通过；job 为 build / docker / frontend / govulncheck（frontend 10 个 step） |

## 8. 已知限制

见 [CONTRACT.md 第 7.7 节](CONTRACT.md)，三条要点：

1. sl-dialog 的 landmark 误报靠**运行时补丁**消除（`kit.js` 的 `demoteDialogHeader`，不改 vendor 文件）——
   升级 Shoelace 后必须复验补丁仍然命中；
2. axe 的 `label-title-only` 对「滚出对话框视口的控件」是误判（Shoelace 控件的阴影 `<input>` 永远带
   `aria-describedby="help-text"`）；只影响对话框内部长表单，12 页页面级扫描是 0；
3. `lib/ui.js` 仍在仓库里（只剩 `app.js` 需要的四个纯函数），手写构件已无调用方。

## 9. 未完成项与需要决策的点

1. **首屏 361 KB / 217 个请求**：登录页就会拉起整套 sl-* 组件（kit.js 静态导入全部组件）。
   如果在意首屏，可以把 `nunt-shoelace.js` 的导入改成按需（例如登录页只用 sl-input/sl-button/sl-card/sl-alert），
   代价是每个页面要自己保证组件已注册。**需要决策**：保持现状还是做按需加载。
2. **`lib/ui.js` 的删除**：只剩 `renderIcon/fmtBytes/fmtTime/escapeHtml` 被 `app.js` 使用
   （kit 只是再导出其中几个）。它不在本次允许改动的文件清单里，因此没有删；删它需要先把 `renderIcon`
   搬进 kit（约 40 行），**需要决策**。
3. **阶段 2C 的两个遗留口径**没有改：证书任务「挑战」列对后端短名（`http/dns/tls-alpn`）仍原样显示；
   ddns 规则表没有补回「上次更新 / 成功失败」两列（那两列现在在运行状态表与状态对话框里）。**需要决策**。
4. **冒烟里的 WAF 请求测试返回「未拦截」**：用的 payload 是 `?id=1 union select 1`，
   PL1 + block 模式下没命中规则。检查点只断言「结果渲染出来了」，如果希望断言「一定被拦截」，
   需要换一条必然命中的 payload（例如 `<script>alert(1)</script>` + 相应 Content-Type）。**需要决策**。
5. **CI 前端 job 还没有在真实 GitHub runner 上跑过**：本地等价命令全部通过（Windows + 无头 Chromium），
   Linux runner 上的差异点只有：二进制名（`--exe ./nunt`）、Chromium 依赖（`--with-deps`）。
   首次推送到 GitHub 后需要确认该 job 绿。
6. **演示数据里的转发目标**从 `127.0.0.1:22` 改成了脚本自建的回显服务端口（`12223`），
   这样「转发日志」对话框才有真实数据。如果有人更希望演示数据里保留 `:22` 的观感，
   可以再建一条规则专供日志（**需要决策**）。
7. **`ui-smoke.mjs` 的 `--port`**：nunt 的管理端口来自配置（默认 `16601`），脚本不写配置文件，
   因此 `--port` 只在实例确实监听该地址时才有意义（与 `ui-baseline.mjs` 相同）。
8. **体积仍有优化空间**：kit.js 52 KB 原始（14 KB br）里含大量中文注释与字段说明文案；
   如果哪天要压首屏，先从这里和 vendor 的按需加载入手。
