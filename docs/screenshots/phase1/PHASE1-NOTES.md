# 阶段 1 验收记录（Shoelace 外壳 + kit 共享组件层）

> 由本次改造生成，配合 `docs/PLAN-frontend-webcomponents.md` 与 `docs/CONTRACT.md` 第 7 节。
> 机器数据见同目录 `baseline.json` / `a11y.json` / `REPORT.md`，截图见 `*.png`。

## 1. 结论

| 验收项 | 结果 |
| --- | --- |
| go build ./... / go vet ./... | 通过（BUILD_EXIT=0 / VET_EXIT=0） |
| go test ./... -count=1 | 通过（全绿；并行跑时本机 Windows 偶发 `fork/exec ... being used by another process`，`-p 1` 串行复跑全绿） |
| ui-baseline 采集 | 12 页 + 登录页全部挂载；**console 0、失败请求 0、外部请求 0、HTTP 4xx/5xx 0** |
| axe（登录页 / 外壳 / notify） | critical **0**（对比迁移前：登录 1、各页 1~9，合计 26） |
| axe 合计 | critical 26 → **14**（剩下 14 全在未迁移的 files/waf/settings 的老表单控件上），serious 110 → **0**，moderate 188 → **7**，minor 7 → **7** |
| vendor 校验 | `sync-vendor.ps1 -VerifyOnly` → `[ok]`；`sync-lit.ps1 -VerifyOnly` → `[ok]` |
| vendor 冒烟 | `node scripts/vendor-smoke.mjs` → **PASS**（39 个组件、图标加载成功、0 报错 0 外部请求） |

## 2. 体积（服务端真实协商 + 本地 zlib q9 / brotli q11）

| 资源 | 旧原始 | 新原始 | 旧 gzip | 新 gzip | 旧 br | 新 br |
| --- | --- | --- | --- | --- | --- | --- |
| app.js | 29447 | 33406 | 8124 | 10048 | 6743 | 8357 |
| style.css | 24099 | 30904 | 5674 | 7460 | 4775 | 6240 |
| lib/kit.js | —（新） | 49754 | — | 14549 | — | 12089 |
| pages/notify.js | 8360 | 9733 | 2831 | 3773 | 2317 | 3011 |

`curl -w %{size_download}`（服务端协商，br 优先）：

| 资源 | identity | gzip | br |
| --- | --- | --- | --- |
| app.js | 33406 | 10018 | 9123 |
| style.css | 30904 | 7445 | 7058 |
| lib/kit.js | 49754 | 14483 | 13650 |
| pages/notify.js | 9733 | 3769 | 3291 |
| index.html | 1408 | 843 | 713 |

整棵前端资源树（含 vendor）：

| 范围 | 文件 | 原始 | gzip9 | br11 |
| --- | --- | --- | --- | --- |
| 旧（HEAD） | 303 | 1204022 | 356229 | 302199 |
| 新 | 316 | 1291599 | 387371 | 328374 |

增量：原始 +87577（+7.3%），br11 +26175（+8.7%）。其中 vendor/lit 11 个文件 20795 字节（br11 9401），
是「自研组件能直接用 Lit」的代价；Shoelace 的 vendor 树一个字节都没动。

style.css 现在 748 行，其中第 6 节「迁移期遗留层」约 270 行只服务还没迁到 kit 的老页面，
阶段 2 结束时删掉这一节（第 479 行起）即回落到 ~478 行。

## 3. 关键实现决定

1. **Lit 单独 vendor**：Shoelace 的 cdn 构建把 lit 内联进 hash 命名的 chunk（只有 t/e/r 这种压缩名导出），
   下游拿不到 LitElement；dist 构建又带裸模块说明符（CSP 不允许 import map）。
   因此新增 `scripts/sync-lit.ps1`（固定文件清单 + 改写跨包说明符为相对路径 + 校验无裸说明符），
   只 vendor 11 个文件。
2. **主题 = <html> 上的 sl-theme-dark / sl-theme-light**，nunt 的 `--bg/--text/--brand/...` 全部是
   Shoelace token 的别名（style.css 第 1 节，浅色一套深色一套），并覆盖了 primary 色阶为 nunt 品牌蓝。
3. **data: URL fetch 垫片**：Shoelace 内置图标库（library="system"）把内联 SVG 编码成 data: URL，
   而 `sl-icon` 用 `fetch(url, {mode:'cors'})` 读取；Chrome 在 cors 模式下拒绝 data: URL，
   于是每个内置图标（下拉箭头、关闭按钮、密码眼睛…）都会在控制台留两条报错。
   kit.js 里加了一层只处理 `data:` 的 fetch 垫片（解出内容造 Response，其它请求原样透传），
   不动 vendor、不加请求、不改 CSP。
4. **登录页零 401**：未登录时 `GET /api/v1/auth/session` 返回 401，浏览器网络层会把它记成
   console 错误。现在只有 `localStorage['nunt.session']` 为 1（登录成功过）时才探测会话，
   否则直接渲染登录页；退出登录会清掉这个标记。
5. **files 页不再打 404**：`GET /api/v1/files/shares` 由 filebrowser 模块注册，该模块没注册时
   后端直接 404（并把 Go 的 `404 page not found` 原文返回）。现在先读 `GET /api/v1/modules`，
   没有 filebrowser 就渲染友好空态 + 「重新检测」，不再发那条注定 404 的请求（迁移前还会重试一次，共两条）。


## 4. 主题与窄屏（scripts/theme-check.mjs，补测）

暗色主题由 ui-baseline 覆盖（12 页 + 登录页）。浅色主题与窄屏外壳由 `scripts/theme-check.mjs` 补测：

| 检查 | 结果 |
| --- | --- |
| `<html>` 的类名 | 初始 `sl-theme-light`（localStorage 里存 light）；点一次主题按钮后变成 `sl-theme-dark` |
| token 是否真的换了 | `--sl-color-neutral-0` = `hsl(0, 0%, 100%)`、`--bg` = `hsl(240 4.8% 95.9%)`、body 背景 `rgb(244,244,245)` |
| 浅色主题 axe（notify 页，带 1 条真实数据） | critical 0 / serious 0 / moderate 0 / minor 0 |
| 窄屏 420px | 侧边栏 `display: none`，点菜单按钮后 `sl-drawer` 打开且导航在抽屉内 |
| console / 外部请求 | 0 / 0 |

截图：`light-notify.png`（浅色）、`narrow-drawer.png`（窄屏抽屉）。

> 浅色主题下 Shoelace 的实心徽标是「-600 底 + 白字」，success/warning 只有 ~3.3:1 对比度，
> axe 报 color-contrast/serious。style.css 里用 `::part(base)` 在 `.sl-theme-light` 下把徽标底色压深一档
> （success→green-700、warning→amber-800、danger→red-700、primary→primary-700、neutral→neutral-700），
> 深色主题不动（它的色阶是反的）。改完浅色主题 4 项全 0。


## 5. kit 交互冒烟（scripts/kit-smoke.mjs）

页面能打开不等于组件能用，所以额外用真实浏览器走了一遍 notify 页的完整交互：

| 步骤 | 结果 |
| --- | --- |
| 打开通知页 | ok |
| 点「新建 Webhook」→ sl-dialog 打开、nunt-form 渲染出 6 个字段 | ok |
| 什么都不填直接「保存」→ 字段级校验显示「请填写名称」 | ok |
| 填名称/地址后「保存」→ 发出 PUT、表格出现 1 行、右上角绿色 toast「已保存」 | ok |
| 点行内「删除」→ 确认框文案「确定要删除 Webhook「冒烟测试通知」吗？」 | ok |
| 确认删除 → 表格回到空状态 | ok |
| console 报错 / 外部请求 | 0 / 0 |

截图：`notify-dialog.png`（校验失败）、`notify-saved.png`（保存成功 + toast）。

这一步发现的 3 个真实缺陷（都已修）：

1. **`NuntForm` 根本没升级**：类里有个字段叫 `hidden`，而 `hidden` 是 `HTMLElement` 的原生属性，
   构造期赋值会写 `hidden` 属性，`document.createElement('nunt-form')` 于是直接抛
   「The result must not have attributes」——表单在对话框里永远是空的。
   改成 `hiddenFields`；`NuntError` 的 `title` 同理改成 `heading`（避免往宿主写 title 属性）。
2. **`form.read()` 抛 ReferenceError**：选择器辅助函数 `attrSelector` 在拼装文件时丢了，
   读表单时直接异常；被 openDialog 的 try/catch 吞掉，表现为「点保存没反应」。
3. **字段标签渲染两遍**：sl-input/sl-select/sl-textarea 自己带 label，我又渲染了一行 `.nunt-field-label`。
   现在只有 switch/checkbox/tags/kv/custom 由 kit 渲染标签。

## 6. 遗留与待决策

1. **未迁移的 11 个页面**仍用 `lib/ui.js` 的手写构件，因此：
   - `style.css` 第 6 节「迁移期遗留层」暂时不能删；
   - files/waf/settings 上仍各有 1/8/5 条 axe **critical**（老页面的 `<select>`/数字输入没有 label），
     这是迁移前的既有问题，阶段 2 迁到 kit 的 `formGrid` 后自动消失（kit 用 `sl-input` 的 label 关联）；
   - 7 个老页面用 `<h3>` 当卡片标题，而外壳顶栏是 `<h1>`，会触发 axe `heading-order`（moderate）——
     阶段 2 把这些标题改成 `<h2>` 即可（已在 CONTRACT 7.5 里写明）。
2. **导航项没有用 sl-menu/sl-button**：为了让 `aria-current="page"` 能被读屏软件正确播报、
   并保留原生链接语义（可中键新开、可被浏览器历史识别），侧栏导航保持原生 `<a>` + 设计 token 样式。
   若要求「一律 Shoelace」，可以改成 `<sl-button href>`，但 `aria-current` 会落在宿主元素上、
   读屏软件读不到，需要权衡。
3. **CSS 体积暂时上升**：阶段 1 同时存在「新外壳/kit 样式 + 老页面遗留样式」，属于过渡态，阶段 2 会回落。

## 7. 复现命令

    # 1) Go
    $env:GOMODCACHE='D:\Desktop\nunt\.gocache\mod'; ...（见 CONTRACT 第 1 节）
    go build ./... ; go vet ./... ; go test ./... -count=1 -p 1

    # 2) 前端采集（真实二进制 + 无头 Chromium）
    go build -o nunt.exe ./cmd/nunt
    node scripts/ui-baseline.mjs --out docs/screenshots/phase1 --label '阶段 1（Shoelace 外壳 + kit 模板页）'

    # 3) 主题与窄屏补测
    node scripts/theme-check.mjs

    # 4) kit 交互冒烟（新建 → 校验 → 保存 → 删除）
    node scripts/kit-smoke.mjs

    # 5) vendor
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly
    node scripts/vendor-smoke.mjs

    # 6) 体积（服务端协商）
    curl.exe -s -o NUL -w "%{size_download}" -H "Accept-Encoding: br" http://127.0.0.1:16601/app.js
