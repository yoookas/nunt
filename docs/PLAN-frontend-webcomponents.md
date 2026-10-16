# 前端迁移计划：全面改用 Web Components 组件库

> **状态：阶段 0–3 已全部完成**（2026-10）。
> 12 个页面在深/浅两个主题下 axe 四档（critical/serious/moderate/minor）全部为 0；
> 阶段 3 这一批整棵资源树**净减 5,562 字节原始**（gzip +1,039 / br(q6) +707）；
> 相对真正的迁移前（17 个文件、无 vendor）：原始 +668,670（+122.9%）、br(q6) +183,901 ——
> 增量几乎全是 vendor 组件层（+682,330 原始 / +186,060 br），**自有代码净减 13,660 原始 / 2,159 br**；
> 构建链仍然无 npm（`go:embed` 单二进制），零外部请求，页面契约与 `ctx` 语义未变。
> 最终对比报告（体积 / axe / 首屏传输 / 截图索引 / 迁移期修掉的真实缺陷清单）见
> [FRONTEND-REPORT.md](FRONTEND-REPORT.md)；接口与测试口径见 [CONTRACT.md 第 7 节](CONTRACT.md)。

> 决策：放弃手写 DOM 组件层，前端整体改用现成的 Web Components 控件库（Shoelace 2.x，MIT）
> ＋ Lit 作为自研组件的编写层。路由、页面契约（mount(root, ctx)）、lib/api.js、Go 侧 embed 与 CSP 策略保持不变。

## 0. 为什么改

- 手写层的视觉与交互缺陷在真机上从未被验证过（本会话没有浏览器），用户已实际观察到样式问题；
- 手写层已出过 5 个真实缺陷（r.routeOf 崩溃、formGrid 默认值丢失、弹窗 TDZ、顶栏版本不刷新、navigate 不触发路由）；
- 现成组件库在可访问性（focus 管理、键盘、ARIA）、一致性、主题化上远超手写；
- Web Components 不需要编译、CSP 安全、可作为 ESM vendor 进仓库并用 go:embed 打包 —— 不破坏「零构建 / 单二进制」这两个卖点。

## 1. 硬约束（任何方案都必须满足）

1. 构建链仍无 npm：npm 仅作为「同步 vendor 的开发工具」，构建与镜像不需要 Node；
2. 不允许任何外部网络请求（CSP: script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'）——图标、字体、样式全部本地；
3. 页面契约不变：每个页面 export default { id, title, icon, mount(root, ctx) }，可选返回 cleanup；
4. ctx（api/toast/confirm/navigate/onSSE/state/格式化）语义不变；lib/api.js 不动；
5. 单页体积与总体积必须量化（迁移前后 gzip 对比），并接受「更大但更可靠」这个事实。

## 2. 阶段划分

### 阶段 0：基线（先做，1 小时内）— ✅ 已完成

> 产物：`docs/screenshots/before/`（12 页 + 登录页截图、`a11y.json`、`baseline.json`、`REPORT.md`、`VISUAL-REVIEW.md`）。
> 基线数字：整棵资源树 303 个文件 1,203,945 字节原始 / 357,727 gzip / 328,996 br(q6)；
> 12 页 axe 合计 critical 26 / serious 110 / moderate 188 / minor 7。
- Playwright 无头浏览器：启动真实二进制（临时数据目录）→ 登录 → 通过 API 造演示数据（静态规则、转发规则、DDNS 规则、WAF 配置、通知 webhook、任务）→ 逐页截图 12 张 → 输出到 docs/screenshots/before/；
- 同时跑一次 axe 无障碍扫描，记录严重问题数量；记录每个页面的控制台报错；
- 产出：基线截图 + 视觉缺陷清单（这就是用户观察到的「样式有问题」的书面证据，也是迁移后对比的基准）。

### 阶段 1：地基（串行，必须先做）— ✅ 已完成

> 静态资源预压缩（gzip/br，内存缓存 + `Vary: Accept-Encoding`，不落盘、无构建步骤）、
> vendor Shoelace + Lit、主题 token 映射、外壳与登录页重写、`lib/kit.js` 落地。
> 记录：`docs/screenshots/phase1/`（含 `light-notify.png`、`narrow-drawer.png`、`kit-smoke.json`）。
- **静态资源预压缩（必做）**：目前 http.FileServer 直接吐源码，544KB 全是明文传输。改为在响应时压缩并缓存
  （首次请求时 gzip/brotli 压缩一次，之后从内存缓存返回），响应带 Content-Encoding 与 Vary: Accept-Encoding，
  并保持 ETag/条件请求语义。要求：不落盘、不增加构建步骤，纯 Go 实现（约 40 行 + 测试）。
  这一项是抵消组件库体积增量的关键，先于页面迁移完成。
- vendor Shoelace 到 internal/webui/assets/vendor/shoelace/（组件 + 图标，记录版本与来源，附一个 scripts/sync-vendor.ps1 供将来升级）；
- 主题映射：把现有 CSS 变量映射到 Shoelace 设计 token，保留深/浅主题（theme 切换改为切换 sl-theme-dark/light 类）；style.css 只保留布局与少量自定义；
- 外壳重写：侧边栏、顶栏、导航、主题切换、SSE 状态、登录页改用组件库；路由与页面装载逻辑保持不变；
- 验收：CSP 零违规、零外部请求（Playwright 抓请求）、embed 构建通过、登录 → 12 个页面均可打开（内容仍为旧实现）。

### 阶段 2：页面迁移（可并行，2–3 页一组）— ✅ 已完成（批次 A/B/C/D）

> 12 页全部迁移，批次记录（改动、axe、体积、踩坑）分别在
> `docs/screenshots/phase2a|2b|2c|2d/PHASE2*-NOTES.md`。
> 迁移期修掉的真实缺陷（7 页 h3 渲染、版本号 `[object Object]`、files 页 404 原文、
> 代理规则存不下来、负载均衡取值不认、WAF 测试接口 400、BasicAuth 空密码删用户、
> 页面方法遮蔽 DOM `remove`、sl-switch 无可见标签、对话框页脚按钮时序）汇总在
> [FRONTEND-REPORT.md](FRONTEND-REPORT.md) 第 6 节（阶段 3 又补了 8 条，共 18 条）。
- 顺序建议：notify → logs → dashboard → settings → storage → files → forward → task → ddns → acme → web → waf（先小后大，waf/web 最后，因为字段最多）；
- 每页替换 lib/ui.js 的手写构件（按钮/输入/下拉/开关/标签页/对话框/表格/提示/徽标）为 sl- 组件；需要局部状态时用 Lit 组件（light DOM，createRenderRoot 返回 this，以复用全局样式）；
- 保持该页所有既有接口调用与字段行为不变（迁移只换渲染层，不改数据流）；
- 每页迁移后跑一次 Playwright 流程 + 截图，与 before 对照。

### 阶段 3：收尾与验证 — ✅ 已完成

> - `style.css` 原第 6 节「迁移期遗留层」整节删除（30,904 → 18,469 字节，748 → 519 行，−12,435 字节），
>   12 页共用的容器类（.card/.card-header/.card-body/.sub/.notice）搬到第 4 节；
> - 四处真实缺陷修正（ACME 密钥类型、DDNS 失败计数、未启用规则的手动执行提示、
>   代理的 rateLimitPerSec/maxBodyBytes + toggle 回退剥只读字段）；
> - `nunt-tags` 补 `label`（消掉 `label-title-only`），settings 页两个字段换回标签输入；
>   sl-dialog 的 landmark 误报用运行时补丁消除（不改 vendor）；
> - UI 测试固化：新增 `scripts/ui-smoke.mjs`（浅色主题 + 逐页交互 + 66 个检查点，失败非零退出），
>   `ui-baseline.mjs` 补真实 TCP 转发连接；
> - CI 新增独立的 `frontend` job（Playwright + axe + 截图 artifact）；
> - 文档：CONTRACT 第 7 节定稿、README 前端小节、本计划状态、`docs/FRONTEND-REPORT.md` 最终对比报告。
- 删除或大幅精简 lib/ui.js（只保留确实通用的格式化与 api 相关工具）；
- 测试升级：现在的 DOM-shim 冒烟测试改为 happy-dom 或 Playwright 驱动（否则自定义元素无法在 Node 里跑）；CI 增加前端 Playwright job（无头，截图作为 artifact）；
- 文档：docs/CONTRACT.md 第 7 节改写（前端栈、vendor 策略与升级方式、主题 token 映射、新增页面模板）；README 前端小节同步；
- 产出：体积对比（迁移前/后 gzip）、axe 严重问题数对比、页面截图对照、CI 前端 job 截图 artifact。

## 3. 验收判据（全部满足才算完成）

1. 12 个页面在真机浏览器里功能可用（Playwright 流程通过），深/浅主题都正常；
2. CSP 零违规、零外部请求（含图标与字体）；
3. go build ./... 与 go vet ./... 通过，镜像构建不需要 Node；
4. axe 严重/重要问题为 0（或每条都有书面例外理由）；
5. 体积与代码量变化有数字（gzip 增量、lib/ui.js 删除行数）；
6. docs 与 README 已同步；CI 新增前端 job 且绿。

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 体积膨胀 | 只 vendor 实际用到的组件；迁移前后量 gzip；必要时拆分为按需加载的 chunk |
| Shadow DOM 与现有样式冲突 | 统一用 light DOM（createRenderRoot 返回 this）＋主题 token 映射；style.css 退化为布局层 |
| 迁移期新旧混搭难看 | 阶段 1 先把外壳与主题做完再逐页迁移，避免「半新半旧」的观感 |
| 测试全挂 | 阶段 3 一次性升级测试基座（happy-dom/Playwright），并在 CI 中固化 |
| 失去「零构建」 | vendor 目录入库 + 记录版本与同步脚本；构建与镜像不依赖 npm |
| 无障碍回退 | 用 axe + 键盘遍历做验收，不允许「更漂亮但更难用」 |

## 5. 组件库选择

- 选定：Shoelace 2.x（MIT、稳定、组件最全、ESM 可直接 vendor、内置 setBasePath 可把图标指向本地）；
- 备选：Web Awesome（Shoelace 后继，免费层可用、部分能力付费）——若将来要更现代的控件可再评估；
- 明确排除：React/Vue/Svelte（需编译，破坏零构建）、Stencil（需编译）、Ionic（移动端观感）。