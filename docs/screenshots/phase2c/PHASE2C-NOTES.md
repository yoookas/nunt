# 阶段 2 批次 C 验收记录（ddns / acme 迁移到 kit）

> 由本次迁移生成，配合 docs/PLAN-frontend-webcomponents.md 与 docs/CONTRACT.md 第 7 节。
> 机器数据见同目录 baseline.json / a11y.json / REPORT.md（12 页截图、逐页 console/请求/axe 明细）、
> light-theme-pages.json（浅色主题补测）；交互冒烟结果不属于仓库（在 .gocache/tmp/pages-smoke-2c.json）。
> 本批只改了 2 个页面文件：internal/webui/assets/pages/ddns.js 与 acme.js。

## 1. 结论

| 验收项 | 结果 |
| --- | --- |
| go build ./... | 通过（GO_BUILD_EXIT=0） |
| go vet ./... | 通过（GO_VET_EXIT=0） |
| go test ./... -count=1 -p 1 | 通过（全部 ok，TEST_EXIT=0） |
| ui-baseline 采集（12 页 + 登录页） | console 0、未捕获异常 0、失败请求 0、外部请求 0、HTTP 4xx/5xx 0、未挂载 0、横向溢出 0 |
| axe：ddns / acme | critical 0 / 0，serious 0 / 0，moderate 0 / 0，minor 0 / 0 |
| axe 合计（12 页） | critical 8 → 8（仍只出现在未迁移的 waf），serious 0 → 0，moderate 4 → 2，minor 4 → 2 |
| 浅色主题补测（两页 + 两页对话框 + notify 对照） | 页面级 critical/serious/moderate/minor 全 0；console 0、外部请求 0、页面内 h3 0；进度条 value 50 / 11 / 0 |
| 交互冒烟（两页，80 步） | 全部通过，console 报错 0 |
| 体积（两页合计） | 原始 −17430 字节、gzip −5713 字节、br −5259 字节 |
| sync-vendor.ps1 -VerifyOnly | [ok] vendor 目录与 VERSION.md 记录一致（VENDOR_EXIT=0） |
| sync-lit.ps1 -VerifyOnly | [ok] lit vendor 目录与 VERSION.md 记录一致（LIT_EXIT=0） |

## 2. 改动清单

只动了两个页面文件（外加本说明与 phase2c 的采集产物），kit.js、app.js、style.css、lib/api.js、
vendor/**、任何 Go 代码都没碰；页面契约 export default { id, title, icon, mount(root, ctx) } 与 ctx 语义不变。
两页都从「命令式 el() 拼 DOM + 400+ 行自包含兜底」改成 NuntElement 子类 + Lit 模板 + kit 组件，
卡片标题一律 h2，页面私有样式用 pddns- / pacme- 前缀，随 mount 返回的 cleanup 一起移除
（ddns 的 cleanup 还会 renderInto(host, nothing) 清掉状态对话框内容并关闭本页打开的对话框）。

### 2.1 pages/ddns.js（1153 → 940 行）

- 规则表改 nunt-table，列：名称（含备注副行）/ 域名（主域名 + 子域名 sl-tag）/ 提供商 / 记录类型 /
  当前 IP / 状态（sl-switch，状态文字放在开关的可见标签里）/ 操作（actions：立即执行、状态与日志、编辑、删除，
  右对齐不换行）；迁移前那张自绘表的空 th（empty-table-header）与 h3 标题（heading-order）一起消失；
- 运行状态卡改 nunt-table（规则 / 当前 IP / 上次更新 / 成功 / 失败 / 消息 / 最近日志），
  点「最近日志」开 openDialog：状态摘要用两列表格，下面是日志表（时间 / 结果 / 内容）。
  日志来源按 logs → history → records 依次回退，条目支持字符串与 {time,ok,message} 对象 —— 后端
  statusView 用的是 records，迁移前只读了 logs/history，所以旧页面的「最近日志」永远是空的，这里按同一套
  兼容链把它接上了（本条属于「多种形状兼容」，见第 6 节第 6 条）；
- 新建 / 编辑改 openDialog + formGrid：名称、提供商（select，选项来自 /api/v1/ddns/providers）、启用、
  提供商凭据（custom 字段，字段完全由 providers 元数据的 key/label/secret/required/placeholder/help
  生成，附带 authNote 提示，切换提供商时整块重建）、自定义回调（开关 + 地址/方法/请求头 kv/请求体/用户名/
  密码）、记录（主域名、子域名多行文本、记录类型、TTL、检查间隔、Cron、备注）、IPv4 / IPv6 两块（状态开关 +
  获取方式 + 按 interface / url / static 三态联动显隐的网卡名 / URL + 正则 / 静态地址）；
- 保存时掩码沿用旧值：以列表返回的 creds（后端掩码 ********）为基底，只覆盖用户真正填了内容的字段；
  提交体逐字段与迁移前一致（name/enable/provider/creds/domain/subDomains/recordType/ttl/intervalSec/cron/
  ipv4{enable,mode,value,iface,regex}/ipv6{同左}/callback{enable,url,method,headers,body,basicUser,basicPass,
  contentType,successCode}/remark）；
- 「立即执行」POST /api/v1/ddns/rules/{id}/run，把返回的 IP 或错误用 toast 呈现（data.ip → currentIp →
  addr → ipv4(/ipv6) 的回退链与迁移前一致），随后刷新规则表与状态表；
- 状态开关走 /toggle（失败退回 PUT 全量更新）、删除确认走 confirmDialog、搜索仍是名称/域名/提供商/子域名
  四个字段的 200ms 防抖关键字，空 / 加载 / 错误三态由 nunt-table 与 nunt-error 负责。

### 2.2 pages/acme.js（1125 → 1012 行）

- 证书任务表改 nunt-table：名称（含备注）/ 域名（sl-tag，超出 +N）/ 挑战 / DNS 提供商 / 密钥 / 续期提前 /
  状态（sl-switch）/ 操作（签发、编辑、删除）；
- 证书列表改 nunt-table：域名 / 签发者 / 到期时间（时间 + 「N 天前 到期」）/ 剩余天数 / 来源 / 操作（删除）。
  剩余天数用 sl-progress-bar + 「N 天」文案，进度仍按 90 天有效期估算（迁移前口径），
  天数 ≤ 0 用 --err、≤ 15 用 --warn、否则 --ok（通过 --indicator-color 传给组件，不隔断样式）；
- 新建 / 编辑任务走 openDialog + formGrid：名称、启用、域名（多行）、密钥类型、挑战方式
  （http-01 / dns-01 / tls-alpn-01）、续期提前天数、DNS 提供商 + 解析服务器 + 凭据（custom 字段，由
  /api/v1/ddns/providers 元数据生成），选 dns-01 才显示这三个 DNS 字段（值照旧提交，与迁移前一致）；
- 签发：POST /api/v1/acme/jobs/{id}/issue（后端 202 立即返回，签发在后台跑），对话框里显示进度条 +
  「已等待 N 秒，尚未在证书列表中看到该域名…」，每 5 秒 GET /api/v1/acme/certificates，命中该任务的全部域名
  （去掉 *. 前缀比较）就结束并展示证书摘要；页脚「取消等待」停掉轮询，关闭对话框与离开页面同样会停
  （dispose 会清掉全部轮询器）；
- 上传证书：PEM 两个文本域 + 「选择文件…」（FileReader.readAsText 读成文本，与迁移前一致）+ 域名 + 名称 +
  证书链，提交体保留多别名写法（cert/certificate、key/privateKey 都带上）；
- 删除任务 / 证书走 confirmDialog（文案逐字保留），切换状态走 /jobs/{id}/toggle（失败退回 PUT）。

## 3. kit 用法要点（本批实际用到的）

1. 表格：`<nunt-table caption .columns .rows .loading .error .onRetry .rowKey empty emptyHint>`；
   操作列写 actions: true（右对齐、不换行、包在 .nunt-actions 里）；行内按钮用 render(row) 返回 Lit 模板；
   状态开关的文案必须放进 sl-switch 的可见标签里（沿用批次 B 的结论）；
2. 表单：formGrid([...]) 返回 { node, read, get, set, error, fieldError, toggle, clearErrors }；
   动态表单（提供商凭据）用 type:'custom' + 页面自己维护的 node，切换时只改这个 node 的内容，
   不往 nunt-form 的字段里后插 DOM（沿用批次 B 的结论）；按状态显隐用 form.toggle(name, visible)；
3. 表单里嵌套的「一组字段」也各自建一个 formGrid（IPv4 / IPv6 各一个），字段名统一加前缀
   （ipv4Mode / ipv4Iface / ipv6Url…），避免与主表单里同名的 enable / url / body 之类混淆 ——
   提交体不受影响，collect() 负责拼回原来的形状；
4. 对话框：openDialog({ title, body, actions, wide, onClose })；提交中 dlg.setBusy(true, button)；
   保存失败保留对话框写 close: false；对话框内的长内容自己用 nunt-loading / nunt-error / nunt-empty 兜底；
   本页打开的对话框都记在 Set 里，dispose 时统一 close（openDialog 会在 sl-after-hide 时把节点摘掉）；
5. 提示：toast(msg, 'ok'|'err'|'warn'|'info')、confirmDialog(msg, { danger, okLabel })；
6. 三态：直接写 `<nunt-empty>` / `<nunt-loading>` / `<nunt-error .error .onRetry heading compact>` 元素；
7. 卡片标题一律 h2，页面私有样式统一前缀并随 cleanup 移除；不要用 remove / appendChild 这类 DOM 同名成员名
   （ddns 的删除动作叫 removeRule、acme 的叫 removeJob / removeCert）。

## 4. axe 对比（critical / serious / moderate / minor）

> 口径：阶段 1 / 2A / 2B 的数字取自 docs/screenshots/phase1|phase2a|phase2b/a11y.json（同一套 axe-core 4.14.0 与规则标签）。

| 页面 | 阶段 1 | 阶段 2A | 阶段 2B | 阶段 2C（本批） |
| --- | --- | --- | --- | --- |
| #/ddns | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| #/acme | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 1 / 1 | 0 / 0 / 0 / 0 |
| 两页合计 | 0 / 0 / 2 / 2 | 0 / 0 / 2 / 2 | 0 / 0 / 2 / 2 | 0 / 0 / 0 / 0 |
| 12 页合计 | 14 / 0 / 7 / 7 | 8 / 0 / 6 / 6 | 8 / 0 / 4 / 4 | 8 / 0 / 2 / 2 |

- ddns / acme 迁移前的 moderate 是卡片的 h3（heading-order）、minor 是自绘表格操作列的空 th
  （empty-table-header）；nunt-table 的 actions 列 + h2 标题两条一起消失；
- 12 页合计 critical 仍是 8，全部在未迁移的 waf（label 2 + select-name 6）；moderate / minor 各剩 2 条，
  分别在 web（empty-table-header + heading-order）与 waf（同两条），与批次 B 的结论一致。

## 5. 体积对比（两个页面的原始 / gzip / br 字节）

| 文件 | 原始旧 | 原始新 | Δ原始 | gzip 旧 | gzip 新 | Δgzip | br 旧 | br 新 | Δbr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pages/ddns.js | 49657 | 39620 | −10037 | 15015 | 12057 | −2958 | 12885 | 10133 | −2752 |
| pages/acme.js | 47887 | 40494 | −7393 | 14533 | 11778 | −2755 | 12399 | 9892 | −2507 |
| 合计 | 97544 | 80114 | −17430 | 29548 | 23835 | −5713 | 25284 | 20025 | −5259 |

口径：旧 = `git show f736005:<path>` 的字节（本批开始前的工作区状态）；新 = 工作区文件字节；
两边都是 LF、与 //go:embed all:assets 打进二进制的内容一致；gzip 用 zlib level 9、br 用 brotli quality 11。
两页本来各自带着一整套 el/makeEl/modal/tableEl/字段构件/DNS 供应商兜底（各约 200 行）＋ 自己的 fetch 包装，
换成 kit 之后单页小了 15% 左右，而且不再各自维护一份 CSRF / 掩码逻辑。

## 6. 本次踩到并查清的坑（值得写进后续批次的检查表）

1. **axe 的 label-title-only 对视口外的控件误判（查清了，不是标记问题）**：ddns 的 IPv4/IPv6
   「获取方式」下拉在对话框里被判 serious（label-title-only），但探针显示它的 label 属性、阴影
   `<label id="label">获取方式</label>`（64x25、display:inline-block、非 hidden）、aria-labelledby 全都正常。
   把对话框内部滚动容器（sl-dialog 阴影里的 .dialog__body，clientHeight 726 / scrollHeight 1625）滚到底之后，
   这两条违规消失、同时**跑到被滚出视口的另外两个下拉（provider / recordType）上** ——
   证明 axe 的 title-only 检查把「滚出对话框可视区」的表单控件当成没有可见标签。
   它和页面标记无关：任何长表单对话框（例如批次 B 的 task / storage）都会有，
   浅色主题补测脚本因此对这类违规按视口位置过滤（视口外的只记录、不计入）。
2. **sl-dialog 带来的两条 landmark best-practice**：对话框一打开，axe 会报
   landmark-no-duplicate-banner + landmark-unique（指向 .topbar）—— 来源是 sl-dialog 阴影 DOM 里的
   `<header>`。它对所有页面都一样：浅色补测里没动的模板页 notify 打开新建对话框也是同样两条，
   所以算 kit 层现象（要修得动 kit.js 的 openDialog，超出本批范围），补测脚本把它当作已知豁免并与对照页比对。
3. **Playwright 的 page.evaluate 只接受一个参数**：`page.evaluate(fn, a, b)` 会抛
   "Too many arguments"，两个参数的页面函数必须包成对象传（冒烟脚本里的 setField / fieldHidden 都是这么写的）。
4. **别用 locator.inputValue() 读 Shoelace 控件**：sl-input / sl-textarea 是自定义元素不是原生 input，
   要 `locator.evaluate((n) => n.value)`。
5. **后端 custom（自定义回调）provider 的判定**：`successText(body, nil)` 在 okTokens 为空时对任何
   非空响应体都返回 false —— 也就是「200 + 空响应体」才算成功，回 'ok' 反而会被判失败。
   冒烟脚本用它来跑通「立即执行成功」的真实链路（本地起一个回调服务），失败链路用 500 + error。
6. **后端对未启用规则的手动 run 是静默 no-op**：`runRule` 开头 `if rule == nil || !rule.Enable { return }`，
   而 /run 仍然返回 ok:true，界面于是提示「执行成功」。迁移前后的前端行为一致（都只看 data.ok），
   冒烟脚本里必须把规则置为启用才能真正测到成功/失败两条路径。
7. **DDNS 状态区的失败计数**：后端 statusView 的字段名是 success / failures，迁移前的页面读的是
   fail / failCount，所以旧页面「失败」永远是 0。本批按「兼容多种形状」把 failures 接到回退链末尾
   （fail → failCount → failures）：老字段还在就先取老字段，只有后端这种形状时才会显示真实失败数。
8. **cloudflare 的凭据字段名是 apitoken / email / apikey**（不是 fallback 表里的 token）；
   challenge 存的是规范化后的短名 http / dns / tls-alpn（页面标签仍然按 http-01 那套显示，
   与迁移前一致，未知值直接原样显示）。

## 7. 验收命令与真实输出

环境前缀（每条 pwsh 都带，值与 PHASE1-NOTES 第 7 节一致）：GOMODCACHE / GOCACHE / GOPATH 指向仓库内 .gocache，
GOFLAGS=-mod=mod，GOTOOLCHAIN=auto，GOTMPDIR=TMP=TEMP=仓库内 .gocache/tmp，PATH 前置 Go 的 bin 目录。

    # 1) Go
    go build ./...                      # GO_BUILD_EXIT=0
    go vet ./...                        # GO_VET_EXIT=0
    go test ./... -count=1 -p 1         # TEST_EXIT=0
    #   ok github.com/nunt/nunt/internal/api 8.216s
    #   ok github.com/nunt/nunt/internal/app 2.345s
    #   ok github.com/nunt/nunt/internal/modules/acme 0.553s
    #   ok github.com/nunt/nunt/internal/modules/ddns 1.743s
    #   ok github.com/nunt/nunt/internal/modules/waf 34.367s
    #   ok github.com/nunt/nunt/internal/webui 0.440s   （其余包全部 ok / no test files）

    # 2) 前端采集（真实二进制 + 无头 Chromium）
    go build -o nunt.exe ./cmd/nunt
    node scripts/ui-baseline.mjs --out docs/screenshots/phase2c --label 'phase2 batch C'
    # [baseline] 服务就绪：http://127.0.0.1:16601（已从 stdout 抓到初始管理员密码）
    # [baseline] 演示数据：11/11 成功
    # [baseline] 采集页面 #/dashboard … #/settings（共 12 页）
    # [baseline] 已写出 REPORT.md / a11y.json / baseline.json 到 docs/screenshots/phase2c
    # [baseline] 汇总：console 0，失败请求 0，外部请求 0，axe 严重 8，重要 0
    # BASELINE_EXIT=0

    # 3) 补测（临时脚本在 .gocache/tmp，不属于仓库 scripts/）
    node .gocache/tmp/light-check-2c.mjs     # LIGHT-CHECK: PASS  bars=["50","11","0"]
    node .gocache/tmp/pages-smoke-2c.mjs     # PAGES-SMOKE: PASS（80 步 / 0 失败 / console 0）

    # 4) 体积
    node .gocache/tmp/sizes-2c.mjs           # 见第 5 节表格

    # 5) vendor
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly   # [ok] vendor 目录与 VERSION.md 记录一致；VENDOR_EXIT=0
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly      # [ok] lit vendor 目录与 VERSION.md 记录一致；LIT_EXIT=0

REPORT.md 第 1 节的原始数字：页面数 12、页面未挂载出内容 0、console 报错+警告 0、未捕获异常 0、
失败请求 0、HTTP 4xx/5xx 响应 0、外部请求 0、横向溢出的页面 0、axe 严重 8 / 重要 0 / 中等 2 / 轻微 2。
两页的逐页结果： #/ddns 0/0/0/0、#/acme 0/0/0/0（REPORT.md 第 4 节）。

## 8. 未完成项与需要决策的点

1. **密钥类型选项与后端不一致（迁移前就存在）**：页面下拉给的是 使用全局默认 / ecdsa / rsa2048 / rsa4096，
   而后端 normalizeKeyType 只认 ec256 / ec384 / rsa2048 / rsa4096 —— 选 ECDSA P-256 保存会被后端
   400（unknown key type）。本批按「接口与提交体不变」原样保留（含基线的演示任务用的是 ec256，
   在界面上会显示成未选中的空值，保存后退回全局默认，与迁移前的原生 select 行为一致）。
   需要决策：把选项改成 ec256 / ec384（要动页面文案与提交值）还是后端接受 ecdsa 别名。
2. **keyType / challenge 的显示口径**：证书任务的「挑战」列对后端返回的短名（http / dns / tls-alpn）
   直接原样显示（迁移前也是），只有 http-01 / dns-01 / tls-alpn-01 才有中文标签。要不要给短名也配标签？
3. **失败计数兼容**：见第 6 节第 7 条 —— 状态区现在会把 failures 显示出来（旧页面恒为 0）。
   如果要求「显示数字也必须逐字不变」，把 statusRow/failCount 的 'failures' 去掉即可（一行）。
4. **ddns 规则表里「上次更新 / 成功失败」两列**：按本批的列要求（名称/域名/提供商/记录类型/当前 IP/
   状态/操作）从规则表挪到了运行状态表与状态对话框；规则表通过域名列保留了子域名标签。
   需要决策：是否要在规则表再补回这两列。
5. **迁移期遗留层（style.css 第 6 节）还在**：两页仍复用 .card / .card-header / .card-body / .sub /
   .spacer / .muted / .mono 这些类；页面自己的样式全部用私有前缀随 mount 清理。
   等 11 个页面全部迁完再整节删除（属阶段 3）。
6. **补测脚本仍是临时的**：light-check-2c.mjs / pages-smoke-2c.mjs 放在 .gocache/tmp（gitignore），
   没有进 scripts/。建议阶段 2 收尾时把「浅色主题 axe + 逐页交互冒烟」固化进 scripts/
   （例如扩展 kit-smoke.mjs），但那需要动仓库脚本，超出本批「只改两个页面文件」的约束。
7. **第 6 节第 1、2 条是工具/kit 层现象**：页面级 axe（本批验收口径）两页全 0；
   对话框打开状态下的 label-title-only（视口外）与两条 landmark 需要动 kit.js 或 vendor 才能消掉，
   本批只做记录与过滤，留给阶段 3 统一处理。
