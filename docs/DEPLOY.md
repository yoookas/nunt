# 部署与运维

## 1. 运行方式

| 方式 | 适用场景 | 命令 |
| --- | --- | --- |
| Docker Compose（host 网络） | Linux 主机、软路由、NAS；需要端口转发 / IPv6 / 80、443 | `docker compose up -d --build` |
| Release 镜像归档 | 不能联网构建、需要固定版本 | `docker load < nunt-v1.0.0-amd64.tar.gz` |
| 直接运行二进制 | 路由器 / 小主机 | `./nunt -d /etc/nunt` |

> **只支持 host 网络**：bridge 模式下端口转发、IPv6 与真实客户端 IP 都不可用，因此
> **Docker Desktop（macOS / Windows）不受支持**。host 网络下容器监听的端口就是宿主端口，
> 没有 `ports:` 映射需要维护。

### 从 Release 安装镜像

```bash
# 1. 下载归档与校验和（在 GitHub Release 页面）
sha256sum -c SHA256SUMS --ignore-missing

# 2. 导入镜像
docker load < nunt-v1.0.0-amd64.tar.gz
docker images | grep nunt

# 3. 用 compose 启动（把 image 指到 nunt:v1.0.0，并删除 build 段）
NUNT_IMAGE=nunt:v1.0.0 docker compose up -d
```

多架构归档 `nunt-v1.0.0-oci.tar.gz` 是 OCI 布局，**`docker load` 读不了**：需要 `ctr images import`
或 `podman load`（先解压）。单架构的 `nunt-v1.0.0-<arch>.tar.gz` 才是 `docker load` 能直接吃的 docker 归档。

## 2. 端口

| 端口 | 用途 | 说明 |
| --- | --- | --- |
| 3113 | 管理后台 | 建议只在内网开放，必要时配 `system.adminAllowIps`（见第 3 节） |
| 80 / 443 | Web 服务 | 由 Web 服务规则里的监听地址决定，可改成任意端口 |
| 自定义 | 端口转发 | 规则里的源地址 |

容器内以非 root（uid 1000）运行，镜像里已经给二进制设置了 `cap_net_bind_service`，因此可以直接绑定 80/443；默认的 compose 不需要 `cap_add`。只有你额外加了 `cap_drop: [ALL]`（或跑在老版本 Docker / rootless / Podman 上）时，才需要补回 `cap_add: [NET_BIND_SERVICE]`，否则绑定 80/443 会失败。

> **不要加 `security_opt: [no-new-privileges]`**：它会阻止文件能力（file capabilities）生效，
> 非 root 进程就再也拿不到 `cap_net_bind_service`，80/443 直接绑定失败。要收紧权限请用
> `cap_drop: [ALL]` + `cap_add: [NET_BIND_SERVICE]` 的组合。

### 2.1 容器运行参数（PUID/PGID、日志、停止）

| 参数 | 说明 |
| --- | --- |
| `PUID` / `PGID` | 容器内进程的 uid/gid，默认 `1000`。与宿主机 `./data` 属主不一致时，入口脚本会递归 `chown` 数据目录（只改元数据）再降权；`0` 表示以 root 运行（会有告警）。 |
| `DATA_DIR` | 数据目录，默认 `/data`。同时用于入口脚本、`CMD` 与 `HEALTHCHECK`。 |
| `stop_grace_period: 20s` | compose 里已设置。服务收到 SIGTERM 后有 15 秒收尾预算（等待进行中的请求），默认的 10 秒会被 docker 直接 SIGKILL，长连接被硬断。 |
| `logging.options.max-size/max-file` | compose 里已把 docker 的 json-file 日志限制在 10 MB × 3 份。访问日志有自己的轮转（默认 7 天 × 64 MB），这里管的是 stdout。 |
| `--read-only` | 可用：除 `/data` 外进程不写任何路径（临时文件也建在数据目录里）。记得同时给 `/data` 挂可写卷。 |
| `--user 1000:1000` | 跳过 PUID/PGID 重映射；此时 `/data` 必须已属于该 uid（入口脚本会检查并给出明确报错，退出码 73）。 |

> rootless Docker / Podman 下，非 root 进程绑定 80/443 还受内核开关限制：
> 需要宿主机 `sysctl -w net.ipv4.ip_unprivileged_port_start=0`，或改用 `--cap-add=NET_BIND_SERVICE` 并
> 确认 rootless 端口转发可用。true rootless + host 网络的组合本身也有限制，生产环境建议用普通 Docker + host 网络。

compose 的变量可以放在同目录的 `.env` 里（`cp .env.example .env`），该文件已在 `.gitignore` 与
`.dockerignore` 中，不会被提交也不会进入镜像。

### 2.2 构建参数与固定基础镜像

Dockerfile 的三个基础镜像都可以用构建参数覆盖，方便把镜像固定到 digest 或临时换用打过补丁的基础镜像：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_IMAGE` | `node:24-alpine` | 前端构建阶段 |
| `GO_IMAGE` | `golang:1.26.11-alpine` | Go 构建阶段 |
| `ALPINE_IMAGE` | `alpine:3.21` | 运行时阶段 |

```bash
docker build \
  --build-arg VERSION=v1.0.0 \
  --build-arg COMMIT=$(git rev-parse --short=12 HEAD) \
  --build-arg BUILDTIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg ALPINE_IMAGE=alpine@sha256:... \
  -t nunt:v1.0.0 .
```

`VERSION` / `COMMIT` / `BUILDTIME` 同时写进二进制和镜像的 OCI 标签
（`org.opencontainers.image.version` / `.revision` / `.created`），`docker image inspect` 可以直接看到。
`make docker` 会自动带上这三个参数。

镜像的发布归档由 CI 用与 Release 相同的导出格式构建，并在 `docker-smoke` 里用 `docker load` 加载后
校验标签与容器契约——所以在本地或 CI 能通过的事，发出去归档不会变样。

### 2.3 在控制台里改管理后台端口（立即生效）

管理后台默认监听 `:3113`（配置字段 `system.adminListen`）。**设置 → 系统参数 → 管理监听地址**
可以直接改端口 / 监听地址，保存后立即生效，**不需要重启进程**：

- 后端先在**新地址**上绑定监听器；端口被占用、权限不足、地址非法时返回 `4xx`（`409` / `403` / `400`）
  并在 message 里给出原因，**旧监听保持不变**，配置也不会被改写；
- 绑定成功后才把新地址写进 `config.json`，由旧监听器返回这次保存的 `200`（所以不会出现
  「响应还没发出去端口就没了」）；
- 旧监听器在约 300 ms 后优雅关闭（等待进行中的请求写完），**浏览器会话不受影响**：
  仍是同一个进程、同一份内存会话表，cookie 继续有效；
- 保存响应里的 `adminListen` 是真正生效的地址；设置页会提示新地址并给出「用新地址打开」链接，
  切换后当前页面仍停在旧端口，请用新链接继续操作。

> 运行时改端口只影响当前进程；如果容器被重建，会以 `config.json` 里的值为准（已经写进去了）。

### 2.4 用环境变量指定管理后台端口

管理后台默认监听 `:3113`（配置字段 `system.adminListen`）。部署时可以用环境变量覆盖，
**不需要改 `config.json`**；覆盖值只影响当前进程，不会写回数据卷（换端口重启不会污染配置）。

| 变量 | 取值 | 优先级 |
| --- | --- | --- |
| `NUNT_ADMIN_LISTEN` | 完整监听地址：`:8080`、`127.0.0.1:8080`、`[::1]:8080` | 最高 |
| `NUNT_ADMIN_PORT` | 仅端口：`8080`（等价于 `:8080`） | 次之 |
| `system.adminListen` | 配置文件里的值（默认 `:3113`） | 最低 |

```bash
# 直接运行二进制
NUNT_ADMIN_LISTEN=127.0.0.1:18080 ./nunt -d /etc/nunt
NUNT_ADMIN_PORT=18080 ./nunt -d /etc/nunt          # 仅端口

# docker run（host 网络）
docker run -d --name nunt --network host \
  -e NUNT_ADMIN_LISTEN=:18080 -v "$PWD/data:/data" nunt:dev

# compose（NUNT_ADMIN_LISTEN 留空时用 config.json 里的值，新卷为 :3113；覆盖变量即可）
NUNT_ADMIN_LISTEN=127.0.0.1:18080 docker compose up -d
```

- **只支持 host 网络**，容器监听端口就是宿主端口，换端口时**没有端口映射需要同步**。
  bridge 模式下的端口转发、IPv6 与真实客户端 IP 都不可用，Docker Desktop（macOS / Windows）
  同样不受支持。
- **非法值启动即失败**：例如 `NUNT_ADMIN_LISTEN=abc`、`NUNT_ADMIN_LISTEN=127.0.0.1`、
  `NUNT_ADMIN_PORT=70000` 会打印明确错误并以非零码退出，不会静默回退到 `config.json` 的值。
- **健康检查会自动跟随**：镜像的 `HEALTHCHECK` 执行的是 `nunt healthcheck`（服务自己的子命令，
  不依赖 shell / sed / wget）。它按与主程序**完全相同**的优先级解析地址——
  `NUNT_ADMIN_LISTEN` → `NUNT_ADMIN_PORT` → `/data/config.json` 里的 `system.adminListen` → 内置默认 `3113`
  ——再请求 `http://<地址>/healthz`。因此在控制台里改过端口后，healthcheck 会自动跟到新端口；
  配置写成压缩的一行 JSON 也不会失效。通配地址（`:3113`、`0.0.0.0:3113`、`[::]:3113`）会探 `127.0.0.1` /
  `[::1]`，绑定具体网卡地址时直接探那个地址。
- 手动排查时可单独运行（退出码 0 健康、1 不健康、2 参数错误，异常原因打印到 stderr）：
  ```bash
  docker exec nunt nunt healthcheck
  docker exec nunt nunt healthcheck -d /data -timeout 2s
  docker exec nunt nunt healthcheck -c /data/config.json
  ```
  如果数据目录不在 `/data`，`healthcheck` 会读 `DATA_DIR` 环境变量（镜像默认 `/data`），
  也可以用 `-d` 显式指定。
- **环境变量优先，且会锁住设置页的地址字段**：来源是 `env` 时，「管理监听地址」字段被禁用并说明原因；
  直接调 `PUT /api/v1/system/settings` 修改地址会被拒绝（`409` +
  「当前监听地址由环境变量 NUNT_ADMIN_LISTEN 控制，修改配置不会生效」），**配置不会写入**。
  想改地址请先移除环境变量并重启一次，之后就可以在控制台里随时改、立即生效。
  环境变量存在时，其它设置（日志级别、白名单等）照常保存。
- **查看实际状态**：`GET /api/v1/system/info` 返回 `adminListen`（实际生效值）、
  `adminListenConfig`（配置文件里的值）、`adminListenSource`（`env` / `config`）和
  `adminListenEnv`（具体生效的环境变量名）；`PUT /api/v1/system/settings` 的成功响应里也带
  `adminListen` / `adminListenConfig` / `adminListenSource` / `adminListenApplied`。

## 3. 管理后台 IP 白名单

「设置 → 管理端 IP 白名单」（配置字段 `system.adminAllowIps`，字符串数组）用来限制**谁能访问管理后台**。
它作用于管理端口上的全部内容：登录接口、REST API、管理界面与静态资源，只有 `/healthz` 例外
（容器 healthcheck 从容器内访问，必须始终可达）。

- **留空 = 不限制**：列表为空（或只有空白项）时任何来源都能访问，这是默认行为；
- 列表非空时**只有命中的来源**可以访问，其余请求在进入路由之前就被拒绝：`403` +
  「当前 IP 不在管理后台白名单内」，同时写一条 warn 日志（含 IP、方法、路径）；
- 条目支持单个 IP（`192.168.1.10`、`fd00::1`）和 CIDR（`192.168.1.0/24`、`fd00::/8`），可以混用；
- 单个条目写错只会被忽略，并记一条 warn；**列表非空却没有任何合法条目时 fail-closed（拒绝所有来源）**，
  并记一条 error 日志——避免「写错了等于没设」，此时需要从容器内 / 本机改回配置；
- 列表在配置变更后立即重新解析生效（解析结果有缓存，不会每个请求重新解析），无需重启；
- 查看当前状态：`GET /api/v1/system/info` 的 `adminAllowList` 字段返回 `restricted`（是否启用限制）、
  `entries` / `valid`（配置条目数 / 有效条目数）、`failClosed`、`trustProxy` 和 `blocked`
  （启动以来被白名单拒绝的请求数）。

> **信任反向代理的注意事项**：白名单默认按 TCP 对端地址（`RemoteAddr`）判定。只有当前面确实有一层
> **你自己控制**的反向代理（Nginx / Caddy / 云厂商负载均衡等）时，才打开「设置 → 信任反向代理」
> （`system.trustProxy`）；打开后客户端 IP 改从 `X-Forwarded-For`（其次 `X-Real-IP`）读取。
> 服务直接暴露在公网却开启了信任代理时，任何人都能伪造该请求头绕过白名单。
>
> **不要把自己锁在外面**：只填写公网出口 IP 时，内网与容器内的访问同样会被拒绝；建议同时保留内网网段
> （如 `192.168.0.0/16`、`10.0.0.0/8`）。

### 3.1 双因子（TOTP）

「设置 → 安全」可以给管理账号开启 TOTP：密码之外再要一个验证器生成的 6 位码。
绑定二维码由浏览器本地绘制，不请求任何外部服务；密钥用部署密钥加密后写入 `config.json`，
导出配置时会被替换成掩码。

- **恢复码**：启用时一次性显示 10 枚 `xxxxx-xxxxx`，每枚只能用一次，用后即从配置里删除。
  请立刻保存到离线位置（密码管理器 / 打印），这是设备丢失时唯一的自助入口。
- **忘了验证器、也没有恢复码**：在宿主机上打开 `data/config.json`，把该用户 `totp` 整个删掉
  （或把 `"enabled"` 改成 `false`），然后重启容器：

  ```bash
  docker compose down
  # 编辑 ./data/config.json，删除 "totp": { ... } 这一段
  docker compose up -d
  ```

  重启后登录回到单因子，请立即重新绑定并保存新的恢复码。这会降低当前的安全强度，
  建议只在管理面不直接暴露公网、或已经能物理接触宿主机时使用。
- **恢复码也用完了**：同上，直接改配置；不要试图从日志里找回密钥（日志里没有，也不应该有）。

### 3.2 客户端证书（mTLS）

监听器的 `tls.clientAuth` 设为 `request` 或 `require`，并把签发客户端证书的 CA 证书（PEM，可多个）
放进 `tls.clientCa`，即可要求访问者出示由该 CA 签发的证书；`require` 时未携带或校验失败会在握手阶段被拒。

适合给设备、脚本、内网服务做双向认证，比 BasicAuth 更适合机器对机器。

控制台在「Web 服务 → 监听器 → 客户端证书（mTLS）」里设置：TLS 关闭时该选项不可用，
选择「可选」或「必须」后会出现 CA 证书输入框（PEM，可多张）。保存前会校验 CA 能否解析出证书，
解析不出来会被拒绝；`clientAuth` 为 `require` 却没有有效 CA 时，配置校验同样会拒绝保存，
避免出现「以为开了、实际谁都能进」的状态。监听器列表会标出 `mTLS：必须 / 可选` 便于确认。
修改后保存即触发重新加载。

## 4. 数据与备份

所有状态都在数据目录里（compose 中映射为 `./data`）：

- `config.json`：全部配置，写入时保留 `config.json.bak`；
- `secret.key`：加密凭据用的密钥，**丢失后已加密的密码/令牌无法恢复**；
- `certs/`、`acme/`：证书与 ACME 账号；
- `logs/`：运行日志。

备份：直接打包整个数据目录即可（包含密钥）。也可以在「设置 → 备份」开启**定时备份**：

- 归档只包含 `config.json`、`config.json.bak`、`secret.key`、`certs/`、`acme/`，不含日志与旧备份；
- 默认每 24 小时一份、保留 7 份，路径默认 `/data/backups`（可改成任意绝对路径，例如挂载进来的 NAS 目录）；
- 文件权限 0600，但**内容包含 `secret.key`**，离开本机前请自行加密或放在可信存储上；
- 「立即备份并下载」会现场生成一份并直接下载，同时按保留策略落盘。

恢复：把数据目录放回原位并重启（或解压归档覆盖 `data/` 后重启）；配置也可以在
「设置 → 配置导入/导出」里做（导出会自动脱敏，导入时掩码字段保持原值）。

## 5. 证书

1. 在「证书」页新建任务，填写域名（可多个）、密钥类型、挑战方式：
   - **http-01**：需要外部能访问 80 端口，且该域名解析到本机；
   - **dns-01**：需要选择 DNS 服务商并填写凭据（与 DDNS 共用同一批服务商：阿里云、腾讯云、Cloudflare、Spaceship、自定义回调），支持泛域名 `*.example.com`；
   - **tls-alpn-01**：需要外部能访问 443 端口（Web 服务已监听 443 也可以，挑战会走它的 TLS 监听）。
2. 签发成功后证书自动入库，Web 服务规则把 TLS 设为 `auto` 即可使用（按 SNI 热加载，无需重启）。
3. 到期前 `renewDays`（默认 30 天）自动续期。
4. **调试用 staging**：「证书 → ACME 设置」可以切到 Let's Encrypt staging：
   - 配额宽松，适合反复试 DNS 凭据、TXT 传播、80/443 放行；
   - 签出来的是**浏览器不信任**的测试证书，不要配到对外规则上；
   - ACME 账户注册 URL 与目录绑定，切换后会自动按新目录重新注册（密钥复用），切回正式环境再签发一次即可。

> http-01 / tls-alpn-01 优先复用 Web 服务已经在 80 / 443 上跑的监听（按 `/.well-known/acme-challenge/` 与 `acme-tls/1` 分流）；
> 只有端口空闲时才会临时起一个独立监听。端口被**其它**进程占用时才会失败，此时改用 dns-01。

## 6. 反向代理与 HTTPS 之外的场景

- 已经有 Caddy/Nginx 在最前面？把 Web 服务规则监听在高端口（如 `127.0.0.1:8080`），TLS 设为 off，由外层反代终止 TLS。
- 需要访问内网服务：规则类型选「反向代理」，上游填 `http://192.168.1.10:5000`；同一条规则可以有多个上游做轮询。
- **上游故障转移**：某个上游连续 3 次返回 502/503/504（或连接失败）会从轮询里摘除 30 秒，之后自动放回；
  GET / HEAD / OPTIONS 在连接失败时会自动换一个健康节点重试一次（POST/PUT 不重试，避免重复提交）。
  想确认摘除是否生效，看「日志 → 访问日志」里该上游的 502 记录，以及上一条 `web: retrying on another upstream` 警告。
- 需要暴露无认证的内网服务：开启 BasicAuth 或设置 IP 白名单（白名单模式更安全）。

## 7. WAF（上线必读）

WAF 是内嵌的 [Coraza](https://coraza.io/) v3 + OWASP CRS v4，规则集编译在二进制里，没有外部依赖。
请求体交给 Coraza 自己处理：`bodyLimitKb`（默认 128）设置 `SecRequestBodyLimit`，超过上限的部分按
`ProcessPartial` 只检查前缀，其余字节流式透传给上游——**不会**因为 chunked / 流式 / 大上传而返回 411。

上线建议顺序：

1. 先用「检测模式」（或 `logOnly`）跑一段真实流量，在 WAF 页看拦截日志与命中规则；
2. 误报多就先降 paranoia level、按规则 ID 禁用，再逐步收紧；
3. 确认没有误杀后再切「拦截模式」；
4. 要把管理面也保护起来时打开 `adminProtect`（拦截页不回显用户输入）。

| 现象 | 处理 |
| --- | --- |
| 正常请求被拦 | 切检测模式定位命中规则，把规则 ID 加进禁用列表，或降低 PL 等级 |
| 规则级 WAF 没反应 | 先确认模块已启动、该路由勾了 WAF；旧版本存在「web 模块自建实例从未 Start」的缺陷，升级到含该修复的版本 |
| 大文件上传被拦 | 提高 `bodyLimitKb`；超过上限的部分本来就不会被检查，属预期行为 |
| 容器里看不到真实客户端 IP | 使用 host 网络；若前面还有一层代理，打开「信任代理」 |

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动日志里没有密码 | 只有首次创建配置时才会打印；忘记密码可在宿主机上删除 `config.json` 里的对应用户条目，或直接用备份恢复 |
| 端口转发不生效 | 检查源地址是否被占用、防火墙是否放行；桥接模式下必须把端口映射出来（推荐 host 网络） |
| DDNS 一直失败 | 先用「测试」按钮验证凭据；注意部分服务商需要 token 具备 DNS 编辑权限 |
| ACME http-01 失败 | 域名未解析到本机，或 80 端口被别的进程占用（web 模块自己占用没关系：http-01 会走它的监听）；仍失败时改用 dns-01 |
| WAF 误拦正常请求 | 切到「仅检测」模式定位命中规则，把对应规则 ID 加入禁用列表，或降低 PL 等级 |
| 验证器丢失 / 恢复码用完 | 见 3.1：宿主机改 `config.json` 删除该用户的 `totp` 段后重启 |
| 容器里看不到真实客户端 IP | 使用 host 网络；若前面还有一层代理，打开「信任代理」 |

## 9. 升级

```bash
# 源码方式
git pull && docker compose up -d --build

# 镜像方式
docker load < nunt-v1.0.1-amd64.tar.gz
NUNT_IMAGE=nunt:v1.0.1 docker compose up -d
```

配置格式带版本号（`version` 字段），升级时会自动补齐新增字段与默认值；跨大版本升级前建议备份数据目录。

## 10. 监控（Prometheus）

`GET /metrics` 输出 Prometheus 文本格式，**与后台同一套鉴权**：只能用 API Token 抓取（会话 cookie 不行，
`/metrics` 也不对匿名请求开放）。在「设置 → API Token」建一个只读 Token，然后：

```yaml
scrape_configs:
  - job_name: nunt
    authorization:
      credentials: <只读 API Token>
    static_configs:
      - targets: ["192.168.1.2:3113"]
```

指标：`nunt_up`、`nunt_uptime_seconds`、`nunt_build_info`、`nunt_web_rules`、`nunt_forward_rules`、
`nunt_module_up{module=...}`、`nunt_certificates`、`nunt_certificate_expiry_timestamp_seconds{id=...}`、
`nunt_access_log_written_total`、`nunt_access_log_dropped_total`、`nunt_access_log_bytes`。

证书到期可以直接做成告警：

```yaml
- alert: NunTCertificateExpiring
  expr: nunt_certificate_expiry_timestamp_seconds - time() < 7 * 86400
  annotations:
    summary: "nunt 证书 {{ $labels.id }} 将在 7 天内过期"
```
