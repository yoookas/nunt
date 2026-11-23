# nunt

一个用 Go 编写的自托管边缘服务：**反向代理、重定向、静态托管、端口转发、动态域名（DDNS）、ACME 自动证书、Coraza WAF**，
带一个 React 19 + HeroUI 的 Web 管理界面（构建产物嵌进二进制），支持 Docker Compose 一键部署。

> 设计目标：单二进制、跨平台、默认安全、界面简洁；面向软路由 / NAS / 家庭服务器 / 小团队内网。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| **Web 服务** | 监听器 / 路由两层：监听器负责监听地址与 TLS（关闭 / 自动证书 / 指定证书），路由按「域名 + 路径」选择上游，同一端口可挂多个域名；支持 3 种路由类型：反向代理、重定向、静态托管，以及 IP/UA 黑白名单（IP 段可与 ip2region 国家/省份组合过滤）、HTTP Basic 认证、多上游负载均衡（轮询/随机/IP 哈希）、路径重写、自定义请求/响应头、WebSocket、访问日志 |
| **端口转发** | TCP / UDP / 同时转发，源地址 → 目标地址，支持 IPv6、源 IP 黑白名单（IP 段 + ip2region 国家/省份）、空闲超时、活跃与累计连接数、上下行流量统计、访问日志 |
| **动态域名 DDNS** | 内置阿里云 DNS、腾讯云 DNSPod 与「自定义回调」；支持多子域名、A/AAAA、TTL、间隔或 cron 调度、公网 IP 探测（网卡 / URL / 静态）、变化才更新 |
| **ACME 自动证书** | 基于 `golang.org/x/crypto/acme` 自研签发流程，支持 http-01 / dns-01 / tls-alpn-01，DNS-01 复用 DDNS 的提供商；**http-01 / tls-alpn-01 复用 web 的 :80 / :443 监听**（端口被自家规则占用也能签发），自动续期（默认剩余 30 天，上限 30 天），证书热加载、无需重启；统一使用 Let's Encrypt；证书页可配置账户邮箱与默认密钥类型；支持手动上传证书；证书可备注，并可导出为 zip（证书链 + 私钥）用于备份迁移 |
| **Coraza WAF** | 内嵌 OWASP CRS 规则集，支持检测/拦截模式、PL 等级、入站/出站阈值、规则文件勾选、自定义 SecLang 规则、请求体上限、拦截日志与在线测试；可保护管理后台本身 |

管理界面：概览、Web 服务、端口转发、动态域名、证书、存储、WAF、日志、设置。

---

## 快速开始

### 1. Docker Compose（推荐）

```bash
git clone <this-repo> nunt && cd nunt
docker compose up -d --build
```

- 使用 **host 网络**（`docker-compose.yml`）：端口转发、IPv6、80/443 都能正常工作，Linux 推荐。
- **只支持 host 网络**；Docker Desktop（macOS / Windows）不受支持——bridge 下端口转发、IPv6 与真实客户端 IP 都不可用。
- 首次启动会在日志里打印**随机生成的管理员密码**，登录后请立即修改：

```
============================================================
  A new configuration was created.
  Administrator user : admin
  Administrator pass : xxxxxxxxxxxxxxxx
  Sign in and change it immediately.
============================================================
```

管理地址：`http://<主机IP>:3113`

#### 在控制台里改监听地址（保存后立即生效）

「设置 → 系统参数 → 管理监听地址」可以直接修改端口 / 监听地址，**不需要重启进程**：

1. 后端先在**新地址**上绑定监听器（端口被占用、权限不足、地址非法时直接返回 4xx 并保留旧监听）；
2. 绑定成功后才把新地址写进 `config.json`，再由旧监听器返回这次保存的 200 响应；
3. 大约 300 ms 后旧监听器优雅关闭（等待进行中的请求写完），**会话（cookie）不受影响**——
   仍然是同一个进程、同一份内存会话表；
4. 保存成功的响应里 `adminListen` 是真正生效的地址，设置页会提示新地址并给出「用新地址打开」链接。

> 当前页面还挂在旧端口上，切换后请用新地址继续操作（页面顶部会保留这个链接）。

#### 用环境变量指定控制台端口

管理后台默认监听 `:3113`（配置字段 `system.adminListen`）。容器部署时可以直接用环境变量覆盖，**不需要改 `config.json`**，覆盖值也不会写回数据卷：

| 变量 | 含义 | 优先级 |
| --- | --- | --- |
| `NUNT_ADMIN_LISTEN` | 完整监听地址，如 `:8080`、`127.0.0.1:8080` | 最高 |
| `NUNT_ADMIN_PORT` | 仅端口，如 `8080`（内部等价于 `:8080`） | 次之 |
| `system.adminListen` | 配置文件里的值 | 最低 |

```bash
# docker run：只换端口（监听所有网卡）
docker run -d --name nunt --network host \
  -e NUNT_ADMIN_PORT=18080 \
  -v "$PWD/data:/data" nunt:dev

# docker run：只监听回环（推荐配合 SSH / WireGuard 隧道）
docker run -d --name nunt --network host \
  -e NUNT_ADMIN_LISTEN=127.0.0.1:18080 \
  -v "$PWD/data:/data" nunt:dev

# compose：NUNT_ADMIN_LISTEN 留空时用 config.json 里的值（新卷为 :3113），覆盖变量即可
NUNT_ADMIN_LISTEN=127.0.0.1:18080 docker compose up -d

# 或写进与 docker-compose.yml 同目录的 .env
echo 'NUNT_ADMIN_LISTEN=:18080' >> .env && docker compose up -d
```

- 环境变量**只影响运行时**：`GET /api/v1/system/info` 的 `adminListen` 是实际生效值，
  `adminListenConfig` 仍是配置文件里的值，`adminListenSource` 为 `env` 或 `config`。
- **环境变量优先于设置页**：来源是 `env` 时设置页会禁用「管理监听地址」字段并说明原因；
  直接调用 `PUT /api/v1/system/settings` 修改地址会被拒绝（`409` +
  「当前监听地址由环境变量 NUNT_ADMIN_LISTEN 控制，修改配置不会生效」），配置不会被改动。
  要改用设置页（含运行中切换），先移除环境变量并重启一次。环境变量存在时，其它设置照常保存。
- 非法值（如 `NUNT_ADMIN_LISTEN=abc`、`NUNT_ADMIN_PORT=70000`）会让进程**启动即失败**并打印原因，
  不会静默回退到旧端口。
- 容器健康检查按同一优先级取端口：`NUNT_ADMIN_PORT` → `NUNT_ADMIN_LISTEN` 的端口部分 →
  `/data/config.json` 里的 `system.adminListen` → 内置默认 `3113`。因此在控制台里改过端口后，
  healthcheck 会自动跟到新端口（读取配置文件里的值）。

### 2. 使用 Release 里的镜像文件（不上传任何镜像仓库）

每次打 tag（如 `v1.0.0`）都会触发 GitHub Actions 构建容器镜像，并把**镜像归档文件**直接附到 Release 上：

```bash
# 下载后加载（amd64 / arm64 / armv7 单架构归档，或 -oci 多架构归档）
docker load < nunt-v1.0.0-amd64.tar.gz
docker compose up -d          # docker-compose.yml 中把 image 指向 nunt:v1.0.0 并去掉 build
```

镜像**不会**被推送到 Docker Hub 或 GHCR，所有归档都只存在于 Release 附件里（含 `SHA256SUMS`）。

### 3. 直接运行二进制

```bash
go build -o nunt ./cmd/nunt
./nunt -d ./data            # 配置与数据都在 ./data
./nunt -cd /etc/nunt        # 或指定配置目录
./nunt -v                   # 版本信息
```

容器内运行时会自动使用 `/data`，并以非 root 用户（uid 1000）运行，镜像里已用 `setcap` 允许绑定 80/443。

### 4. 上公网之前

要把服务**直接暴露到公网**，先读 **[docs/PUBLIC-EXPOSURE.md](docs/PUBLIC-EXPOSURE.md)**：公网与内网的威胁模型差异、管理面隔离（`adminListen` 只监听回环 + WireGuard/SSH 隧道，或反代 + TLS + BasicAuth + IP 白名单 + WAF `adminProtect`）、最小暴露面清单、先观察后强制的上线顺序，以及 P0/P1/P2 勾选清单与「当前尚未验证」清单。

静态托管只提供只读文件服务；公网部署前请按 [PUBLIC-EXPOSURE](docs/PUBLIC-EXPOSURE.md) 的清单收紧监听面。

---

## 目录与配置

```
data/
├── config.json      # 全部配置（0600），原子写入，保留 .bak
├── secret.key       # 凭据加密密钥（0600，AES-256-GCM）
├── certs/           # 证书仓库（cert.pem / key.pem / meta.json）
├── acme/            # ACME 账号密钥与注册信息
└── logs/            # 运行日志（按大小轮转，保留 3 份）
```

- 所有敏感字段（DDNS/DNS 凭据、挂载密码、BasicAuth 密码）**加密存储**；
- API 返回时统一脱敏为 `********`，保存时该掩码表示「不修改」；
- 导出配置会自动脱敏，可直接用于备份或分享排障。

---

## 安全设计

- **认证**：Argon2id 密码哈希；会话为服务端存储的随机令牌（HttpOnly + SameSite=Strict + TLS 下 Secure），修改密码后旧会话立即失效。
- **CSRF**：会话鉴权的写操作必须带 `X-CSRF-Token`（登录时下发）。
- **暴力破解**：登录失败按「用户名 + IP」计数，超过阈值指数退避锁定；API 有令牌桶限流。
- **开放 API**：Bearer Token 或 `X-API-Token`，令牌只存 SHA-256 哈希，可限制 scope，可随时吊销。
- **文件安全**：静态托管的本地目录全部走基于 `os.Root` 的虚拟文件系统，符号链接与 `..` 逃逸在内核层面被拒绝。
- **反向代理**：剥离 hop-by-hop 头、可控超时、上游仅允许 http/https，响应头可裁剪。
- **WAF**：Coraza + CRS，可保护后台接口本身；拦截页面不回显用户输入；请求体检查由 Coraza 自己按 `bodyLimitKb` 截断（见下方「WAF」）。
- **TLS**：最低 TLS 1.2、仅 ECDHE 系列套件、按 SNI 热加载证书。
- **其它**：管理后台支持 IP 白名单；配置与密钥文件权限 0600；日志不记录任何凭据。

---

## WAF

内嵌 [Coraza](https://coraza.io/) v3 + OWASP CRS v4，规则集编译进二进制，不需要任何外部依赖：

- **检测 / 拦截**两种模式；`logOnly` 只记录不拦截；paranoia level、执行等级、入站 / 出站阈值可调；
- 规则文件可整份或按 ID 区间禁用，支持追加自定义 SecLang 规则（`extraRules`）；
- **请求体**交给 Coraza：`bodyLimitKb` 设置 `SecRequestBodyLimit`，超出上限的部分按 `ProcessPartial` 只检查前缀，
  其余字节流式透传给上游（不返回 411，chunked / 大上传都能正常过）；
- 可保护管理后台本身（`adminProtect`，拦截页不回显用户输入）；
- WAF 页提供拦截日志、规则命中统计与「请求测试」（把请求喂给引擎，不会真的发出去）。

> **已移除**：按路由声明请求体策略（`full` / `peek` / `skip` / `grpc-unary` / `grpc-stream`）与
> `observe` / `enforce` 双模式那套机制。它主要为 gRPC 帧级检查服务，实现复杂、维护成本高，
> 且 chunked 请求在 enforce 下会被 411 拒绝。现在所有请求体都走 Coraza 的默认检查路径。

---

## 开发

```bash
# 构建
go build -trimpath -tags "nomsgpack" -ldflags "-s -w" -o nunt ./cmd/nunt

# 单元测试
go test ./...

# 本地运行（工作目录里的 data/）
go run ./cmd/nunt -d ./data -log-level debug
```

目录结构：

```
frontend/           管理界面（React 19 + HeroUI + Tailwind 4 + Vite 8 + TypeScript，构建产物进 internal/webui/assets）
cmd/nunt            入口
internal/app        装配与生命周期
internal/api        管理后台 REST API + SSE
internal/config     配置仓库（原子写、校验、订阅）
internal/model      全部持久化类型
internal/module     模块接口与注册表
internal/modules/   各功能模块（web / forward / ddns / acme / waf）
internal/dnsprov    DNS 提供商（DDNS 与 ACME DNS-01 共用）
internal/certs      证书仓库（SNI 热加载）
internal/ip2region  IP 地理库（ip2region xdb：国家/省份）
internal/ipfilter    访问控制过滤器（CIDR + 国家/省份）
internal/vfs        安全文件系统抽象（os.Root）
internal/mounts     存储挂载（本地目录）
internal/security   密码、会话、限流
internal/rest       路由与 JSON 工具
internal/webui      管理界面构建产物（go:embed，源码在 frontend/）
web 前端            frontend/（React 19 + HeroUI + Tailwind 4 + Vite 8）
```

模块开发约定见 [docs/CONTRACT.md](docs/CONTRACT.md)（模块接口、REST 约定、前端页面契约）；
公网部署前的检查清单见 [docs/PUBLIC-EXPOSURE.md](docs/PUBLIC-EXPOSURE.md)。

### 前端

管理界面是独立的 **React 19 + HeroUI v3 + Tailwind CSS 4 + Vite 8 + TypeScript** 工程，界面按 HeroUI 原生设计语言重做（Menu 侧栏、Drawer 表单、Card/StatCard/DataTable 设计层），源码在 `frontend/`，
构建产物提交在 `internal/webui/assets/` 并通过 `go:embed` 打进二进制——所以 `go build` 和最终镜像都不需要 Node；
镜像的 `web` 阶段会重新构建一次，保证镜像不会带过期前端。

- 构建：`npm ci --prefix frontend && npm run build --prefix frontend`（或 `make web`），产物会整体重写
  `internal/webui/assets`；**改了前端必须重新构建并提交产物**，CI 会重跑构建并检查产物是否最新；
- 开发：`cd frontend && npm run dev`，页面热更新；9 个页面 + 登录/改密都在 `frontend/src/views/`；
- 约束：零外部请求（CSP `script-src 'self'`）、明暗主题用根元素 `.dark` class 切换、页面使用 HeroUI 组件、
  Tailwind 语义色（`bg-background`/`text-foreground`/`border-border` 等）。详细约定见
  [docs/CONTRACT.md 第 7 节](docs/CONTRACT.md)。

### 本地验证

```powershell
# 格式化检查 + vet + 全部单元测试 + 交叉编译（linux/amd64、linux/arm64、windows/amd64）
pwsh -File scripts/verify.ps1

# 起一个临时实例，登录并把每个模块接口、前端资源、创建规则后立即生效都跑一遍
pwsh -File scripts/smoke.ps1

# 真机验证「控制台里改监听地址，立即生效」：默认 3113 → 占用失败 → 切到 127.0.0.1:3199
# （同一个会话仍然有效）→ 改回 3113
pwsh -File scripts/listen-rebind.ps1

# 前端：安装依赖、构建、再构建二进制
npm ci --prefix frontend
npm run build --prefix frontend
npm run smoke --prefix frontend   # jsdom 冒烟：10 个路由逐个挂载，捕获运行时错误
go build -o nunt.exe ./cmd/nunt
```

（`npm run build` 会重写 `internal/webui/assets`；CI 的 `frontend` job 会重跑构建并检查产物是否已提交。）

---

## 发布流程

`.github/workflows/release.yml`：

1. 触发条件：推送 `v*` tag（或手动指定 tag）；
2. 用 buildx + QEMU 构建 `linux/amd64`、`linux/arm64`、`linux/arm/v7` 三种镜像，导出为 `docker save` 格式归档（`type=docker`），另外产出一个多架构 OCI 归档（`type=oci`）；
3. 压缩为 `.tar.gz`、生成 `SHA256SUMS`；
4. 创建/更新 Release 并上传全部附件。**不登录、不推送任何镜像仓库。**

`.github/workflows/ci.yml`：push / PR 时执行 `gofmt` 检查、`go vet`、`go test`、构建二进制与镜像（不推送），并跑**阻塞式**的 `govulncheck` 依赖漏洞扫描（依赖中存在可达的已知漏洞时 CI 直接失败）；另有独立的 `frontend` job 用 Node 构建 React 管理界面，并校验 `internal/webui/assets` 的提交产物与源码一致（过期即失败）。
`.github/workflows/docker-smoke.yml`：在真实 docker daemon 上构建镜像并校验容器契约（非 root 用户、低端口 capability、配置与密钥权限、管理 UI 可访问、用日志里的随机密码登录）。
`.github/dependabot.yml`：gomod 每周、GitHub Actions 每月检查依赖更新（限制同时开启的 PR 数，minor/patch 自动分组）。

---

## 与 Lucky 的关系

本项目在功能取舍上参考了 [Lucky](https://github.com/gdy666/lucky) 的使用体验（模块划分、路由模型），
但代码、配置格式、界面与实现均为独立编写，并做了两点明确取舍：

- **不提供** STUN 内网穿透、网络唤醒（WOL）、云盘挂载等模块（保持攻击面更小、依赖更少）；

---

## License

MIT
