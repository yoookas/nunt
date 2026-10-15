# 阶段 2 批次 B 验收记录（logs / storage / forward / task 迁移到 kit）

> 由本次迁移生成，配合 docs/PLAN-frontend-webcomponents.md 与 docs/CONTRACT.md 第 7 节。
> 机器数据见同目录 baseline.json / a11y.json / REPORT.md（12 页截图、逐页 console/请求/axe 明细）、
> light-theme-pages.json（浅色主题补测）、pages-smoke.json 不属于仓库（在 .gocache/tmp/pages-smoke-2b.json）。
> 本批只改了 4 个页面文件：internal/webui/assets/pages/logs.js、storage.js、forward.js、task.js。

## 1. 结论

| 验收项 | 结果 |
| --- | --- |
| go build ./... | 通过（GO_BUILD_EXIT=0） |
| go vet ./... | 通过（GO_VET_EXIT=0） |
| go test ./... -count=1 -p 1 | 通过（全部 ok，TEST_EXIT=0） |
| ui-baseline 采集 | 12 页 + 登录页截图齐全；console 0、未捕获异常 0、失败请求 0、外部请求 0、HTTP 4xx/5xx 0、未挂载 0、横向溢出 0 |
| axe：logs / storage / forward / task | critical 0 / 0 / 0 / 0，serious 0 / 0 / 0 / 0，moderate 0、minor 0 |
| axe 合计（12 页） | critical 8 → 8（剩下的 8 条仍只在未迁移的 waf 页），serious 2 → 0，moderate 6 → 4，minor 6 → 4 |
| 浅色主题补测（四个页面） | critical/serious/moderate/minor 全 0，console 0，外部请求 0，页面内 h3 计数 0 |
| 交互冒烟（四个页面，59 步） | 全部通过，console 报错 0 |
| 体积（四页合计） | 原始 −18664 字节、gzip −4034 字节、br −4286 字节 |
| sync-vendor.ps1 -VerifyOnly | [ok] vendor 目录与 VERSION.md 记录一致（VENDOR_EXIT=0） |
| sync-lit.ps1 -VerifyOnly | [ok] lit vendor 目录与 VERSION.md 记录一致（LIT_EXIT=0） |

## 2. 改动清单

只动了四个页面文件（外加本说明与 phase2b 的采集产物），kit.js、app.js、style.css、lib/api.js、
vendor/**、任何 Go 代码都没碰；页面契约 export default { id, title, icon, mount(root, ctx) } 与 ctx 语义不变。
四个页面都从「命令式 el() 拼 DOM」改成 NuntElement 子类 + Lit 模板，卡片标题一律 h2，
页面私有样式用 plogs- / pstorage- / pforward- / ptask- 前缀，随 mount 返回的 cleanup 一起移除。

接口与字段名一律没动，逐个核对过的提交体：
* storage：POST/PUT /api/v1/storage/mounts（id/name/type/enable/remark/readOnly/root/url/username/password/insecureTls，
  local 只写 root、webdav 才写 url/凭据，createdAt 原样带回），POST /api/v1/storage/mounts/test（{mount, id}），
  GET /api/v1/storage/mounts/{id}/list?path=；
* forward：POST/PUT /api/v1/forward/rules[/{id}]（name/enable/protocol/srcAddr/dstAddr/timeoutSec/remark/
  access{mode,ips,uaMode,uas}），POST /api/v1/forward/rules/{id}/toggle（失败退回 PUT 全量更新 —— 与迁移前一致，
  注意旧代码的 PUT 回退里有一个未定义的 want 变量，现在按「切换意图」正确传入），GET /api/v1/forward/logs?rule=&limit=200；
* task：POST/PUT /api/v1/task/items[/{id}]（name/enable/cron/remark/actions[]），
  POST /api/v1/task/items/{id}/toggle（后端当前没有这条路由，退回 PUT 全量更新），POST /api/v1/task/items/{id}/run；
* logs：GET /api/v1/system/logs?limit=500，SSE 的 log 消息格式不变。

### 2.1 pages/logs.js（249 → 412 行）

- 日志列表改用 kit 的 nunt-table：时间 / 级别 / 内容三列，行数据用 seq 作为 rowKey
  （日志内容可以完全重复，不能用内容做 key）；空/加载/错误三态由表格负责；
- 行为逐条保留：级别过滤（全部/debug/info/warn/error）、关键字搜索（160ms 防抖）、自动滚动、
  实时跟随（关闭后不再把 SSE 增量并入视图，打开时补一次全量视图）、清屏（只清本地视图 + 同一条 toast）、
  导出（nunt-logs-<时间戳>.log，text/plain）、重新加载（limit=500）；
- 3000 行窗口与 2×3000 的缓冲上限不变，计数文案仍是「N 条」/「命中 / 总数 条」；
- 长日志行的换行与缩进修在页面私有样式里：迁移前是 flex 三列，消息换行后第二行会顶到最左边、
  和上面的时间戳挤在一起；现在用页面样式把表格改成「时间戳 | 级别 | 消息」三列 grid，消息列做
  悬挂缩进（text-indent:-2em; padding-left:2em），换行后的行首与首行文字对齐，不再回退到时间戳那一列；
- 工具栏换成 sl-select（带可见 label「日志级别」）/ sl-input（label「搜索关键字」）/ sl-switch / sl-button，
  服务端日志级别仍然放在 select 的 title 上；
- SSE 订阅与 cleanup：connectedCallback 里 onSSE 一次（用 started 守卫，重连不会重复订阅），
  cleanup → dispose() → stop() 会 clearTimeout(防抖) + offSSE() + remove()，disconnectedCallback 再兜一次，
  stop() 可重复调用；evaluate 里没有任何「卸载后还写 state」的定时器或回调。

### 2.2 pages/storage.js（340 → 541 行）

- 挂载点表格改用 nunt-table：名称（含备注副行）/ 类型 / 位置 / 只读 / 状态 / 操作（actions，右对齐不换行）；
- 新建 / 编辑对话框用 openDialog + formGrid，字段与显隐规则与迁移前逐条一致：
  local 只显示本地路径（root），webdav 才显示地址/用户名/密码/跳过证书校验；只读两种类型都显示；
  类型在新建时可改、编辑时禁用；
- 密码掩码回填：列表返回的 ******** 原样保留在密码框里（type=password），placeholder 提示
  「留空或保持 ******** 表示不修改」；点「测试连接」时对已有挂载若密码为空或为掩码则显式回传 ********，
  让后端按「不修改」处理（与迁移前同一段逻辑）；
- 测试连接按钮放在页脚最左侧（迁移前的按钮位置），busy 态用 sl-button 的 loading + disabled，
  结果文案与 toast 都保留；注意这个按钮不能写在 openDialog 的 onMount 回调里 ——
  sl-dialog 的 show() 可能同步 resolve，那时 onMount 会先于 const api = ... 赋值执行（本批踩到的坑，见第 6 节）；
- 目录浏览对话框：上一级 / 刷新 / 面包屑 / 目录行「打开」，排序仍是目录在前、同名按名称比较，
  条目表用 nunt-table（名称/类型/大小/修改时间/操作），空目录与读取失败走 kit 的三态；
- 删除用 confirmDialog（文案逐字保留），提示用 toast；挂载列表加载失败是 nunt-error + 重试。

### 2.3 pages/forward.js（930 → 529 行）

- 规则表格改用 nunt-table：名称（含备注）/ 协议 / 源地址 / 目标地址 / 活跃连接 / 累计连接 / 状态 / 操作；
  操作列走 actions（右对齐、不换行），列标题全部有文字 —— 迁移前 th:nth-child(8) 的空标题
  （axe empty-table-header）与 h3 标题（heading-order）两条都消失；
- 协议筛选从自绘 tabs 换成带可见 label 的 sl-select（全部/TCP/UDP/TCP+UDP，值与筛选语义不变），
  搜索仍是名称/源/目标/协议四个字段的 200ms 防抖关键字；
- 活跃连接列显示 live 值与上限（connLimit，后端 ruleView 提供），累计连接列显示 totalConns；
  字段名回退顺序（active/activeConns/curConns/connections 与 total/totalConns/accepted/conns）保持不变；
- 状态开关用 sl-switch（可见文字「已启用/已停用」放在开关标签里），切换走 toggle 接口、失败退回 PUT；
- 新建 / 编辑表单走 openDialog + formGrid：名称、启用、协议、源地址、目标地址、超时（秒）、IP 策略、
  IP 列表（多行文本，每行一条、支持 CIDR）、备注；校验文案与迁移前一致；
- 「转发日志」对话框：5 秒轮询 GET /api/v1/forward/logs?rule=&limit=200，关闭对话框或离开页面都会
  真的停掉轮询（页面 dispose 会清掉所有轮询器与对话框）；日志行仍是「时间 来源 -> 目标 上行/下行」。

### 2.4 pages/task.js（975 → 649 行）

- 任务表格改用 nunt-table：名称（含备注）/ Cron / 动作（类型徽标 + 超出部分 +N）/ 上次运行（时间 + 相对时间）/
  下次运行 / 运行结果（失败红色徽标）/ 状态 / 操作；标题全部有文字，empty-table-header 与 heading-order 一起消失；
- 「立即运行」走 POST /api/v1/task/items/{id}/run，按钮有 loading 态，toast 文案保留；
- 新建 / 编辑走 openDialog：名称、启用、Cron 表达式、备注 + 动作列表编辑器（nunt-action-list：
  按类型显示字段、增删行、每行独立的类型下拉），校验文案与迁移前一致
  （请填写任务名称 / 请填写 Cron 表达式 / 请至少添加一个动作）；
- Cron 常用示例按钮（7 个）挂在 cron 输入框下面，点击填入并 toast「已填入：…」；
  cron 字段用 formGrid 的 custom 字段把「sl-input + 示例按钮」整块交给 kit 渲染
  （原因见第 6 节：nunt-form 是 Lit 组件，fields 的 DOM 要等第一次更新完成才存在）；
- 动作类型与字段：module.toggle（模块名 + 启动/停止/重启）、rule.toggle（模块 + 规则 ID + 启用/停用）、
  http.request（方法/URL/请求头 key: value 多行/请求体）、notify.webhook（webhook ID/事件/通知内容）、
  shell.exec（命令）；提交体形状与迁移前完全一致（rule.toggle 的启用开关仍然放在 url 字段里，
  notify.webhook 的事件仍然写成 headers.__events）；
- 删除确认统一走 confirmDialog；shell 动作需要在服务端显式开启的提示保留在卡片页脚。

## 3. kit 用法要点（本批实际用到的）

1. 页面 = light DOM 的 NuntElement 子类 + define('nunt-page-xxx', Klass)；mount 里先 page.ctx = ctx
   再 root.appendChild(page)，cleanup 返回 () => { page.dispose(); offStyle(); }；
2. 表格：<nunt-table .columns .rows .loading .error .onRetry .rowKey empty emptyHint caption .sortable>；
   操作列写 actions: true（右对齐、不换行、包在 .nunt-actions 里）；行内按钮用 render(row) 返回 Lit 模板；
   rowKey 对日志这种内容可重复的数据要自己造稳定键（本批用自增 seq）；
   冻结列宽 + 长文本用页面样式做 word-break / 悬挂缩进（logs 页就是这么修换行缩进的）；
3. 表单：formGrid([...]) 返回 { node, read, get, set, error, fieldError, toggle, clearErrors }；
   label 交给 sl-input/sl-select 的 label 属性（axe 的 label / select-name 自然消失）；
   按类型显隐字段用 form.toggle(name, visible)（storage 的 local/webdav）；
   **不要用「先 formGrid 再 form.node.querySelector」的方式往字段里塞附加 DOM** ——
   nunt-form 的字段 DOM 要等第一次更新完成才存在，本批改用 type:'custom' + node 让 kit 负责渲染；
4. 对话框：openDialog({ title, body, actions, wide, onClose, onMount })；提交中 dlg.setBusy(true, button)；
   保存失败保留对话框写 close: false；**不要依赖 onMount 的时序**（show() 可能同步 resolve），
   需要在页脚加东西就在 openDialog 返回之后直接对 api.footer 操作；
5. 提示：toast(msg, 'ok'|'err'|'warn'|'info')、confirmDialog(msg, { danger, okLabel })；
6. 三态：直接写 <nunt-empty> / <nunt-loading> / <nunt-error .error .onRetry heading hint compact> 元素；
7. 卡片标题一律 h2（外壳顶栏是 h1），页面私有样式统一前缀并随 cleanup 移除；
8. 错误文案走 errorMessage() / nunt-error 内部的 friendlyMessage()；
9. 页面里不要再定义叫 remove / appendChild 之类会遮蔽 HTMLElement 同名方法的成员
   （本批踩到的坑，见第 6 节），页面自己的动作方法用 removeMount / removeRule / removeTask 这类名字。

## 4. axe 对比（critical / serious / moderate / minor）

> 口径：阶段 1 / 阶段 2A 的数字取自 docs/screenshots/phase1/a11y.json 与 phase2a/a11y.json
> （同一套 axe-core 4.14.0 与规则标签）；阶段 0 的逐页数字当时没有按页归档，本表不引用。

| 页面 | 阶段 1 | 阶段 2A | 阶段 2B（本批） |
| --- | --- | --- | --- |
| #/logs | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| #/storage | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| #/forward | 1 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| #/task | 1 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| 四页合计 | 2 / 0 / 2 / 2 | 0 / 0 / 2 / 2 | 0 / 0 / 0 / 0 |
| 12 页合计 | 14 / 0 / 7 / 7 | 8 / 0 / 6 / 6 | 8 / 0 / 4 / 4 |

- forward 与 task 阶段 1/2A 的 empty-table-header(minor) 来自操作列的空 th（迁移前自绘表格 title:''），
  heading-order(moderate) 来自卡片的 h3；nunt-table 的 actions 列 + h2 标题两条一起消失；
- 本批新增过一次 serious（每个状态开关 1 条 label-title-only），已修掉并写进第 6 节；
  现在剩余 axe 全部集中在未迁移页：waf 的 8 条 critical（label 2 + select-name 6）+
  1 条 empty-table-header + 1 条 heading-order，web / ddns / acme 各 1 条 empty-table-header + 1 条 heading-order；
- 浅色主题补测（临时脚本，用同一套 axe 规则）四页同样全 0，坐实不是「只在深色下好看」。

## 5. 体积对比（四个页面的原始 / gzip / br 字节）

| 文件 | 原始旧 | 原始新 | Δ原始 | gzip 旧 | gzip 新 | Δgzip | br 旧 | br 新 | Δbr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pages/logs.js | 9247 | 16262 | +7015 | 2971 | 6075 | +3104 | 2455 | 4933 | +2478 |
| pages/storage.js | 14346 | 21492 | +7146 | 4022 | 6891 | +2869 | 3336 | 5672 | +2336 |
| pages/forward.js | 38288 | 20831 | −17457 | 12262 | 7091 | −5171 | 10535 | 5856 | −4679 |
| pages/task.js | 42742 | 27374 | −15368 | 13456 | 8620 | −4836 | 11562 | 7141 | −4421 |
| 合计 | 104623 | 85959 | −18664 | 32711 | 28677 | −4034 | 27888 | 23602 | −4286 |

口径：旧 = git show 5bb6203:<path> 的字节（本批开始前的工作区状态）；新 = 工作区文件字节；
两边都是 LF、与 //go:embed all:assets 打进二进制的内容一致；gzip 用 zlib level 9、br 用 brotli quality 11。

结论：forward 与 task 页因为甩掉了整套自包含兜底（el/makeEl/modal/tableEl/字段构件/DNS 供应商兜底，
共约 1000 行重复代码）单页小了 40% 左右；logs 与 storage 因为改用 Lit 组件类变大一些；
四个页面合计原始 −18664 字节、gzip −4034 字节、br −4286 字节。

## 6. 本次踩到并修掉的坑（值得写进后续批次的检查表）

1. **页面成员方法名遮蔽 HTMLElement.remove()**：storage/forward/task 三个页面把删除动作写成
   `async remove(row)`，于是 dispose() 里的 `this.remove()` 调到了自己（row undefined）：
   页面元素没被摘掉，还在控制台抛一条 TypeError。改名 removeMount / removeRule / removeTask 后恢复正常
   （cleanup 后 DOM 真的被移除，baseline 的未捕获异常从 2 条变 0 条）。
   后续批次：页面里不要用 remove / append / cloneNode 这类 DOM 同名成员名。
2. **sl-switch 的可见标签**：状态列里原来写成 `<sl-switch title="..." aria-label="..."></sl-switch>`
   ＋ 旁边一个 muted 的「已启用」文本，axe 判 label-title-only / serious
   （规则逻辑是「没有可见 label，但存在 title/aria-describedby」；aria-label 不算可见 label）。
   修法：把状态文字放进 sl-switch 的可见标签里（表单里的 switch 字段本来就是这个写法），
   不再给状态开关单独的 aria-label。
3. **openDialog 的 onMount 时序**：storage 的「测试连接」按钮原来写在 onMount 回调里，
   而 `const api = openDialog(...)` 尚未赋值时 onMount 就可能同步执行（dialog.show() 已 resolve），
   于是 api 是 undefined、按钮根本没插进页脚。改成 openDialog 返回后直接用 api.footer 操作。
4. **不要往 nunt-form 的字段里后插 DOM**：task 的 cron 示例按钮原来等 updateComplete 之后
   querySelector 找 cron 输入框再 append，实测首次打开对话框时表单还没渲染，按钮全丢。
   改用 formGrid 的 type:'custom' + node，把「sl-input + 按钮组」整块交给 nunt-form 渲染。
5. **测试脚本自身的坑（写进本说明避免下次重踩）**：给 sl-input 赋值必须走内部原生 input 的输入
   （元素上直接 .value = ... 不会派发 sl-input，页面的 draft 不会更新）；表单校验要
   `form.fieldError('cron', …)` 这类路径也要把字段 DOM 渲染出来才会命中；
   保存是异步的，断言要等 toast / 对话框关闭，不要用固定 sleep。

## 7. 验收命令与真实输出

环境前缀（每条 pwsh 都带，值与 PHASE1-NOTES 第 7 节一致）：GOMODCACHE / GOCACHE / GOPATH 指向仓库内 .gocache，
GOFLAGS=-mod=mod，GOTOOLCHAIN=auto，GOTMPDIR=TMP=TEMP=仓库内 .gocache/tmp，PATH 前置 Go 的 bin 目录。

    # 1) Go
    go build ./...                      # GO_BUILD_EXIT=0
    go vet ./...                        # GO_VET_EXIT=0
    go test ./... -count=1 -p 1         # TEST_EXIT=0
    #   ok github.com/nunt/nunt/internal/api 10.190s
    #   ok github.com/nunt/nunt/internal/app 2.585s
    #   ok github.com/nunt/nunt/internal/modules/waf 49.137s
    #   ok github.com/nunt/nunt/internal/webui 0.519s   （其余包全部 ok / no test files）

    # 2) 前端采集（真实二进制 + 无头 Chromium）
    go build -o nunt.exe ./cmd/nunt
    node scripts/ui-baseline.mjs --out docs/screenshots/phase2b --label 'phase2 batch B'
    # [baseline] 服务就绪：http://127.0.0.1:16601（已从 stdout 抓到初始管理员密码）
    # [baseline] 演示数据：11/11 成功
    # [baseline] 采集页面 #/dashboard … #/settings（共 12 页）
    # [baseline] 已写出 REPORT.md / a11y.json / baseline.json 到 docs/screenshots/phase2b
    # [baseline] 汇总：console 0，失败请求 0，外部请求 0，axe 严重 8，重要 0
    # BASELINE_EXIT=0

    # 3) 补测（临时脚本在 .gocache/tmp，不属于仓库 scripts/）
    node .gocache/tmp/light-check-2b.mjs     # LIGHT-CHECK: PASS
    node .gocache/tmp/pages-smoke-2b.mjs     # PAGES-SMOKE: PASS（59 步 / 0 失败 / console 0）

    # 4) 体积
    node .gocache/tmp/sizes-2b.mjs           # 见第 5 节表格

    # 5) vendor
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly   # [ok] vendor 目录与 VERSION.md 记录一致；VENDOR_EXIT=0
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly      # [ok] lit vendor 目录与 VERSION.md 记录一致；LIT_EXIT=0

REPORT.md 第 1 节的原始数字：页面数 12、页面未挂载出内容 0、console 报错+警告 0、未捕获异常 0、
失败请求 0、HTTP 4xx/5xx 响应 0、外部请求 0、横向溢出的页面 0、axe 严重 8 / 重要 0 / 中等 4 / 轻微 4。
四个页面的逐页结果（REPORT.md 第 4 节）：#/logs 0/0/0/0、#/storage 0/0/0/0、#/forward 0/0/0/0、#/task 0/0/0/0。

## 8. 未完成项与需要决策的点

1. forward 的「访问日志」在基线的演示数据里没有真实流量，所以三张截图里是友好空态；
   表格与字段名（src/dst/bytesIn/bytesOut 的多种别名）按迁移前逐字段搬过来，但没有真机流量验证。
   需要决策：是否在演示数据里补一次真实 TCP 连接（脚本里连一下转发端口）让日志对话框有内容。
2. task 的 notify.webhook 动作里「事件」仍然沿用迁移前的写法（单选 -> headers.__events），
   迁移前那个多行事件文本框（events）本来就是写死的空数组，本批保持同等语义没有扩成多选；
   需要决策：是否把事件改成真正的多选（要动提交体形状，属于接口语义变更，本批没做）。
3. 体积上 logs / storage 两页变大（各 +7KB 左右）。它们本来就是「纯命令式 DOM」的页面，
   迁移到 Lit 组件类必然变大；四页合计仍是负增长。如果在意首屏字节，可以考虑后续批次把
   kit 里 formatTime/fmtBytes 这类纯函数从 lib/ui.js 搬进来（属阶段 3）。
4. 剩余 axe：#/waf 的 8 条 critical（label 2 + select-name 6），以及 web / ddns / acme / waf 的
   empty-table-header / heading-order 各若干，留给后续批次。
5. 本批的补测脚本仍是临时的：light-check-2b.mjs / pages-smoke-2b.mjs 放在 .gocache/tmp（gitignore），
   没有进 scripts/。建议阶段 2 收尾时把「浅色主题 axe + 逐页交互冒烟」固化进 scripts/
   （例如扩展 kit-smoke.mjs），但那需要动仓库脚本，超出本批「只改四个页面文件」的约束。
6. 迁移期遗留层（style.css 第 6 节）还在：四个页面仍复用了 .card / .card-header / .card-body /
   .sub / .spacer / .muted / .mono / .row，页面自己的样式全部用私有前缀随 mount 清理。
   等 11 个页面全部迁完再整节删除（属阶段 3）。
