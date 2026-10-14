# nunt 开发契约（所有并行开发者必须遵守）

> 本文档是模块之间的接口约定。**只修改你负责目录下的文件**，不要动其他人的文件。
> 如果确实需要改动公共代码（`internal/model`、`internal/rest` 等），先在说明里写清楚，不要擅自修改。

## 1. 环境与构建

Go 1.26（`go.mod` 声明 `go 1.26.0`，工具链由 `toolchain go1.26.9` 固定；
`GOTOOLCHAIN=auto` 会从 GOPROXY 自动拉取 go1.26.9）。模块缓存必须放在工作区内，**每条 pwsh 命令都要带这个前缀**：

```powershell
$env:GOMODCACHE='D:\Desktop\nunt\.gocache\mod';$env:GOCACHE='D:\Desktop\nunt\.gocache\build';$env:GOPATH='D:\Desktop\nunt\.gocache\gopath';$env:GOFLAGS='-mod=mod';$env:GOTOOLCHAIN='auto';
Set-Location D:\Desktop\nunt; go build ./...
```

校验自己负责的包：`go build ./internal/modules/xxx/... ` 和 `go vet ./internal/modules/xxx/...`。
并行开发期间其他包可能暂时编译不过，**只需要保证自己负责的包编译通过**；最后统一由主开发者执行 `go build ./...`。

已批准依赖（不要引入其它第三方依赖）：
`golang.org/x/crypto`（argon2/acme）、`golang.org/x/net`（webdav、http2）、
`github.com/corazawaf/coraza/v3`、`github.com/corazawaf/coraza-coreruleset/v4`、`github.com/robfig/cron/v3`。
需要新依赖时先在结果里说明，不要直接 `go get`。

## 2. 代码风格

- Go 代码注释、标识符用英文；前端面向用户的文案用中文。
- 错误必须带上下文（`fmt.Errorf("doing x: %w", err)`），不要 panic，不要在库代码里 `os.Exit`。
- 共享状态用 `sync.Mutex/RWMutex` 保护；模块的 `Start/Stop/Reload` 必须幂等、可重复调用。
- 所有 goroutine 必须能在 `Stop(ctx)` 后退出，不允许泄漏。
- 每个网络监听都要设置超时（`http.Server{ReadHeaderTimeout: ...}`、`net.Dialer{Timeout: ...}`）。
- 安全红线：路径穿越、命令注入、任意文件读写、把用户输入直接拼进 shell/SQL 都是禁止的；
  访问用户提供的文件路径一律走 `internal/vfs`（基于 `os.Root`）。

## 3. 可直接使用的基础设施

| 包 | 用途 | 关键 API |
| --- | --- | --- |
| `internal/rest` | 路由与 JSON | `rest.Mux`（`Get/Post/Put/Delete`、`Group`）、`rest.OK/Fail/FailCode/Decode` |
| `internal/module` | 生命周期 | `Module` 接口、`Base`（`Init/SetRunning/SetDetail/SetError/SetStats/Status`）、`Deps`、`Reloader`、`APIProvider`、`CertProvider` |
| `internal/config` | 配置读写 | `Store.Snapshot() *model.Config`、`Store.Update(func(*model.Config) error) error`、`Store.Subscribe(func(*model.Config))` |
| `internal/model` | 持久化类型 | 所有规则结构体，JSON tag 为 camelCase |
| `internal/netutil` | 网络匹配 | `ParseIPList`、`IPAllowed`、`UAAllowed`、`ClientIP`、`HostOnly`、`MatchDomain`、`NormalizeListen`、`TargetAllowed` |
| `internal/secret` | 凭据加密 | `Box.Seal/Open/SealMap/OpenMap`、`Mask`（脱敏展示） |
| `internal/httpc` | 出站 HTTP | `httpc.New(timeout, insecure)`、`httpc.Do`、`httpc.GetJSON`、`httpc.PublicIP` |
| `internal/vfs` | 安全文件系统 | `FS` 接口、`OpenLocal(dir,label,readOnly)`、`Clean`、`Entry` |
| `internal/mounts` | 存储挂载 | `Manager.Get(id) (vfs.FS, model.Mount, error)`、`Manager.Local(root,label,ro)`、`Find/List/Test` |
| `internal/certs` | 证书仓库 | `Store.GetCertificate`、`Add`、`List`、`Delete`、`Has`、`TLSConfig()` |
| `internal/notify` | 通知 | `Service.Emit(event, title, message, fields)`，事件名见包内常量 |
| `internal/security` | 安全原语 | `HashPassword/VerifyPassword`、`RandomToken`、`Limiter`、`RateLimiter` |
| `internal/dnsprov` | DNS 提供商 | `Registry.New(id, creds)`、`Provider.Set/Delete`、`Default()` |
| `internal/httpc.PublicIP` | 获取公网 IP | `PublicIP(ctx, "4"|"6", extraURLs)` |

模块构造签名统一为 `func New(deps *module.Deps) *X`，`X` 内嵌 `module.Base`，
通过 `m.Init(deps, "<name>", "<Title>")` 初始化，并实现：

```go
Start(ctx context.Context) error   // 幂等
Stop(ctx context.Context) error    // 幂等
Status() module.Status             // 由 Base 提供，可覆盖补充 Stats
Reload(cfg *model.Config)          // 必须幂等、快速，不允许阻塞或再次写配置
RegisterAPI(mux *rest.Mux)         // 注册 /api/v1/<name>/... 路由
```

## 4. REST 约定

- 路径前缀 `/api/v1/<module>/`；列表接口返回数组或 `{"items":[...]}`。
- 写接口：`POST /xxx` 新建、`PUT /xxx/{id}` 更新、`DELETE /xxx/{id}` 删除、`POST /xxx/{id}/toggle` 开关。
- 请求体字段与 `internal/model` 的 JSON tag 一致；用 `rest.Decode` 解析。
- 鉴权、CSRF、限流、CORS 已由 `internal/api` 统一处理，模块里不要重复实现。
- 更新配置统一走 `deps.Cfg.Update(func(c *model.Config) error { ... })`；改动后自己再调用一次
  `m.Reload(deps.Cfg.Snapshot())` 保证立即生效（`Update` 也会通过 `Subscribe` 触发一次，重复调用必须无害）。
- 返回凭据时必须脱敏（`secret.Mask`）；保存时若字段值等于掩码（含 `********`）则沿用旧值，不要覆盖成掩码。
- 统计信息用 `Status().Stats`（`map[string]any`）暴露给概览页。

## 5. 参考实现（只读，禁止整段复制）

Lucky v1.10.8 源码（Go module 缓存里已下载好）：

    D:\Desktop\nunt\.gocache\mod\github.com\gdy666\lucky@v1.10.8

- `module/ddns/providers/*.go`：各家 DNS API 的调用方式（cloudflare、alidns、dnspod、godaddy、porkbun、huawei、callback 等）
- `module/reverseproxy`、`module/portforward`、`module/sslcertficate`：反代、端口转发、证书申请的实现思路
- `thirdlib/gdylib/*`：工具函数思路

参考它的**行为**即可，代码要按本项目风格重写，界面文案与 API 一律用本项目自己的设计。

## 6. 任务与负责人（一个目录只有一个负责人）

| 负责人 | 目录 | 内容 |
| --- | --- | --- |
| A | `internal/modules/web` | 监听器管理、Host/Path 路由、反向代理（WebSocket、负载均衡、路径重写）、重定向、静态托管（含目录列表/SPA）、访问控制、BasicAuth、TLS（自动证书/指定证书/HSTS）、访问日志缓冲。调用 `filebrowser.Service.Site`、`webdav.Service.Site`、`waf.WAF.Middleware` |
| B | `internal/modules/forward`、`internal/modules/task` | TCP/UDP 端口转发（连接计数、访问控制、日志）、cron 计划任务（模块开关、规则开关、HTTP 请求、webhook、shell 需配置显式开启） |
| C | `internal/modules/ddns`、`internal/dnsprov/*` | DDNS 规则调度、公网 IP 探测（网卡/URL/静态）、自定义回调、各家 DNS 提供商 |
| D | `internal/modules/acme` | ACME 账号与订单（`golang.org/x/crypto/acme`）、http-01 / dns-01、证书入库、续期循环 |
| E | `internal/modules/filebrowser`、`internal/modules/webdav`、`internal/mounts/webdav.go` | 文件管理站点（列表/上传/下载/删除/重命名/新建目录/分享链接）、WebDAV 服务端（基于 `golang.org/x/net/webdav` + vfs 适配器）、远程 WebDAV 挂载后端 |
| F | `internal/modules/waf` | Coraza v3 引擎、CRS 内置规则、自定义规则、按规则开关、拦截统计与日志、管理接口 |
| G/H | `internal/webui/assets` | 纯静态前端（无构建步骤） |

## 7. 前端契约（纯静态，无打包）

- 目录 `internal/webui/assets/`：`index.html`、`style.css`、`app.js`、`pages/<id>.js`、`lib/*.js`。
- 通过 `//go:embed all:assets` 打进二进制，浏览器直接加载 ES Module，**不引入任何 CDN/外部依赖，不使用内联脚本**（后台 CSP 不允许内联）。
- `app.js` 负责：hash 路由、登录页、整体布局（侧边栏/顶栏）、SSE 日志、API 客户端、主题切换、页面懒加载。
- 每个页面模块默认导出：

```js
export default {
  id: 'web',
  title: 'Web 服务',
  icon: '<svg viewBox="0 0 24 24" ...>...</svg>', // 24x24 stroke 图标
  async mount(root, ctx) {
    // root: 页面容器 HTMLElement；ctx: 见下
    // 返回可选的清理函数
  },
}
```

- `ctx` 提供：`ctx.api`（`get/post/put/del`，自动附带 `X-CSRF-Token`，失败抛出带中文 message 的错误）、
  `ctx.toast(msg, type)`、`ctx.confirm(msg)`、`ctx.state`（当前会话信息）、`ctx.navigate(id)`、
  `ctx.fmtBytes/ctx.fmtTime/ctx.escapeHtml`、`ctx.onSSE(handler)`。
- 需要的页面 id / 文件名：
  `dashboard`、`web`、`forward`、`ddns`、`acme`、`storage`、`files`、`waf`、`task`、`notify`、`logs`、`settings`（→ `pages/<id>.js`）。
- 前端调用的模块接口（必须按此实现，避免联调失败）：

```
GET    /api/v1/web/rules                 GET/POST/PUT/DELETE /api/v1/web/rules[/{id}]
POST   /api/v1/web/rules/{id}/toggle     GET  /api/v1/web/logs?rule=<id>&limit=
GET    /api/v1/forward/rules             POST/PUT/DELETE /api/v1/forward/rules[/{id}]
POST   /api/v1/forward/rules/{id}/toggle GET  /api/v1/forward/logs?rule=<id>
GET    /api/v1/ddns/rules                POST/PUT/DELETE /api/v1/ddns/rules[/{id}]
POST   /api/v1/ddns/rules/{id}/run       GET  /api/v1/ddns/providers
GET    /api/v1/ddns/status
GET    /api/v1/acme/jobs                 POST/PUT/DELETE /api/v1/acme/jobs[/{id}]
POST   /api/v1/acme/jobs/{id}/issue      GET  /api/v1/acme/certificates
DELETE /api/v1/acme/certificates/{id}    POST /api/v1/acme/certificates/upload
GET/PUT /api/v1/waf/config               GET  /api/v1/waf/rules
GET    /api/v1/waf/logs?limit=           POST /api/v1/waf/test
GET    /api/v1/task/items                POST/PUT/DELETE /api/v1/task/items[/{id}]
POST   /api/v1/task/items/{id}/run
GET    /api/v1/storage/mounts            POST/PUT/DELETE /api/v1/storage/mounts[/{id}]
POST   /api/v1/storage/mounts/test       GET  /api/v1/storage/mounts/{id}/list?path=
GET/PUT /api/v1/notify/webhooks          POST /api/v1/notify/webhooks/test
GET    /api/v1/system/info|stats|logs|interfaces|settings|config
PUT    /api/v1/system/settings|config    POST /api/v1/system/reload
GET    /api/v1/auth/session|users|tokens POST /api/v1/auth/login|logout|password|users|tokens
DELETE /api/v1/auth/users/{id}|tokens/{id}
GET    /api/v1/modules                   POST /api/v1/modules/{name}/start|stop|restart
GET    /api/v1/events                    (SSE，消息格式 {"type":"log|status|event","data":...})
```

---

## 8. 请求体检查策略（A + C + E）

> 规格来源：[请求体检查策略实施清单](PLAN-waf-body-policy.md)。本节是**接口契约**：
> 字段名、枚举值、中止语义、切换流程以本节为准，前端与后端都按这里的名字实现。

> ### ⚠️ 能力边界（先读这一段）
>
> **gRPC 流式路由只做首消息检查 + 帧校验。** 声明 `grpc-stream`（或默认按流式判定的）路由，
> 只会检查**第一条** gRPC 消息，之后的消息只做帧层校验（compressed flag、长度上限 4MiB、截断），
> **不做逐消息的 CRS 检查，也不做跨消息累计评分**。这是刻意收窄的范围（见 PLAN §1「不做」），
> 接口已为将来的 per-message 检查（D）预留 `BodyInspector`。
> 任何界面文案、文档、告警都不允许暗示「流式路由的每一条消息都被检查过」；
> 这同一句话必须出现在 [README](../README.md)「WAF 与请求体检查策略 → 能力边界」与 [DEPLOY](DEPLOY.md) 的 WAF 部署说明里，措辞保持一致。

> **本次顺带修复的生产缺陷（实现事实，不是待办）**：
>
> 1. **规则级 WAF 之前从未启动**：web 模块自己持有的那个 WAF 实例（注册表里的实例只服务管理 API）此前没有任何地方调用 `Start`，
>    因此生产环境里规则级 WAF 静默失效。现在由 `internal/modules/web/web.go` 的 `Start` / `Stop` 负责它的生命周期。
> 2. **CRS 对 `application/grpc` 与缺失 Content-Length 的误判**：`tx.allowed_request_content_type` 已加入
>    `application/grpc` / `application/grpc-web`，并且交给引擎的 body 按实际读到的消息长度设置 `Content-Length`。

### 8.1 配置面（4 项策略 + 1 项告警 + 每规则 1 项）

全局 `model.WAFConfig`（JSON tag 为 camelCase）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enforcementMode` | string | `observe` | `observe` \| `enforce`。**只改变响应，不改变判定逻辑** |
| `defaultBodyPolicy` | string | `full` | `full` \| `peek` \| `skip` \| `grpc`。未声明 bodyPolicy 的路由用它 |
| `peekBytes` | int | `65536` | peek 策略检查的字节数上限 |
| `peekTimeoutMs` | int | `250` | peek 的空闲超时（毫秒）；超时后不再等待 |
| `notifyBodyRatio` | float64 | `0`（关闭） | 非 full 占比**超过**该值时经 notify 发一条告警；`0` = 永不发，合法区间 `[0,1]`，同一进程每小时最多一次，样本少于 50 条不发 |

`MaxMessageBytes`（单条 gRPC 消息上限，默认 **4MiB**）是代码里的常量（`grpc.go` 的 `maxGRPCMessageBytes`），不是配置项；
超过它的帧按帧层违规处理（`grpc-status 8`）。

每规则 `model.WebRule`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `bodyPolicy` | string | `""`（继承全局） | `""` \| `full` \| `peek` \| `skip` \| `grpc-unary` \| `grpc-stream` |

约束：

- 配置校验**拒绝未知枚举**（拼错就是保存失败，不是静默回退），也**拒绝越界的 `notifyBodyRatio`**（<0 或 >1 保存失败）；
- `Normalize` 负责补齐默认值，**版本号不变**（靠 Normalize 回填，不需要迁移）；
- `notifyBodyRatio` 是**唯一一项 Normalize 不填默认值的策略配置**：默认 `0` = 关闭告警（见 8.6）；
- 前端提交 `PUT /api/v1/waf/config` 时**必须回传原配置对象**再覆盖这几项，
  否则会被 `rest.Decode` 重置成零值（现有前端已经是这个模式：
  `Object.assign({}, state.config, {...})`）。

### 8.2 策略矩阵（每次请求执行一次，按顺序判定）

| 判定顺序 | 条件 | 策略 | 行为 | bodyState |
| --- | --- | --- | --- | --- |
| 1 | 规则/全局声明 `skip` | skip | 只查 URI / 请求头，请求体原样透传 | `skipped` |
| 2 | 规则/全局声明 `peek` | peek | 读满 `peekBytes` 或空闲 `peekTimeoutMs`，检查已到达的部分，其余流式透传 | `peeked` |
| 3 | Content-Type 为 `application/grpc*` | grpc-unary / grpc-stream | 见 8.3；默认按 grpc-unary 处理，检测到第二帧时按声明决定拒绝或降级 | `grpc-unary` / `grpc-stream` / `grpc-server-first` / `frame-error` |
| 4 | Content-Length 已知且 ≤ `bodyLimitKb` | full | 全量检查后转发（今天的行为） | `full` |
| 5 | Content-Length 未知且策略为 `full` | 拒绝 | enforce：拒绝；observe：放行 + 记 wouldReject | 记入 wouldReject |

**这张表的安全含义**：攻击者只能通过「改变请求形态」落到第 5 行，而第 5 行在 enforce 下是拒绝，
因此**不存在「用 chunked 自动降级为部分检查」的路径**。

第 5 行的错误文案与状态码：

| 场景 | enforce 下的响应 | observe 下的行为 |
| --- | --- | --- |
| 非 gRPC + full + Content-Length 未知 | **411 Length Required** + 可操作文案 | 放行，落一条 wouldReject |
| gRPC + 首消息违规（未联系上游） | HTTP 200 + `grpc-status 7`（PERMISSION_DENIED）+ `grpc-message` | 放行，落一条 wouldReject |
| 声明 grpc-unary 却出现第二帧 | `grpc-status 7` / `13`（+ 说明） | 放行，落一条 wouldReject |
| 帧层违规（畸形 / 超长 / 截断） | `grpc-status 8`（RESOURCE_EXHAUSTED），经 proxy 的 `ErrorHandler` 写出 | 同上（帧错误始终拒绝，与模式无关） |

### 8.3 gRPC 路径的三段中止语义

组件 `grpcFrameScanner`（`io.ReadCloser` 包装，pull 驱动，只缓冲一条消息）：

1. **首消息阶段**：在调用下游之前读第一条消息（5 字节头 + 声明长度），受 `peekTimeoutMs` 约束。
   - 读到 **EOF** → 判定 unary / server-streaming，**整套请求体已完整**，做请求级判定；
     违规则直接返回（上游**零请求**）。
   - **未 EOF** → 判定为流式，首消息仍然先判定（挡掉绝大多数「第一发就是攻击」），
     通过后把首消息与 scanner 一起交给下游，bodyState=`grpc-stream`。
   - **超时**（服务端先说话的流）→ 立即放行，bodyState=`grpc-server-first`，计数并在指标里可见。
2. **后续帧阶段**（仅流式）：只做帧校验，**不检查内容**。
3. **帧校验（始终生效，独立于 CRS）**：compressed flag 只能是 0/1；
   单条消息长度 ≤ `MaxMessageBytes`（默认 4MiB）；截断流报错；
   声明 `grpc-unary` 的路由出现第二帧按模式拒绝 / 记录。

中止语义分三条路径，客户端看到的东西不同：

| 时机 | 中间件行为 | 客户端看到 |
| --- | --- | --- |
| 首消息违规、尚未联系上游 | 中间件直接写响应 | gRPC：HTTP 200 + `grpc-status 7` + `grpc-message`；非 gRPC：**403** |
| 帧层违规（畸形 / 超长 / 截断） | 哨兵错误经 body reader 返回，proxy 的 `ErrorHandler` 识别后写响应 | `grpc-status 8` |
| 声明 unary 却出现第二帧 | 同首消息路径 | `grpc-status 7` / `13` + 说明 |

工程约束（评审时逐条核对）：**任何策略分支都不允许存在「等待客户端把 body 发完」的路径**
（PLAN §8.2，T4 / T5 覆盖）。

### 8.4 观察模式与 observe → enforce 切换流程

1. 默认 `enforcementMode=observe`：所有「本应拒绝」的请求**照常放行**，但落一条 wouldReject
   记录（规则、路径、原因、客户端、本应返回的状态码），环形缓冲 **500 条** + 计数。
2. WAF 页「请求体检查策略」面板展示：未声明 bodyPolicy 的路由列表、wouldReject 样例表、
   bodyState 分布与非 full 占比卡片。
3. 运维补齐路由声明后，在 UI 上一键切到 `enforce`（前端会先弹确认框）；建议同时打开 notify 告警
   （非 full 占比 / wouldReject 计数阈值）。
4. **代码路径完全一致，enforce 只改变响应，不改变判定逻辑**——两者的差异必须有测试覆盖
   （T2、T6 就是这对差异）。

上线顺序：`observe` → 看 wouldReject 样例 → 补齐路由声明 → `enforce` → 观察 30–60 分钟。
**在 enforce 之前不要开 body 策略**，否则 chunked / 流式请求会直接被 411 或拒绝。

### 8.5 前端读接口的字段约定

WAF 页读 `GET /api/v1/waf/config`（现有形状 `{"config":..., "engine":..., "stats":...}`）：

| 数据 | 约定位置 | 兼容读取（前端会兜底，但后端应实现第一种） |
| --- | --- | --- |
| 四项策略 | `config.enforcementMode` / `defaultBodyPolicy` / `peekBytes` / `peekTimeoutMs` | `stats` / `policy` 层，或 `EnforcementMode` 等写法 |
| 告警阈值 | `config.notifyBodyRatio`（数字，`0` = 关闭） | 缺失时按 0 处理（不告警） |
| bodyState 分布 | `stats.bodyStates` = `{"full":0,"peeked":0,"skipped":0,"grpc-unary":0,"grpc-stream":0,"grpc-server-first":0,"frame-error":0}` | 单数 `bodyState`、数组 `[{state,count}]` |
| wouldReject 计数 | `stats.wouldReject`（数字） | 对象 `{count}`、或只有样例数组时用其长度 |
| wouldReject 样例 | 响应根 `wouldReject` = `[]Violation`（最新在前） | `stats.wouldReject.items`、`wouldRejectSamples` 等 |
| 未声明策略的路由 | 可选：`config.undeclaredBodyPolicyRoutes` | 前端会退回 `GET /api/v1/web/rules` + 空 `bodyPolicy` 推导 |

wouldReject 每条样例前端按这些字段名显示（都做兜底）：规则 `rule|ruleName|ruleId|site`、
域名 `host` + 路径 `uri|path|url` + `method`、原因 `reason|msg|message|detail`、
策略 `policy|bodyPolicy`、本应返回 `status|statusCode`（gRPC 场景按 PLAN §4 显示成
`HTTP 200 + grpc-status 7/13`）、客户端 `clientIp|ip|remoteAddr`、时间 `time|ts|at|timestamp`。

Web 规则接口：`GET /api/v1/web/rules` 的每一项必须带 `bodyPolicy` 字段（空串表示继承），
`PUT/POST /api/v1/web/rules[/{id}]` 必须接收并保存它（现有实现整体解码 `model.WebRule`，加字段即可）。

### 8.6 非 full 占比告警（notify）

`config.notifyBodyRatio` 是**策略缺口告警**的阈值，默认 `0`（关闭），合法区间 `[0,1]`，越界由配置校验拒绝。
触发条件（两个都要满足，判定在每次请求结束时做一次）：

| 条件 | 值 |
| --- | --- |
| 非 full 占比 `bodyNonFullRatio` | **严格大于** `notifyBodyRatio`（等于不发） |
| 样本数 `bodyRequests` | ≥ **50**（低于它是噪声，不是上线信号） |
| 发送频率 | **同一进程每小时最多一次**（带上一次发送时间，抑制不滑动窗口） |

告警经 `notify.Service.Emit(notify.EventAlert, ...)` 下发，字段固定为 `bodyRequests` / `bodyNonFull` /
`bodyNonFullRatio` / `notifyBodyRatio` / `minSamples` / `alertIntervalSecs`；正文含当前占比、阈值、样本数，
并明确提示「去 WAF 页查看未声明策略的路由」。`notifyBodyRatio=0` 时**永不发送**。

实现位置：`internal/modules/waf/alert.go`（阈值与样本门限、发送节流），时钟与投递函数可注入，因此单测不需要 sleep。
