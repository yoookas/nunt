# 阶段 2 第一批验收记录（settings / files / dashboard 迁移到 kit）

> 由本次迁移生成，配合 docs/PLAN-frontend-webcomponents.md 与 docs/CONTRACT.md 第 7 节。
> 机器数据见同目录 baseline.json / a11y.json / REPORT.md（12 页截图、逐页 console/请求/axe 明细）、
> light-theme-pages.json（浅色主题补测）、pages-smoke.json（交互冒烟）。
> 本批只改了 3 个页面文件：internal/webui/assets/pages/settings.js、files.js、dashboard.js。

## 1. 结论

| 验收项 | 结果 |
| --- | --- |
| go build ./... | 通过（BUILD_EXIT=0） |
| go vet ./... | 通过（VET_EXIT=0） |
| go test ./... -count=1 -p 1 | 通过（全部 ok，TEST_EXIT=0） |
| ui-baseline 采集 | 12 页 + 登录页截图齐全；console 报错 0、失败请求 0、外部请求 0、HTTP 4xx/5xx 0、未挂载 0、横向溢出 0 |
| axe：settings / files / dashboard | critical 0 / 0 / 0（阶段 1 为 5 / 1 / 0），serious 0 / 0 / 0 |
| axe 合计（12 页） | critical 14 → 8（剩下 8 条全在未迁移的 waf 页），serious 0 → 0，moderate 7 → 6，minor 7 → 6 |
| 浅色主题补测（三个页面） | critical/serious/moderate/minor 全 0，console 0，外部请求 0，页面内 h3 计数 0 |
| 交互冒烟（三个页面，23 步） | 全部通过，console 报错 0 |
| sync-vendor.ps1 -VerifyOnly | [ok] vendor 目录与 VERSION.md 记录一致（VENDOR_EXIT=0） |
| sync-lit.ps1 -VerifyOnly | [ok] lit vendor 目录与 VERSION.md 记录一致（LIT_EXIT=0） |

## 2. 改动清单

只动了三个页面文件（外加本说明与两份补测 JSON），kit.js、app.js、style.css、lib/api.js、
vendor/**、任何 Go 代码都没碰；页面契约 export default { id, title, icon, mount(root, ctx) } 与 ctx 语义不变。

### 2.1 pages/dashboard.js（384 → 574 行）

- 从「命令式 el() 拼 DOM」改成 NuntElement 子类 + Lit 模板；
- 卡片拆成 5 张：系统指标（CPU / Go 内存 / 运行时长 / 版本）、主机指标（内存 / 磁盘 / 负载）、
  动态域名、模块状态、最近日志；标题全部 h2；
- 主机指标的平台空态：后端只在 Linux 上采集（internal/sysinfo/host_other.go 对非 Linux 直接返回 nil），
  迁移前这三张卡在 Windows 上永远显示「—」。现在判断 stats.host 是否有对应字段：
  - 有值 → 正常渲染指标块；
  - 一个都没有 → nunt-empty「该平台不支持」+ hint（写明「只有 Linux 版本会返回；当前平台：windows」）
    加页脚说明段；不再出现「— / — / —」；
  - 只有部分字段 → 只渲染有值的项，并在页脚注明「其余项后端未提供」；
- 版本号走 kit 的 infoVersionText(info)（仍然读 /api/v1/system/info 的 version 字段，避免 [object Object]）；
- 模块开关（启动 / 停止 / 重启）、停止确认框、toast、ctx.navigate('ddns'|'logs')、
  ctx.state.modules / ctx.state.info 的写回语义不变；5 秒轮询 + document.hidden 判断不变；
- SSE 处理不变（log 增量入栈、status|modules|module 触发 loadModules+loadStats）；
- cleanup：clearInterval + offSSE() + 移除元素与页面样式，日志自动滚底改为 updated() 钩子。

### 2.2 pages/settings.js（579 → 768 行）

- 标签页换成 sl-tab-group / sl-tab / sl-tab-panel（role=tablist/tab/tabpanel 由组件负责），
  5 个标签与顺序不变：基础设置 / 用户 / API Token / 在线会话 / 配置导入导出；
- 基础设置：formGrid 10 个字段与字段名、默认值、hint、placeholder 一一对应；保存时构造的 payload
  10 个键、默认值兜底（24 / 5 / 15）、保存后 ctx.theme.set(payload.theme) + toast + 重新取数都不变；
- 用户 / Token / 会话三张表换成 nunt-table（列、宽度、排序、空态文案保持；操作列用 actions: true）；
- 新建 / 编辑用户、新建 Token 从 openModal 换成 openDialog + formGrid，校验文案不变
  （请填写用户名 / 密码至少需要 8 位 / 请填写名称），错误用 form.fieldError() / form.error() 呈现；
- 删除用户 / 删除 Token / 导入配置用 confirmDialog（文案逐字保持，例如
  「确定要删除用户「x」吗？该用户的会话会立即失效。」），提示用 toast；
- Token 只显示一次的那个弹窗、查看当前配置 JSON 的弹窗（含「复制」按钮）继续保留；
- 导出配置仍然是原生 fetch('/api/v1/system/config') + content-disposition 文件名 + 本地 downloadText
  （实现从 lib/ui.js 抄过来，页面不再 import ui.js）；
- cleanup：dispose() 关掉本页打开的所有 sl-dialog（避免对话框挂在 body 上），并置 disposed。

### 2.3 pages/files.js（1003 → 513 行）

- 目录列表与分享链接两张表换成 nunt-table，标题 h2；挂载点/路径/过滤三个控件换成
  sl-select / sl-input（都带 label，select-name 消除）；按钮换成 sl-button，
  下载/预览仍是同一个 URL（/api/v1/files/download?mount=&path=[&inline=1]，下载带 download，预览带 target=_blank rel=noopener）；
- 交互逐条保留：切换挂载点 → 回根目录、面包屑跳转、上一级、根目录、路径回车/前往、目录过滤（180ms 防抖）、
  目录行「打开」、分享链接「复制」、取消分享（确认框 + DELETE /api/v1/files/shares/{id}）、分享区「刷新」/「重新检测」；
- 阶段 1 的行为完整保留：loadShares() 先读 GET /api/v1/modules，没有 filebrowser 就渲染
  nunt-empty（「分享链接暂不可用」+ 说明 + 「重新检测」按钮），不发那条注定 404 的 /api/v1/files/shares 请求；
  取不到模块清单时按「可用」处理（与迁移前一致）；
- 空态齐全：没有挂载点（「请选择或先创建一个存储挂载点」）、目录为空、过滤无命中、挂载点列表加载失败（nunt-error + 重试）；
- 删掉了页面里从未被调用的 DDNS 供应商兜底代码（dnsProviderCache / normalizeProviders /
  fallbackProviderFields / loadDNSProviders，其中 loadDNSProviders 还引用了不存在的 api，一旦被调用就 ReferenceError）
  以及老页面自带的 wrapAPI（它会在 404/5xx 时把同一个请求再发一遍）；接口路径、方法、字段名没有变化。

## 3. kit 用法要点（本批实际用到的）

1. 页面 = light DOM 的 NuntElement 子类 + define('nunt-page-xxx', Klass)；mount 里先
   page.ctx = ctx 再 root.appendChild(page)（connectedCallback 里就要取数），cleanup 返回
   () => { page.dispose(); offStyle(); }；
2. 表格：<nunt-table .columns .rows .loading .error .onRetry .rowKey empty emptyHint caption>；
   操作列写 actions: true（自动右对齐、不换行、包在 .nunt-actions 里；title 省略时按「操作」渲染，
   不再触发 axe 的 empty-table-header）；行内按钮用 render(row) 返回 Lit 模板；
3. 表单：formGrid([...]) 返回 { node, read, get, set, error, fieldError, toggle, clearErrors }，
   form.node 直接嵌进 Lit 模板；label 交给 sl-input/sl-select 的 label 属性 →
   settings 之前的 3 条 label + 2 条 select-name critical 自然消失；
4. 对话框：openDialog({ title, body, actions, wide, onMount })；提交中 dlg.setBusy(true, button)；
   保存失败要保留对话框就写 close: false（校验失败/接口失败时不能自动关）；
5. 提示：toast(msg, 'ok'|'err'|'warn'|'info')、confirmDialog(msg, { danger, okLabel })；
6. 三态：直接写 <nunt-empty> / <nunt-loading> / <nunt-error .error .onRetry heading hint compact> 元素
   （kit 组件是 light DOM，能当普通标签用；「附加内容」用属性传 —— 例如分享链接空态的
   .action 传一个含 sl-button 的 Lit 模板）；
7. 卡片标题一律 h2（外壳顶栏是 h1），页面私有样式统一 pdashboard- / pfiles- / psettings- 前缀并随 cleanup 移除；
8. 错误文案走 errorMessage() / nunt-error 内部的 friendlyMessage()，404 不会把后端原文摊在界面上。

## 4. axe 对比（critical / serious / moderate / minor）

| 页面 | 阶段 0（迁移前） | 阶段 1 | 阶段 2A（本批） |
| --- | --- | --- | --- |
| #/dashboard | 1 / 28 / 22 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| #/files | 2 / 4 / 22 / 1 | 1 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| #/settings | 6 / 9 / 4 / 0 | 5 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| 三页合计 | 9 / 41 / 48 / 1 | 6 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| 12 页合计 | 26 / 110 / 188 / 7 | 14 / 0 / 7 / 7 | 8 / 0 / 6 / 6 |

- settings 阶段 1 的 5 条 critical = 3 条 label（三个数字输入）+ 2 条 select-name（日志级别、默认主题下拉），
  现在由 sl-input label / sl-select label 修掉；
- files 阶段 1 的 1 条 critical = select-name（挂载点原生 select 没有可访问名），现在由 sl-select label 修掉；
  同时它那条 empty-table-header(minor) 与 heading-order(moderate) 也一并消失（nunt-table + h2）；
- dashboard 阶段 1 已经是 0，本批新增的两处 serious 已在提交前修掉：
  指标块/模块块原本用 --bg-soft 打底，块内 --text-faint 次级文案对比度不足（axe 报 10 个节点），
  改成只描边不打底后为 0；
- 浅色主题补测（临时脚本，用同一套 axe 规则）三页同样全 0，坐实不是「只在深色下好看」；
- 剩余 8 条 critical 全在 #/waf（未迁移），6 条 empty-table-header + 6 条 heading-order
  分布在 web / forward / ddns / acme / waf / task 六个未迁移页面，属于后续批次。

## 5. 体积对比（三个页面的原始 / gzip / br 字节）

| 文件 | 原始旧 | 原始新 | Δ原始 | gzip 旧 | gzip 新 | Δgzip | br 旧 | br 新 | Δbr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pages/settings.js | 25438 | 31209 | +5771 | 6148 | 8767 | +2619 | 4993 | 7075 | +2082 |
| pages/files.js | 43695 | 19526 | −24169 | 13475 | 6270 | −7205 | 11547 | 5096 | −6451 |
| pages/dashboard.js | 14917 | 24101 | +9184 | 4354 | 7270 | +2916 | 3651 | 6025 | +2374 |
| 合计 | 84050 | 74836 | −9214 | 23977 | 22307 | −1670 | 20191 | 18196 | −1995 |

口径：旧 = git show bf19d7e:<path> 的字节（阶段 1 的产物，即迁移前）；新 = 工作区文件字节；
两边都是 LF、与 //go:embed all:assets 打进二进制的内容一致；gzip 用 zlib level 9、br 用 brotli quality 11
（与阶段 1 的记录口径相同）。

结论：files 页因为甩掉了老 lib/ui.js 那一整套自包含兜底（el/makeEl/modal/tableEl/字段构件/DNS 供应商兜底），
单页小了一半以上；settings 与 dashboard 因为改用 Lit 组件类而变大一些；
三个页面合计反而小了：原始 −9214 字节、gzip −1670 字节、br −1995 字节。

## 6. 验收命令与真实输出

环境前缀（每条 pwsh 都带，值与 PHASE1-NOTES 第 7 节一致）：GOMODCACHE / GOCACHE / GOPATH 指向仓库内 .gocache，
GOFLAGS=-mod=mod，GOTOOLCHAIN=auto，GOTMPDIR=TMP=TEMP=仓库内 .gocache/tmp，PATH 前置 Go 的 bin 目录。

    # 1) Go
    go build ./...                      # BUILD_EXIT=0
    go vet ./...                        # VET_EXIT=0
    go test ./... -count=1 -p 1         # TEST_EXIT=0
    #   ok github.com/nunt/nunt/internal/api 15.022s
    #   ok github.com/nunt/nunt/internal/app 3.625s
    #   ok github.com/nunt/nunt/internal/modules/waf 61.772s
    #   ok github.com/nunt/nunt/internal/webui 0.693s   （其余包全部 ok / no test files）

    # 2) 前端采集（真实二进制 + 无头 Chromium）
    go build -o nunt.exe ./cmd/nunt
    node scripts/ui-baseline.mjs --out docs/screenshots/phase2a --label 'phase2 batch A'
    # [baseline] 服务就绪：http://127.0.0.1:16601（已从 stdout 抓到初始管理员密码）
    # [baseline] 演示数据：11/11 成功
    # [baseline] 采集页面 #/dashboard … #/settings（共 12 页）
    # [baseline] 已写出 REPORT.md / a11y.json / baseline.json 到 docs/screenshots/phase2a
    # [baseline] 汇总：console 0，失败请求 0，外部请求 0，axe 严重 8，重要 0
    # BASELINE_EXIT=0

    # 3) 补测（临时脚本在 .gocache/tmp，不属于仓库 scripts/）
    node .gocache/tmp/light-check.mjs   # LIGHT-CHECK: PASS
    node .gocache/tmp/pages-smoke.mjs   # PAGES-SMOKE: PASS（23 步 / 0 失败 / console 0）

    # 4) vendor
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly   # [ok] vendor 目录与 VERSION.md 记录一致；VENDOR_EXIT=0
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly      # [ok] lit vendor 目录与 VERSION.md 记录一致；LIT_EXIT=0

REPORT.md 第 1 节的原始数字：页面数 12、页面未挂载出内容 0、console 报错+警告 0、失败请求 0、
HTTP 4xx/5xx 响应 0、外部请求 0、横向溢出的页面 0、axe 严重 8 / 重要 0 / 中等 6 / 轻微 6。
三个页面的逐页结果（REPORT.md 第 4 节）：#/dashboard 0/0/0/0、#/files 0/0/0/0、#/settings 0/0/0/0。

## 7. 未完成项与需要决策的点

1. files 页的分享链接表格还没有在「注册了 filebrowser 模块」的部署上验证过：本机 app.go 只注册
   waf / acme / web / forward / ddns / task，所以三张截图里分享区永远是友好空态（这正是阶段 1 的修复目标）。
   表格渲染本身（挂载/路径、链接+复制、有效期、创建者、取消分享）是按迁移前代码逐列搬过来的，但没有真机数据验证。
   需要决策：是否让后端默认注册 filebrowser，或在有该模块的环境补跑一次。
2. 两个字段从 kit 的 nunt-tags 退回普通文本框：adminAllowIps（管理端 IP 白名单）与 Token 的 scopes（权限范围）。
   原因：nunt-tags 内层的 sl-input 只有 placeholder 没有 label，会被 axe 判 label-title-only / serious，
   而 kit.js 本批不允许改；迁移前 lib/ui.js 的 tags 字段本来就是「文本框 + 逗号/分号/空白拆分」，
   所以退回文本框既消掉告警，也更贴近迁移前的交互。
   需要决策：后续是否在 kit.js 里给 nunt-tags 的内层输入补 aria-label（或可见 label），
   然后把这两个字段再换回标签控件。
3. style.css 第 6 节「迁移期遗留层」还在：本批三个页面仍复用了 .card / .card-header / .card-body /
   .sub / .spacer / .muted / .mono / .row（与阶段 1 的模板页 notify.js 一致），这三个页面自己的样式
   全部用 pdashboard- / pfiles- / psettings- 前缀随 mount 清理。等 11 个页面全部迁完再整节删除，
   删除前需要先把这几个通用容器类搬进 style.css 的 kit 段（属阶段 3）。
4. 概览页在 Windows 上仍然没有主机内存/磁盘/负载数据 —— 这是后端的能力边界（只有 Linux 采集）。
   本批只把「一排破折号」改成明确的平台空态；要让 Windows 也有数据需要改 Go（不在本批允许范围）。
5. 剩余 axe：#/waf 的 8 条 critical（label 2 + select-name 6），以及 web / forward / ddns / acme / waf / task
   六个未迁移页面的 empty-table-header(minor) 与 heading-order(moderate) 各 6 条，留给后续批次。
6. 本批的补测脚本是临时的：light-check.mjs / pages-smoke.mjs 放在 .gocache/tmp（gitignore），
   没有进 scripts/。它们验证的行为（浅色主题 axe、三页交互）建议在阶段 2 收尾时固化进 scripts/
   （例如扩展 kit-smoke.mjs），但那需要动仓库脚本，超出本批「只改三个页面文件」的约束。
