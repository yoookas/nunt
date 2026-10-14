# nunt 开发契约（所有并行开发者必须遵守）

> 本文档是模块之间的接口约定。**只修改你负责目录下的文件**，不要动其他人的文件。
> 如果确实需要改动公共代码（`internal/model`、`internal/rest` 等），先在说明里写清楚，不要擅自修改。

## 1. 环境与构建

Go 1.25（本机 go1.25.5）。模块缓存必须放在工作区内，**每条 pwsh 命令都要带这个前缀**：

```powershell
$env:GOMODCACHE='D:\Desktop\nunt\.gocache\mod';$env:GOCACHE='D:\Desktop\nunt\.gocache\build';$env:GOPATH='D:\Desktop\nunt\.gocache\gopath';$env:GOFLAGS='-mod=mod';$env:GOTOOLCHAIN='local';
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
