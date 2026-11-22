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
`golang.org/x/crypto`（argon2/acme）、`golang.org/x/net`（http2）、
`github.com/corazawaf/coraza/v3`、`github.com/corazawaf/coraza-coreruleset/v4`。
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
| A | `internal/modules/web` | 监听器管理、Host/Path 路由、反向代理（WebSocket、负载均衡、路径重写）、重定向、静态托管（含目录列表/SPA）、访问控制、BasicAuth、TLS（自动证书/指定证书/HSTS）、访问日志缓冲。调用 `waf.WAF.Middleware` |
| B | `internal/modules/forward` | TCP/UDP 端口转发（连接计数、访问控制、日志） |
| C | `internal/modules/ddns`、`internal/dnsprov/*` | DDNS 规则调度、公网 IP 探测（网卡/URL/静态）、自定义回调、各家 DNS 提供商 |
| D | `internal/modules/acme` | ACME 账号与订单（`golang.org/x/crypto/acme`）、http-01 / dns-01、证书入库、续期循环 |
| E | `internal/mounts/webdav.go` | 远程 WebDAV 挂载后端（供静态托管的存储使用） |
| F | `internal/modules/waf` | Coraza v3 引擎、CRS 内置规则、自定义规则、按规则开关、拦截统计与日志、管理接口 |
| G/H | `frontend/` 与 `internal/webui/assets` | Vue 3 + Arco Design 管理界面（构建产物提交） |

## 7. 前端契约（Vue 3 + Arco Design + Vite）

前端是一个独立的 Vite 工程，位于 `frontend/`，构建产物提交在 `internal/webui/assets/`
（Go 用 `go:embed all:assets` 打进二进制，所以 `go build` 和 Docker 镜像都不需要 Node；
镜像里的 `web` 阶段会重新构建一次，保证镜像不会带着过期的前端）。

### 7.1 技术栈与硬约束

- **Vue 3.5**（`<script setup>`，JavaScript）+ **Arco Design Vue 2.59** + **Vite 8**；
- 只有一个入口：`frontend/src/main.js` → `App.vue` → 路由；
- 构建输出固定为 `internal/webui/assets/{index.html,static/*}`。**改了源码必须重新构建并提交产物**，
  CI 会重跑构建并检查 `git diff --exit-code internal/webui/assets`；
- 运行时不允许外部请求：字体、图标、样式全部来自包内（CSP 保持 `script-src 'self'`，
  `style-src 'self' 'unsafe-inline'` 用于 Arco 的内联样式）；
- 主题：`<body arco-theme="dark|light">` 切换，持久化在 `localStorage['nunt.theme']`；
  页面只使用 Arco 组件和 `var(--color-*)` 变量，不写死颜色。

### 7.2 目录

```
frontend/
├── index.html
├── vite.config.js          # outDir: ../internal/webui/assets，assetsDir: static
└── src/
    ├── main.js             # createApp、Arco、router、主题初始化
    ├── api.js              # fetch 封装：JSON、CSRF、401 事件
    ├── session.js          # 登录状态、bootstrap、改密
    ├── theme.js            # 明暗主题
    ├── menu.js             # 侧栏导航（路由名 + Arco 图标名）
    ├── format.js           # 字节/时长/时间格式化
    ├── layout/AppLayout.vue
    └── views/*.vue         # 9 个页面 + Login + PasswordChange
```

### 7.3 页面契约

- 每个页面一个单文件组件，默认导出即可（路由用 `() => import('./views/xxx.vue')` 懒加载）；
- 页面结构统一：`.page` → `.page-header`（`h2` + `.sub` + `.spacer` + 操作按钮）→ `a-card`；
- 数据请求只用 `api.get/post/put/del`，错误用 `errorText(err)` 转成文案后 `Message.error`；
- 写操作由 `api.js` 自动带上 `X-CSRF-Token`；401 会触发 `nunt:unauthorized` 事件回到登录页；
- 表单必须有 label，表格列必须有标题，按钮必须有可读文字（可访问性基线）。

### 7.4 构建与本地开发

```bash
npm ci --prefix frontend          # 或 cd frontend && npm install
npm run build --prefix frontend   # 重写 internal/webui/assets
cd frontend && npm run dev        # 开发服务器，API 代理到 127.0.0.1:3113（按需在 vite.config.js 配置）
```

`make web` 等价于前两条命令。构建后用 `npm run smoke --prefix frontend` 跑 jsdom 冒烟：
它加载**真实构建产物**，用假 API 把 10 个路由逐个挂载，任何未捕获异常都会让命令非零退出。
