# 阶段 2 批次 D 验收记录（web / waf 迁移到 kit）

> 由本次迁移生成，配合 docs/PLAN-frontend-webcomponents.md 与 docs/CONTRACT.md 第 7 / 8 节。
> 机器数据见同目录 baseline.json / a11y.json / REPORT.md（12 页截图、逐页 console/请求/axe 明细）、
> light-theme-pages.json（浅色主题补测）。交互冒烟的明细不属于仓库（在 .gocache/tmp/pages-smoke-2d.json）。
> 本批只改了 2 个页面文件：internal/webui/assets/pages/web.js 与 waf.js，以及 docs/screenshots/phase2d/ 的采集产物。

## 1. 结论

| 验收项 | 结果 |
| --- | --- |
| go build ./... | 通过（GO_BUILD_EXIT=0） |
| go vet ./... | 通过（GO_VET_EXIT=0） |
| go test ./... -count=1 -p 1 | 通过（全部 ok，TEST_EXIT=0） |
| ui-baseline 采集（12 页 + 登录页） | console 0、未捕获异常 0、失败请求 0、外部请求 0、HTTP 4xx/5xx 0、未挂载 0、横向溢出 0 |
| axe：web / waf | **critical 0 / 0，serious 0 / 0，moderate 0 / 0，minor 0 / 0** |
| axe 合计（12 页） | critical 8 → **0**（归零）、serious 0 → 0、moderate 2 → 0、minor 2 → 0 |
| 浅色主题补测（web + waf + web 新建对话框 + notify 对照） | 两页页面级全 0；对话框只剩 kit 层的两条 landmark（对照页 notify 同样有）与 axe 对视口外控件的 label-title-only 误判 |
| 交互冒烟（两页，37 步） | 全部通过，console 报错 0（PAGES-SMOKE: PASS） |
| 体积（两页合计） | 原始 −27786 字节、gzip −8239 字节、br −7565 字节 |
| 体积（整棵前端资源树） | 原始 −27786、gzip −8239、br(q6) −8102（相对批次 D 起点 d6fef66） |
| sync-vendor.ps1 -VerifyOnly | [ok] vendor 目录与 VERSION.md 记录一致（VENDOR_EXIT=0） |
| sync-lit.ps1 -VerifyOnly | [ok] lit 目录与 VERSION.md 记录一致（LIT_EXIT=0） |

## 2. 改动清单

只动了 web.js 与 waf.js（外加本说明与 phase2d 的采集产物）：kit.js、app.js、style.css、lib/api.js、
vendor/**、任何 Go 代码都没碰；页面契约 export default { id, title, icon, mount(root, ctx) } 与 ctx 语义不变。
两页都从「命令式 el() 拼 DOM + 400 余行自包含兜底（el/makeEl/modal/字段构件/fetch 包装）」改成
NuntElement 子类 + Lit 模板 + kit 组件，卡片标题一律 h2，页面私有样式用 pweb- / pwaf- 前缀，
随 mount 返回的 cleanup 一起移除；cleanup 还会停掉全部轮询定时器、关掉本页打开的对话框、
renderInto(host, nothing) 清掉对话框内容（两页都没有 SSE 订阅，所以没有 offSSE 需要调用 ——
web 的实时性来自 5 秒轮询、waf 来自 10 秒 / 15 秒轮询）。

### 2.1 pages/web.js（1384 → 1121 行）

- 规则表改 nunt-table，列：名称（含路径副行）/ 类型 / 监听（sl-tag，超出 +2）/ 域名（同左）/ 目标摘要 /
  TLS / WAF / 状态（sl-switch，文字放进可见标签）/ 操作（actions：访问日志·编辑·删除，右对齐不换行）；
  迁移前那张自绘表的空 th（empty-table-header）与 h3 卡片标题（heading-order）一起消失；
- 类型筛选从自绘 tabs 换成 sl-tab-group（全部 + 反向代理/重定向/静态托管/文件管理/WebDAV），
  搜索仍是名称/id/监听/域名/路径/类型六个字段的 200ms 防抖关键字；
- 新建 / 编辑改 openDialog + formGrid（**一个** 表单，56 个字段位），按类型显隐用 form.toggle：
  proxy（上游多行 / 负载均衡 / Host 头 / 请求与响应头 nunt-kv / 路径重写前缀与替换 /
  超时 / 跳过证书 / 禁用压缩 / **h2c**）、redirect（目标 / 状态码 / 保留路径）、
  static（挂载下拉或本地目录 / index / 目录列表 / SPA / 缓存秒数）、
  filebrowser 与 webdav（挂载 / 根目录 / 标题 / 只读 / 上传·删除·新建·重命名 / 显示隐藏 / 分享链接与有效期）；
  公共区：名称 / 类型 / 启用 / 监听多行 / 域名多行 / 路径 / 优先级 / TLS（off·auto·custom + 证书下拉 + HSTS）/
  访问控制（IP 与 UA 黑白名单多行 + 模式）/ BasicAuth / WAF 开关 + 请求体策略（下拉 + 实时说明）；
- BasicAuth 改成「账号列表」编辑器（custom 字段里自管节点）：每个账号一行 [用户名][密码][删除] + 「添加账号」，
  密码框占位符写明「留空表示不修改」，不回显 argon2 哈希；提交体仍是 { enable, users: [{username,password}] }；
- 访问日志对话框 5 秒轮询可停：关闭对话框、离开页面都会真的停（stop 记在 logPollers 里，dispose 全部调用）；
  日志行保持迁移前的显示口径（时间 客户端 方法 路径 状态 耗时）；
- #/web?rule=<id> 深链：搜索框预填 rule id 自动过滤 + 目标行高亮（行内隐藏标记定位，表头排序后依然正确）+
  顶部提示条（含「设置请求体策略」按钮）；
- 状态开关走 POST /rules/{id}/toggle（失败退回 PUT 全量更新）、删除走 confirmDialog。

### 2.2 pages/waf.js（2082 → 1791 行）

五张卡片（全部 h2）：WAF 配置 / 请求体检查策略 / 规则文件·规则组 / 请求测试 / 拦截日志。

- **全局配置表单**（formGrid）：总开关 / 模式 / 内置 CRS / 仅记录 / 保护后台 / CRS 等级 PL /
  执行等级 / 入站阈值 / 出站阈值 / 请求体上限（KB）/ 附加 SecLang 片段；保存时回传原配置对象再覆盖
  （Object.assign({}, config, {...})），并在规则列表加载成功时按勾选状态重算 disabledRules；
- **请求体检查策略面板**：执行模式 observe↔enforce（切换时弹确认框，取消即不提交）、默认策略、
  PeekBytes 与 PeekTimeoutMS（带边界校验 + 动态说明，fmtBytes 显示）、非 full 占比告警阈值
  （0–1 边界校验，越界时字段级红字 + toast 且不提交；后端未返回该字段时黄字说明）；
  bodyState 七格分布 + 总样本与非 full 占比；拒绝计数（refused / wouldReject / 环形缓冲 kept-limit +
  写满提示）；gRPC 统计 8 项；wouldReject 样例表按 enforced 分四组（全部 / 实际拒绝 / 观察期本应拒绝 /
  未返回）筛选 + grpc-status 展示（含中文含义）+ reason 中文标签；未声明 bodyPolicy 的路由表
  （名称 / 路径 / 类型 / WAF 开关 / 当前继承 / 拒绝样例 / 操作）与一键 **#/web?rule=id** 跳转；
  面板底部保留「数据来源」与字段兼容读取的痕迹；
- **规则文件多选列表**：搜索（防抖）+ 每条 sl-checkbox（可见标签是标题）+ 规则 ID + 条数徽标；
  勾选状态来自后端 enabled（crs disabled 不算用户取消勾选），保存时按 minId-maxId 区间写 disabledRules；
- **拦截日志**：nunt-table（时间 / 动作 / 客户端 / 请求 / 规则 / 说明），每 10 秒自动刷新；
- **请求测试**：方法 / URL / 请求体 → 是否拦截徽标 + 结果表（命中规则数 / 规则 ID / 异常分数 / 动作 / HTTP 状态）；
- 策略面板每 15 秒自动刷新，正在面板里编辑时跳过这一轮；两个轮询与全部对话框在 dispose 里清干净。

## 3. kit 用法要点（本批实际用到的）

1. 页面 = light DOM 的 NuntElement 子类 + define('nunt-page-xxx', Klass)；mount 里先 page.ctx = ctx
   再 root.appendChild(page)，cleanup 返回 () => { page.dispose(); offStyle(); }；
2. 表格：<nunt-table caption .columns .rows .loading .error .onRetry .rowKey empty emptyHint>；
   操作列写 actions: true（右对齐、不换行、包在 .nunt-actions 里）；列 title 省略或为空时 kit 自动按
   「操作」渲染，empty-table-header 自然消失；状态开关的文字必须放进 sl-switch 的可见标签；
3. 表单：formGrid([...]) 返回 { node, read, get, set, error, fieldError, toggle, clearErrors }；
   label 交给 sl-input/sl-select/sl-textarea，switch 用 text；**按类型显隐字段时不要「逐类型覆盖」**——
   filebrowser 与 webdav 共用同一组字段，后一个类型会把前一个刚打开的字段又关掉；正确做法是算出
   「当前类型允许的字段集合」，对全集统一 form.toggle(name, active.has(name))；
4. 动态区块（BasicAuth 账号列表）继续用 formGrid 的 type:'custom' + 页面自管节点，不往字段里后插 DOM；
   这里的账号行是页面自己 new 出来的 sl-input（带 label），因此 axe 的 label / select-name 也不报；
5. 提示 / 对话框 / 三态：toast(msg, 'ok'|'err'|'warn'|'info')、confirmDialog(msg, { danger, okLabel })、
   openDialog({ title, body, actions, wide, onClose })、<nunt-empty> / <nunt-loading> / <nunt-error>；
   提交中 dlg.setBusy(true, button)，保存失败写 close: false 保留对话框并用 form.error() 呈现；
6. WAF 页的卡片骨架放在 render() 里（标题 h2 + 按钮），各分区用 <div data-host="..."> 占位，
   数据到达后 renderInto(host, template) 重画；宿主 div 在 Lit 模板里没有任何子绑定，重渲染不会清掉
   命令式画进去的内容 —— 这样既保住「不重画输入中的控件」，又不用整页手写 DOM；
7. 页面私有样式统一 pweb- / pwaf- 前缀，随 cleanup 移除；不要用 remove / appendChild 这类 DOM 同名成员名
   （删除动作叫 removeRule）。

## 4. axe 对比（critical / serious / moderate / minor）

> 口径：阶段 0/1/2A/2B/2C 的数字取自 docs/screenshots/<before|phase1|phase2a|phase2b|phase2c>/a11y.json
> （同一套 axe-core 4.14.0 与规则标签 wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice）。

| 页面 | 阶段 0（迁移前） | 阶段 1 | 阶段 2A | 阶段 2B | 阶段 2C | 阶段 2D（本批） |
| --- | --- | --- | --- | --- | --- | --- |
| #/web | 1 / 5 / 23 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | **0 / 0 / 0 / 0** |
| #/waf | 9 / 14 / 34 / 1 | 8 / 0 / 1 / 1 | 8 / 0 / 1 / 1 | 8 / 0 / 1 / 1 | 8 / 0 / 1 / 1 | **0 / 0 / 0 / 0** |
| 两页合计 | 10 / 19 / 57 / 2 | 8 / 0 / 2 / 2 | 8 / 0 / 2 / 2 | 8 / 0 / 2 / 2 | 8 / 0 / 2 / 2 | **0 / 0 / 0 / 0** |
| **12 页合计** | 26 / 110 / 188 / 7 | 14 / 0 / 7 / 7 | 8 / 0 / 6 / 6 | 8 / 0 / 4 / 4 | 8 / 0 / 2 / 2 | **0 / 0 / 0 / 0** |

- **12 页合计 critical 归零**（8 → 0）：最后 8 条 critical 全部在 waf 页（label 2 + select-name 6），
  换成 formGrid 之后控件与标签天然关联，一次清空；web 与 waf 的 empty-table-header（操作列空 th）
  与 heading-order（h3 卡片标题）也随 nunt-table 的 actions 列与 h2 标题消失；
- 本批还顺手清掉了 waf 页新引入的 3 条 serious（color-contrast）：pwaf-state 里的小字原本用 --text-faint，
  在深色主题的 --bg-soft 上对比度不够，改成 --text-dim 后归零；
- 12 页现在是 **四档全 0**：critical 0 / serious 0 / moderate 0 / minor 0（REPORT.md 第 1 节的原始数字）；
- 浅色主题补测：web 0/0/0/0、waf 0/0/0/0；web 的「新建 Web 规则」对话框里只剩 4 条 axe 对视口外控件的
  label-title-only 误判（不计数）与 2 条 landmark（sl-dialog 影子 DOM 的 header 造成，对照页 notify 的
  对话框一模一样 —— kit 层现象，见 PHASE2C-NOTES 第 6 节）。

## 5. 体积对比

### 5.1 两个页面（原始 / gzip / br 字节）

| 文件 | 原始旧 | 原始新 | Δ原始 | gzip 旧 | gzip 新 | Δgzip | br 旧 | br 新 | Δbr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pages/web.js | 59706 | 50457 | −9249 | 19016 | 16392 | −2624 | 16129 | 13576 | −2553 |
| pages/waf.js | 102115 | 83578 | −18537 | 30062 | 24447 | −5615 | 25067 | 20055 | −5012 |
| 合计 | 161821 | 134035 | **−27786** | 49078 | 40839 | **−8239** | 41196 | 33631 | **−7565** |

口径：旧 = git show d6fef66:<path> 的字节（本批开始前的工作区状态）；新 = 工作区文件字节；
两边都是 LF、与 //go:embed all:assets 打进二进制的内容一致；gzip 用 zlib level 9、br 用 brotli quality 11。
两页本来各自带着一整套 el/makeEl/modal/tableEl/字段构件/fetch 包装（各约 400 行）＋自己的 CSRF 与错误
文案兜底，换成 kit 之后单页小了 15%~18%，而且不再各自维护一份。

### 5.2 整棵前端资源树（internal/webui/assets，316 个文件）

| 口径 | 原始 | gzip | br |
| --- | --- | --- | --- |
| 阶段 0 记录（docs/screenshots/before/REPORT.md 第 7 节，303 个文件，br q6） | 1,203,945 | 357,727 | 328,996 |
| 批次 D 起点 d6fef66（同一套脚本重测） | 1,246,291 | 375,954 | 342,010（q6） |
| 批次 D 终点（工作区） | 1,218,505 | 367,715 | 333,908（q6）/ 309,269（q11） |
| 批次 D 净变化 | **−27,786** | **−8,239** | **−8,102**（q6） |
| 与阶段 0 相比 | +14,560 | +9,988 | +4,912（q6） |

- 「与阶段 0 相比」为正，是阶段 1（外壳 + 登录页 + kit 落地）与阶段 2A–2C 已经发生的增长
  （kit 与页面都变大了一点，vendor 树在阶段 1 之后还补齐过文件：阶段 0 记录 303 个文件，现在 316 个）。
  本批的贡献是净减少 27,786 / 8,239 / 8,102，而且整棵树里**只有 pages/web.js 与 pages/waf.js 两个文件
  发生变化**（脚本会打印 changed files，用来证明没有顺手改别的东西）。
## 6. 本次踩到并查清的坑（含迁移前就存在的接口 / 前端不一致）

1. **代理规则从来存不下来（迁移前缺陷，本批必须修）**：页面提交的是 disableCompres，而后端
   model.ProxyTarget 的 JSON tag 是 disableCompression；rest.Decode 开了 DisallowUnknownFields，
   于是保存直接 400：invalid json body: json: unknown field "disableCompres"。也就是说「禁用压缩」
   不仅没生效，整条代理规则都存不下来。本批只提交后端认识的 disableCompression。
   （曾尝试「新旧两个键都带上」，被 DisallowUnknownFields 当场否掉，所以只能改键名。）
2. **负载均衡选项全部是后端不认识的值**：后端 newBalancer 只接受 "" | roundrobin | random | iphash，
   页面给的是 round_robin / random / ip_hash / least_conn，且新建规则的默认值就是 round_robin ——
   保存必然 400 unsupported balance strategy。本批把选项改成 roundrobin / random / iphash（中文标签
   不变），读回旧值时按别名归一（round_robin→roundrobin、ip_hash→iphash）；「最少连接」后端没有实现，去掉。
3. **请求测试一直提交失败**：POST /api/v1/waf/test 的提交体里多带了一个 path 别名，后端 testRequest
   没有这个字段 → 400。本批去掉，只保留 method / url / body。
4. **BasicAuth「密码留空」在旧实现里是删用户**：旧逻辑在密码留空时 delete out.users，后端于是拿到
   enable=true、users 为空，直接以 basic authentication is enabled without users 拒绝保存。
   后端 hashAuthUsers 真正支持的语义是「用户名在旧规则里存在 + 密码留空 = 保留原哈希」，
   本批按这个语义做成账号列表，留空即回传空字符串（冒烟里验证了哈希前后一致）。
5. **filebrowser / webdav 有后端安全闸**：不带 BasicAuth 时必须 access.mode=allow + IP 列表，
   否则保存被拒（type webdav exposes the file storage without authentication…）。这不是页面 bug，
   但演示数据 / 冒烟数据必须给对，否则五种类型里有两个永远存不上。
6. **按类型显隐字段的覆盖顺序**：filebrowser 与 webdav 共用同一组字段名，「对每个类型
   form.toggle(name, key === type)」会让后一个类型把前一个类型刚打开的字段关掉（webdav 排在
   filebrowser 后面，于是 filebrowser 的字段全被隐藏）。改成「先算当前类型的字段集合，再对全集统一 toggle」。
7. **bodyState 只在有流量时才有数**：管理 API 报的就是规则级中间件用的那个实例的计数
   （实测请求 3 次受保护路由后 stats.bodyStates.full=3）。空实例下七格分布与样例表都是「暂无」空态 ——
   这与迁移前的行为完全一致（旧页面也是 if (!total) 显示空态）。为了验证七格 / 计数卡 / 样例表 /
   gRPC 行的完整渲染，冒烟脚本用 page.route 桩了一份 GET /waf/config 的响应。
8. **Windows 上刚 kill 掉的 nunt.exe 会 EBUSY**：临时脚本里 spawn 立刻失败（文件还被映射 / 被杀软扫），
   加重试（最多 12 次 × 2.5 秒）后稳定。这不是仓库问题，写在这里避免下次重踩。
9. **用 IP 直连受保护路由时 Host 不匹配**：种子规则带 domains 时，fetch http://127.0.0.1:port/ 会 404
   （不产生 bodyState 样本）；冒烟里的静态规则因此不带 domains。
10. **sl-dialog 的两条 landmark best-practice**（landmark-no-duplicate-banner / landmark-unique，
    指向 .topbar）来自 sl-dialog 影子 DOM 里的 header，对照页 notify 的对话框一模一样，属 kit 层现象，
    需要动 kit.js 才能消掉（超出本批「只改两个页面文件」的约束，沿用批次 C 的记录口径）。

## 7. 验收命令与真实输出

环境前缀（每条 pwsh 都带，值与 PHASE1-NOTES 第 7 节一致）：GOMODCACHE / GOCACHE / GOPATH 指向仓库内 .gocache，
GOFLAGS=-mod=mod，GOTOOLCHAIN=auto，GOTMPDIR=TMP=TEMP=仓库内 .gocache/tmp，PATH 前置 Go 的 bin 目录。

    # 1) Go
    go build ./...                      # GO_BUILD_EXIT=0
    go vet ./...                        # GO_VET_EXIT=0
    go test ./... -count=1 -p 1         # TEST_EXIT=0（全部 ok；waf 33.2s、web 11.1s、api 11.1s 是最慢的三个包）

    # 2) 前端采集（真实二进制 + 无头 Chromium）
    go build -o nunt.exe ./cmd/nunt
    node scripts/ui-baseline.mjs --out docs/screenshots/phase2d --label 'phase2 batch D'
    # [baseline] 服务就绪：http://127.0.0.1:16601（已从 stdout 抓到初始管理员密码）
    # [baseline] 演示数据：11/11 成功
    # [baseline] 采集页面 #/dashboard … #/settings（共 12 页）
    # [baseline] 已写出 REPORT.md / a11y.json / baseline.json 到 docs/screenshots/phase2d
    # [baseline] 汇总：console 0，失败请求 0，外部请求 0，axe 严重 0，重要 0
    # BASELINE_EXIT=0

    # 3) 补测（临时脚本在 .gocache/tmp，不属于仓库 scripts/）
    node .gocache/tmp/light-check-2d.mjs     # LIGHT-CHECK: PASS（浅色主题 + web 新建对话框 + notify 对照）
    node .gocache/tmp/pages-smoke-2d.mjs     # PAGES-SMOKE: PASS（37 步 / 0 失败 / console 0）

    # 4) 体积
    node .gocache/tmp/sizes-2d.mjs           # 见第 5 节表格；末尾会打印 changed files

    # 5) vendor
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly   # [ok] vendor 目录与 VERSION.md 记录一致；VENDOR_EXIT=0
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly      # [ok] lit vendor 目录与 VERSION.md 记录一致；LIT_EXIT=0

REPORT.md 第 1 节的原始数字：页面数 12、页面未挂载出内容 0、达到网络空闲 12/12、console 报错+警告 0、
未捕获异常 0、失败请求 0、HTTP 4xx/5xx 响应 0、外部请求 0、横向溢出 0、axe 严重 0 / 重要 0 / 中等 0 / 轻微 0。
逐页结果（REPORT.md 第 4 节）：12 页全部 0/0/0/0。

冒烟脚本覆盖的 37 步（全部 ok）：web 表格列与 tab、类型过滤、五种类型的字段显隐、TLS 证书与 BasicAuth
账号块随开关显隐、五种类型逐个保存（代理的 h2c / 禁用压缩 / 负载均衡真的落盘）、BasicAuth 密码留空不修改
（哈希前后一致）、访问日志对话框打开并轮询、关闭后 5 秒轮询真的停、#/web?rule= 深链（自动过滤 + 高亮 +
提示条 + 按钮）、waf 五张卡片与 h2、策略面板读配置、真实流量下 bodyState 七格 + 拒绝计数、策略保存生效、
越界阈值被拦、enforce 确认框（取消不提交 / 确认生效 / 切回 observe）、规则文件多选列表与搜索、
请求测试（拦截 + 命中 4 条规则 + HTTP 403）、未声明路由跳转并高亮、（桩响应）七格分布与非 full 占比、
拒绝计数与环形缓冲提示、gRPC 统计 8 项、样例按 enforced 分组 + grpc-status 13 展示 + 分组筛选、
两页 console 与外部请求 0。

## 8. 未完成项与需要决策的点

1. **四处字段级修正与「提交体不变」的冲突**（第 6 节第 1–4 条）：disableCompres→disableCompression、
   负载均衡取值、waf/test 去掉 path 别名、BasicAuth 的 users 语义。这四处如果不修，验收里的
   「五种类型的字段显隐与保存」「密码留空不修改」「请求测试」三条根本跑不通（旧代码在这四条路径上
   全部 400）。本批按「让功能真的可用」处理，提交体的**形状**没有变化（字段名与后端模型一致）。
   如果需要严格保留旧字节，请明确，我可以退回并在页面上加「后端不支持」的提示。
2. **负载均衡少了「最少连接」**：后端没有 least_conn 策略，选项里不再提供。要保留这个选项就得动后端。
3. **代理的 rateLimitPerSec / maxBodyBytes 没有暴露**：后端 model.ProxyTarget 有这两个字段，
   迁移前的页面也没有；本批保持原样（只补了验收点名要求的 h2c）。
4. **状态开关的 PUT 回退路径会把只读字段发回后端**：toggle 失败时退回 PUT 整条规则，而列表返回的
   对象带 active / upstreams / requests / configError，rest.Decode 的 DisallowUnknownFields 会 400。
   正常路径走 POST /rules/{id}/toggle 不会触发（后端有这条路由），迁移前也是这个形状，本批保留。
   需要决策：要不要把回退体收敛成模型字段（属于行为修正）。
5. **bodyState / wouldReject 的可见性依赖流量**：管理 API 实例只在真实请求经过受保护路由后才有计数；
   没有流量时页面显示「暂无」空态（与迁移前一致）。补测里用桩响应验证了完整渲染。
6. **kit 层的两条 sl-dialog landmark**：需要动 kit.js（openDialog 里给 sl-dialog 的 header 加
   aria-hidden 或换掉 header 结构）才能消掉，超出本批「只改两个页面文件」的约束。
7. **补测脚本仍是临时的**：light-check-2d.mjs / pages-smoke-2d.mjs / sizes-2d.mjs 放在 .gocache/tmp
   （gitignore），没有进 scripts/。建议阶段 2 收尾时把「浅色主题 axe + 逐页交互冒烟」固化进 scripts/。
8. **迁移期遗留层（style.css 第 6 节）还在**：两页仍复用 .card / .card-header / .card-body / .sub /
   .spacer / .muted / .mono / .notice 这些类；页面自己的样式全部用私有前缀并随 mount 清理。
   11 个页面全部迁完后整节删除（属阶段 3）。

## 9. 产物清单（docs/screenshots/phase2d）

- baseline.json / a11y.json / REPORT.md：ui-baseline 的机器数据（12 页截图 + 逐页 console/请求/axe 明细）；
- web.png / waf.png 等 12 张深色主题整页截图 + login.png；
- light-web.png / light-waf.png / light-web-dialog.png：浅色主题补测截图；
- light-theme-pages.json：浅色主题的 axe 与探针结果（含 notify 对照对话框）。

交互冒烟与体积脚本的输出不在仓库里（.gocache/tmp/pages-smoke-2d.json、pages-smoke-2d.out.txt）。
