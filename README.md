# nunt

一个用 Go 编写的自托管边缘服务：**反向代理、重定向、静态托管、端口转发、动态域名（DDNS）、ACME 自动证书、WebDAV、文件管理、Coraza WAF**，
带一个轻量、无构建步骤的 Web 管理界面，支持 Docker Compose 一键部署。

> 设计目标：单二进制、跨平台、默认安全、界面简洁；面向软路由 / NAS / 家庭服务器 / 小团队内网。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| **Web 服务** | 同一套监听器上按「监听地址 + 域名 + 路径」路由，支持 5 种规则类型：反向代理、重定向、静态托管、文件管理（FileBrowser）、WebDAV。支持 IP/UA 黑白名单、HTTP Basic 认证、多上游负载均衡（轮询/随机/IP 哈希）、路径重写、自定义请求/响应头、WebSocket、访问日志 |
| **端口转发** | TCP / UDP / 同时转发，源地址 → 目标地址，支持 IPv6、源 IP 黑白名单、空闲超时、活跃与累计连接数、上下行流量统计、访问日志 |
| **动态域名 DDNS** | 内置 Cloudflare、阿里云、DNSPod、Dynv6、DuckDNS、No-IP、FreeDNS、deSEC、Porkbun、NameSilo、GoDaddy、Namecheap、Vercel 与「自定义回调」；支持多子域名、A/AAAA、TTL、间隔或 cron 调度、公网 IP 探测（网卡 / URL / 静态）、变化才更新、失败通知 |
| **ACME 自动证书** | 基于 `golang.org/x/crypto/acme` 自研签发流程，支持 http-01 / dns-01 / tls-alpn-01，DNS-01 复用 DDNS 的提供商，自动续期（默认剩余 30 天），证书热加载、无需重启 |
| **WebDAV** | 基于 `golang.org/x/net/webdav`，可挂载本地目录或远程 WebDAV，细粒度读写权限，支持 Windows 资源管理器 / macOS 访达 / rclone / RaiDrive 挂载 |
| **文件管理** | 服务端渲染的文件浏览器：上传（拖拽 + 进度）、下载（Range、断点续传）、新建、重命名、删除、搜索、目录分享链接（可设有效期） |
| **Coraza WAF** | 内嵌 OWASP CRS 规则集，支持检测/拦截模式、PL 等级、入站/出站阈值、规则文件勾选、自定义 SecLang 规则、拦截日志与在线测试 |
| **计划任务** | 可视化 cron：模块启停、规则开关、HTTP 请求、Webhook 通知（Shell 需显式开启） |
| **通知** | 通用 Webhook，事件：证书签发/失败、DDNS 更新/失败、系统告警 |

管理界面：概览、Web 服务、端口转发、动态域名、证书、存储、文件、WAF、计划任务、通知、日志、设置。

---

## 快速开始

### 1. Docker Compose（推荐）

```bash
git clone <this-repo> nunt && cd nunt
docker compose up -d --build
```

- 使用 **host 网络**（`docker-compose.yml`）：端口转发、IPv6、80/443 都能正常工作，Linux 推荐。
- Docker Desktop（macOS / Windows）用 \`docker-compose.bridge.yml\`，只映射 16601/80/443。
- 首次启动会在日志里打印**随机生成的管理员密码**，登录后请立即修改：

```
============================================================
  A new configuration was created.
  Administrator user : admin
  Administrator pass : xxxxxxxxxxxxxxxx
  Sign in and change it immediately.
============================================================
```

管理地址：`http://<主机IP>:16601`

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

---

## 目录与配置

```
data/
├── config.json      # 全部配置（0600），原子写入，保留 .bak
├── secret.key       # 凭据加密密钥（0600，AES-256-GCM）
├── certs/           # 证书仓库（cert.pem / key.pem / meta.json）
├── acme/            # ACME 账号密钥与注册信息
├── shares/          # 文件分享链接记录
└── logs/            # 运行日志（按大小轮转，保留 3 份）
```

- 所有敏感字段（DDNS/DNS 凭据、WebDAV 密码、BasicAuth 密码、Webhook 头）**加密存储**；
- API 返回时统一脱敏为 `********`，保存时该掩码表示「不修改」；
- 导出配置会自动脱敏，可直接用于备份或分享排障。

---

## 安全设计

- **认证**：Argon2id 密码哈希；会话为服务端存储的随机令牌（HttpOnly + SameSite=Strict + TLS 下 Secure），修改密码后旧会话立即失效。
- **CSRF**：会话鉴权的写操作必须带 `X-CSRF-Token`（登录时下发）。
- **暴力破解**：登录失败按「用户名 + IP」计数，超过阈值指数退避锁定；API 有令牌桶限流。
- **开放 API**：Bearer Token 或 `X-API-Token`，令牌只存 SHA-256 哈希，可限制 scope，可随时吊销。
- **文件安全**：静态托管、文件管理、WebDAV 全部走基于 `os.Root` 的虚拟文件系统，符号链接与 `..` 逃逸在内核层面被拒绝。
- **反向代理**：剥离 hop-by-hop 头、可控超时、上游仅允许 http/https，响应头可裁剪。
- **WAF**：Coraza + CRS，可保护后台接口本身；拦截页面不回显用户输入。
- **TLS**：最低 TLS 1.2、仅 ECDHE 系列套件、按 SNI 热加载证书。
- **其它**：管理后台支持 IP 白名单；配置与密钥文件权限 0600；日志不记录任何凭据。

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
cmd/nunt            入口
internal/app        装配与生命周期
internal/api        管理后台 REST API + SSE
internal/config     配置仓库（原子写、校验、订阅）
internal/model      全部持久化类型
internal/module     模块接口与注册表
internal/modules/   各功能模块（web / forward / ddns / acme / waf / task / filebrowser / webdav）
internal/dnsprov    DNS 提供商（DDNS 与 ACME DNS-01 共用）
internal/certs      证书仓库（SNI 热加载）
internal/vfs        安全文件系统抽象（os.Root）
internal/mounts     存储挂载（本地 / 远程 WebDAV）
internal/security   密码、会话、限流
internal/rest       路由与 JSON 工具
internal/webui      前端静态资源（embed，无构建步骤）
web 前端            internal/webui/assets/{index.html,style.css,app.js,lib,pages}
```

模块开发约定见 [docs/CONTRACT.md](docs/CONTRACT.md)（模块接口、REST 约定、前端页面契约）。

### 前端

前端是**纯静态 ES Module**，不需要 npm / 打包器，直接放在 `internal/webui/assets` 并通过 `go:embed` 打进二进制。
新增页面：在 `assets/pages/<id>.js` 里 `export default { id, title, icon, mount(root, ctx) }`，再在 `app.js` 的页面清单里注册。

### 本地验证

```powershell
# 格式化检查 + vet + 全部单元测试 + 交叉编译（linux/amd64、linux/arm64、windows/amd64）
pwsh -File scripts/verify.ps1

# 起一个临时实例，登录并把每个模块接口、前端资源、创建规则后立即生效都跑一遍
pwsh -File scripts/smoke.ps1
```

---

## 发布流程

`.github/workflows/release.yml`：

1. 触发条件：推送 `v*` tag（或手动指定 tag）；
2. 用 buildx + QEMU 构建 `linux/amd64`、`linux/arm64`、`linux/arm/v7` 三种镜像，导出为 `docker save` 格式归档（`type=docker`），另外产出一个多架构 OCI 归档（`type=oci`）；
3. 压缩为 `.tar.gz`、生成 `SHA256SUMS`；
4. 创建/更新 Release 并上传全部附件。**不登录、不推送任何镜像仓库。**

`.github/workflows/ci.yml`：push / PR 时执行 `gofmt` 检查、`go vet`、`go test`、构建二进制与镜像（不推送）。

---

## 与 Lucky 的关系

本项目在功能取舍上参考了 [Lucky](https://github.com/gdy666/lucky) 的使用体验（模块划分、路由模型、DDNS 提供商范围），
但代码、配置格式、界面与实现均为独立编写，并做了两点明确取舍：

- **不提供** STUN 内网穿透、网络唤醒（WOL）、云盘挂载等模块（保持攻击面更小、依赖更少）；
- **不提供**任意 Shell 能力，计划任务默认只允许模块/规则开关与 HTTP 请求。

---

## License

MIT
