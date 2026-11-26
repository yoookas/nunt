# nunt

一个用 Go 编写的自托管边缘服务：**反向代理、重定向、静态托管、端口转发、动态域名（DDNS）、ACME 自动证书、Coraza WAF**，
带一个 React 19 + Ant Design 的 Web 管理界面（构建产物嵌进二进制），支持 Docker Compose 一键部署。

> 设计目标：单二进制、跨平台、默认安全、界面简洁；面向软路由 / NAS / 家庭服务器 / 小团队内网。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| **Web 服务** | 监听器 / 路由两层：监听器负责监听地址与 TLS（关闭 / 自动证书 / 指定证书，可选客户端证书校验 mTLS），路由按「域名 + 路径」选择上游，同一端口可挂多个域名；支持 3 种路由类型：反向代理、重定向、静态托管，以及 IP/UA 黑白名单（监听器可设默认规则，路由继承或自定义；IP 段可与 ip2region 国家/省份/城市组合过滤）、HTTP Basic 认证、多上游负载均衡（轮询/随机/IP 哈希，连续失败的节点自动摘除 30 秒、恢复后自动回归，幂等请求失败自动换一个节点重试一次）、路径重写、自定义请求/响应头、CORS（含预检短路）、WebSocket、访问日志 |
| **端口转发** | TCP / UDP / 同时转发，源地址 → 目标地址，支持 IPv6、源 IP 黑白名单（IP 段 + ip2region 国家/省份/城市）、空闲超时、活跃与累计连接数、上下行流量统计、访问日志 |
| **动态域名 DDNS** | 内置阿里云 DNS、腾讯云 DNS（DNSPod）、Cloudflare（API Token）、Spaceship 与「自定义回调」；支持多子域名、A/AAAA、TTL、间隔或 cron 调度、公网 IP 探测（网卡 / URL / 静态）、变化才更新 |
| **ACME 自动证书** | 基于 `golang.org/x/crypto/acme` 自研签发流程，支持 http-01 / dns-01 / tls-alpn-01，DNS-01 复用 DDNS 的提供商；**http-01 / tls-alpn-01 复用 web 的 :80 / :443 监听**（端口被自家规则占用也能签发），自动续期（默认剩余 30 天，上限 30 天），证书热加载、无需重启；统一使用 Let's Encrypt（可在证书页切到 staging 环境调试挑战，签发的测试证书不被浏览器信任）；证书页可配置账户邮箱与默认密钥类型；支持手动上传证书；证书可备注，并可导出为 zip（证书链 + 私钥）用于备份迁移 |
| **Coraza WAF** | 内嵌 OWASP CRS 规则集，支持检测/拦截模式、PL 等级、入站/出站阈值、规则文件勾选、自定义 SecLang 规则、请求体上限、拦截日志与在线测试；可保护管理后台本身 |
| **日志** | 运行日志（SSE 实时推送 + 按大小轮转的文件，份数与单文件上限可配）、访问日志（Web / 端口转发 / WAF 三路统一写入 SQLite：保留 N 天、进程重启不丢；可按来源 / 状态码 / IP 前缀 / 关键字 / 时间范围检索，带聚合统计与 CSV 导出） |

管理界面：概览、Web 服务、端口转发、动态域名、证书、WAF、日志、设置。

---

## 快速开始

### 1. Docker Compose（推荐）

```bash
git clone <this-repo> nunt && cd nunt
cp .env.example .env          # 可选：PUID/PGID、时区、镜像名、管理端口
docker compose up -d --build
```

- 使用 **host 网络**（`docker-compose.yml`）：端口转发、IPv6、80/443 都能正常工作，Linux 推荐。
- **只支持 host 网络**；Docker Desktop（macOS / Windows）不受支持——bridge 下端口转发、IPv6 与真实客户端 IP 都不可用。
- 首次启动会在日志里打印**随机生成的管理员密码**，登录后请立即修改：

```
============================================================
  已生成新的配置文件
  管理员密码 : xxxxxxxxxxxxxxxx
  请立即登录并修改密码
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
- 容器健康检查执行的是 `nunt healthcheck`（服务自己的子命令，不依赖 shell / sed / wget），按同一优先级
  解析地址：`NUNT_ADMIN_LISTEN` → `NUNT_ADMIN_PORT` → `/data/config.json` 里的 `system.adminListen` →
  内置默认 `3113`，再请求 `/healthz`。所以在控制台里改过端口后，healthcheck 会自动跟到新端口。
  手动排查：`docker exec nunt nunt healthcheck`（退出码 0 健康 / 1 不健康 / 2 参数错误）。

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
├── logs/            # 运行日志（按大小轮转，保留 3 份）
│   └── access/      # 访问日志数据库（access.db，SQLite，保留 7 天）
└── backups/         # 定时备份归档（tar.gz，0600，默认保留 7 份）
```

- 所有敏感字段（DDNS/DNS 凭据、BasicAuth 密码）**加密存储**；
- API 返回时统一脱敏为 `********`，保存时该掩码表示「不修改」；
- 导出配置会自动脱敏，可直接用于备份或分享排障；
- 「设置 → 备份」可以按小时/天自动打包 `config.json`、`secret.key`、`certs/` 与 `acme/`
  （日志与旧备份不在其中），并保留最近 N 份；归档含密钥，离开本机前请自行加密。

---

## 安全设计

- **认证**：Argon2id 密码哈希；会话为服务端存储的随机令牌（HttpOnly + SameSite=Strict + TLS 下 Secure），修改密码后其它旧会话立即失效。
  首次登录必须改密：改密前服务端只放行会话查询、改密与退出登录三个接口，控制台不会打开。
- **CSRF**：会话鉴权的写操作必须带 `X-CSRF-Token`（登录时下发）。
- **暴力破解**：登录失败按来源 IP 计数，超过阈值指数退避锁定；API 有令牌桶限流。
- **文件安全**：静态托管的本地目录全部走基于 `os.Root` 的虚拟文件系统，符号链接与 `..` 逃逸在内核层面被拒绝。
- **反向代理**：剥离 hop-by-hop 头、可控超时、上游仅允许 http/https，响应头可裁剪。
- **WAF**：Coraza + CRS，可保护后台接口本身；拦截页面不回显用户输入；请求体检查由 Coraza 自己按 `bodyLimitKb` 截断（见下方「WAF」）。
- **TLS**：最低 TLS 1.2、仅 ECDHE 系列套件、按 SNI 热加载证书。
- **双因子**：可选 TOTP（RFC 6238），密码 + 6 位验证码两段登录；10 枚一次性恢复码；种子用部署密钥加密存储、导出时脱敏；绑定二维码在浏览器本地绘制，不请求任何外部服务。
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

## 日志

管理界面的「日志」页分两个标签：

**运行日志**：进程日志同时写 stdout 与 `<数据目录>/logs/nunt.log`，超过单文件上限后轮转为
`nunt.log.1…n`（默认 8 MB × 3 份，可在「设置 → 日志」里改）。页面通过 SSE 实时接收，
连接建立后先回放最近 100 条；**最新的日志在最上方**，列表停在顶部时自动跟随（新行插入顶部、
视图不跳），向下滚动即暂停跟随，滚回顶部恢复；支持按级别与关键字过滤、暂停与清屏。
日志文件可以直接在设置页下载。

**访问日志**：Web 请求、端口转发连接与 WAF 拦截统一写入 `<数据目录>/logs/access/access.db`（SQLite）：

- 默认保留 **7 天**、数据库上限 **64 MB**，启动时与每小时清理一次过期记录；保留天数、数据库上限、
  是否落盘都可以在「设置 → 日志」里改，保存即生效；
- 写入走有界队列 + 单个写协程，按批事务提交，**磁盘慢或写满都不会阻塞请求**；队列满时丢弃并计数，
  丢弃数在「日志 → 访问日志 → 存储状态」里可见；
- 每条记录包含时间、来源（web / forward / waf）、**请求 ID**、站点或转发规则、监听地址、域名、方法、
  路径、状态码、**上游状态与重试次数**、结果、**拒绝原因 / 错误**、客户端 IP 与
  **国家/省份/城市**（地址库加载时）、上游或目标、耗时、**请求/响应字节拆分**、HTTP 协议与 TLS 版本、
  User-Agent 与 WAF 命中信息；
- **WAF 判定合并进同一次请求的 web 记录**（`wafAction` / `wafRuleId` / `message`），不再重复计数；
  只有管理后台自身的 WAF 拦截没有 web 记录，才单独落一条 `source=waf`；
- 请求 ID 同时写入响应头 `X-Request-ID`，并与进程日志里的失败记录对应，便于把一次请求串起来；
- 检索支持来源、状态码（`2xx` 或 `404`）、客户端 IP 前缀、域名、方法、关键字
  （路径 / UA / 结果 / 原因 / 错误 / 消息）与时间范围；分页用游标，翻页不会漏也不会重；
- 顶部给出匹配数、4xx/5xx 占比、流量合计、最活跃客户端与平均耗时；
- 表格区固定高度、表头吸顶，只渲染可见行（虚拟滚动），几百上千条也不卡；
  滚动到接近底部会自动加载下一页，筛选条件变化后回到顶部；
- 概览页有最近 24 小时的请求趋势（按小时聚合，5xx 的柱子标红）；
- 支持一键 **导出 CSV**（带 UTF-8 BOM，Excel 直接打开）与 **清空**（清空会删除磁盘文件，需要二次确认）。

> 关闭「写入磁盘」只停止写入，已经落盘的文件不会被删除；内存里的实时缓冲（各模块的访问日志弹窗）也不受影响。
> 记录只保存请求元数据，不保存请求体与响应体，也不记录任何凭据。

---

## IP 地址库

国家 / 省份过滤（Web 路由与端口转发）依赖离线地址库。它是独立的「IP 地址库」页面：

- 支持 **ip2region** 的 xdb 离线库，IPv4 与 IPv6 **各用一份**：页面上两个卡片分别上传，
  上传后立即启用，互不影响；
- 文件版本由 xdb 头自动识别（v4 文件不会被装成 v6 库），校验失败返回 400，
  **不会替换正在使用的地址库**；
- 页面显示加载状态、数据日期、文件大小与保存路径；省份下拉使用 v4 库（v6 库文件大，不做省份扫描），
  没有 v4 库时回退到内置列表；
- 「查询测试」同时支持 v4/v6 地址，用来核对过滤值与地址库是否对得上；
- 地理过滤对 IPv6 同样生效（此前 v6 库会被加载但从不参与查询）。

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
frontend/           管理界面（React 19 + Ant Design 5 + Vite 8 + TypeScript，构建产物进 internal/webui/assets）
cmd/nunt            入口
internal/app        装配与生命周期
internal/api        管理后台 REST API + SSE
internal/config     配置仓库（原子写、校验、订阅）
internal/model      全部持久化类型
internal/module     模块接口与注册表
internal/modules/   各功能模块（web / forward / ddns / acme / waf）
internal/logstore   访问日志存储（SQLite、批量写入、保留策略、游标查询与聚合）
internal/logging    进程日志（ring buffer、SSE 订阅、按大小轮转的文件）
internal/dnsprov    DNS 提供商（DDNS 与 ACME DNS-01 共用）
internal/certs      证书仓库（SNI 热加载）
internal/ip2region  IP 地理库（ip2region xdb：国家/省份/城市）
internal/ipfilter    访问控制过滤器（CIDR + 国家/省份/城市）
internal/vfs        安全文件系统抽象（os.Root）
internal/security   密码、会话、限流
internal/rest       路由与 JSON 工具
internal/webui      管理界面构建产物（go:embed，源码在 frontend/）
web 前端            frontend/（React 19 + Ant Design 5 + Vite 8）
```

模块开发约定见 [docs/CONTRACT.md](docs/CONTRACT.md)（模块接口、REST 约定、前端页面契约）；
公网部署前的检查清单见 [docs/PUBLIC-EXPOSURE.md](docs/PUBLIC-EXPOSURE.md)；
路线图（单管理员口径）见 [docs/ROADMAP.md](docs/ROADMAP.md)；双因子（TOTP）的接口与验收见 [docs/TOTP-PLAN.md](docs/TOTP-PLAN.md)。

### 前端

管理界面是独立的 **React 19 + Ant Design 5 + Vite 8 + TypeScript** 工程，采用「指挥中心」布局：
顶部导航、模块入口式概览、⌘K 命令面板，配置页为主从（列表 + 详情）工作区；浅色优先，支持深色与跟随系统。
源码在 `frontend/`，构建产物提交在 `internal/webui/assets/` 并通过 `go:embed` 打进二进制——所以 `go build`
和最终镜像都不需要 Node；镜像的 `web` 阶段会重新构建一次，保证镜像不会带过期前端。

- 构建：`npm ci --prefix frontend && npm run build --prefix frontend`（或 `make web`），产物会整体重写
  `internal/webui/assets`；**改了前端必须重新构建并提交产物**，CI 会重跑构建并检查产物是否最新；
- 开发：`cd frontend && npm run dev`，页面热更新；9 个页面（含 IP 地址库）+ 登录/改密都在 `frontend/src/pages/`；
- 约束：零外部请求（CSP `script-src 'self'`）、主题用 ConfigProvider 算法切换（light/dark/system）、
  antd 组件与 token，不写死主题色。详细约定见 [docs/CONTRACT.md 第 7 节](docs/CONTRACT.md)。

### 本地验证

```powershell
# 格式化检查 + vet + 全部单元测试 + 交叉编译（linux/amd64、linux/arm64、windows/amd64）
pwsh -File scripts/verify.ps1

# 起一个临时实例，登录并把每个模块接口、前端资源、创建规则后立即生效都跑一遍
pwsh -File scripts/smoke.ps1

# 本机 soak：起实例、建静态规则、并发打 600 次，对比 goroutine/内存/RSS
BIN=./nunt WORKERS=20 EACH=200 ./scripts/soak.sh

# 真机验证「控制台里改监听地址，立即生效」：默认 3113 → 占用失败 → 切到 127.0.0.1:3199
# （同一个会话仍然有效）→ 改回 3113
pwsh -File scripts/listen-rebind.ps1

# 前端：安装依赖、构建、再构建二进制
npm ci --prefix frontend
npm run build --prefix frontend
npm run smoke --prefix frontend   # jsdom 冒烟：8 个路由逐个挂载，捕获运行时错误
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

`.github/workflows/ci.yml`：push / PR 时执行 `gofmt` 检查、`go vet`、`go test`、构建二进制，并按 `linux/amd64` + `linux/arm64` 构建镜像（不推送，arm64 只构建不运行）；跑**阻塞式**的 `govulncheck` 依赖漏洞扫描（依赖中存在可达的已知漏洞时 CI 直接失败）；用 **Trivy** 扫描镜像里「已有修复版本」的 CRITICAL 漏洞（当前为基线阶段，`continue-on-error`，基线确认干净后转阻塞；确认过的例外写进 [`.trivyignore`](.trivyignore) 并注明原因）；另有独立的 `frontend` job 用 Node 构建 React 管理界面，并校验 `internal/webui/assets` 的提交产物与源码一致（过期即失败）。
`.github/workflows/docker-smoke.yml`：在真实 docker daemon 上按发布格式（`type=docker` 归档 + `docker load`）构建镜像并校验容器契约（非 root 用户、低端口 capability、配置与密钥权限、管理 UI 可访问、用日志里的随机密码登录、`nunt healthcheck`），再用 compose 起栈验证环境变量覆盖端口后健康检查仍然跟随。
`.github/dependabot.yml`：gomod 每周、GitHub Actions 每月检查依赖更新（限制同时开启的 PR 数，minor/patch 自动分组）。

---

## 与 Lucky 的关系

本项目在功能取舍上参考了 [Lucky](https://github.com/gdy666/lucky) 的使用体验（模块划分、路由模型），
但代码、配置格式、界面与实现均为独立编写，并做了两点明确取舍：

- **不提供** STUN 内网穿透、网络唤醒（WOL）、云盘挂载等模块（保持攻击面更小、依赖更少）；

---

## License

MIT
