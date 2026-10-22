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

多架构归档 `nunt-v1.0.0-oci.tar.gz` 可用同样方式导入（较新的 Docker 版本支持 `docker load` 读取 OCI 归档）。

## 2. 端口

| 端口 | 用途 | 说明 |
| --- | --- | --- |
| 3113 | 管理后台 | 建议只在内网开放，必要时配 `system.adminAllowIps`（见第 3 节） |
| 80 / 443 | Web 服务 | 由 Web 服务规则里的监听地址决定，可改成任意端口 |
| 自定义 | 端口转发 | 规则里的源地址 |

容器内以非 root（uid 1000）运行，镜像里已经给二进制设置了 `cap_net_bind_service`，因此可以直接绑定 80/443。

### 2.1 在控制台里改管理后台端口（立即生效）

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

### 2.2 用环境变量指定管理后台端口

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
- **健康检查会自动跟随**：镜像的 `HEALTHCHECK` 按与程序相同的优先级取端口——
  `NUNT_ADMIN_PORT` → `NUNT_ADMIN_LISTEN` 的端口部分 → `/data/config.json` 里的
  `system.adminListen` → 内置默认 `3113`。因此**在控制台里改过端口后，healthcheck 会自动跟到新端口**
  （它读的是配置文件里的值）；healthcheck 固定访问 `127.0.0.1`，如果管理面只绑在某个具体网卡地址上，
  需要自行调整（这是既有行为）。
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

## 4. 数据与备份

所有状态都在数据目录里（compose 中映射为 `./data`）：

- `config.json`：全部配置，写入时保留 `config.json.bak`；
- `secret.key`：加密凭据用的密钥，**丢失后已加密的密码/令牌无法恢复**；
- `certs/`、`acme/`：证书与 ACME 账号；
- `shares/`：文件分享记录；
- `logs/`：运行日志。

备份：直接打包整个数据目录即可（包含密钥）。
恢复：把数据目录放回原位并重启；配置也可以在「设置 → 配置导入/导出」里做（导出会自动脱敏，导入时掩码字段保持原值）。

## 5. 证书

1. 在「证书」页新建任务，填写域名（可多个）、密钥类型、挑战方式：
   - **http-01**：需要外部能访问 80 端口，且该域名解析到本机；
   - **dns-01**：需要选择 DNS 服务商并填写凭据（与 DDNS 共用同一批服务商），支持泛域名 `*.example.com`；
   - **tls-alpn-01**：443 端口必须空闲。
2. 签发成功后证书自动入库，Web 服务规则把 TLS 设为 `auto` 即可使用（按 SNI 热加载，无需重启）。
3. 到期前 `renewDays`（默认 30 天）自动续期。

> http-01 会临时占用 80 端口：如果 Web 服务已经监听了 80，请改用 dns-01 或 tls-alpn-01。

## 6. 反向代理与 HTTPS 之外的场景

- 已经有 Caddy/Nginx 在最前面？把 Web 服务规则监听在高端口（如 `127.0.0.1:8080`），TLS 设为 off，由外层反代终止 TLS。
- 需要访问内网服务：规则类型选「反向代理」，上游填 `http://192.168.1.10:5000`；同一条规则可以有多个上游做轮询。
- 需要暴露无认证的内网服务：开启 BasicAuth 或设置 IP 白名单（白名单模式更安全）。

## 7. WAF 与请求体检查策略（上线必读）

WAF 的请求体检查是**按路由声明**的：每条 Web 规则声明自己的 `bodyPolicy`，没声明的继承全局默认值。
全局 5 个字段的最终默认值（改配置页之外也可以直接改 `config.json`，保存时同样会被校验）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enforcementMode` | `observe` | `observe` 只记录「本应拒绝」，`enforce` 真的拒绝；**只改变响应，不改变判定逻辑** |
| `defaultBodyPolicy` | `full` | 未声明策略的路由用它：`full` / `peek` / `skip` / `grpc` |
| `peekBytes` | `65536` | `peek` 策略检查的字节数上限 |
| `peekTimeoutMs` | `250` | `peek` 的空闲超时（毫秒），超时后不再等待客户端 |
| `notifyBodyRatio` | `0`（关闭） | 非 full 请求体检查占比**超过**该值时发一条告警（0–1）；同一进程每小时最多一次，样本少于 50 条不发 |

上线顺序固定为「先观察、后强制」，细节见 [公网部署检查清单](PUBLIC-EXPOSURE.md) 第 4 节与
[请求体检查策略实施清单](PLAN-waf-body-policy.md)：

1. 保持 `enforcementMode=observe` 跑一段完整业务周期；
2. 在 WAF 页看**未声明 bodyPolicy 的路由**列表、**wouldReject 样例**、**bodyState 分布与非 full 占比**；
3. 逐条补齐路由声明；打开 `notifyBodyRatio`（例如 `0.2`）让占比超标时主动告警；
4. 列表清空后再一键切 `enforce`。**在 enforce 之前不要开 body 策略**，否则 chunked / 流式请求会直接被 411 或拒绝。

> ### ⚠️ 能力边界（部署前必须知道）
> **gRPC 流式路由只做首消息检查 + 帧校验。** 声明 `grpc-stream`（含 bidi、客户端流式）的路由只会检查**第一条**消息，
> 之后的消息只做帧层校验（compressed flag、单条消息长度上限 **4MiB**、截断检测），**不做逐消息的 CRS 检查，
> 也不做跨消息累计评分**。这是刻意收窄的范围，不是缺陷：把它当成「首发放攻击能被挡住」，而不是「整个流都被检查过」。
> 同一句话也写在 [README](../README.md)「WAF 与请求体检查策略 → 能力边界」与 [开发契约](CONTRACT.md) 第 8 节。

> **已修复的两个生产问题**（如果你跑的是更早的版本，升级后再核对一遍）：
> 1. **规则级 WAF 之前从未启动**：web 模块自建的 WAF 实例没有任何地方调用 `Start`，导致规则级 WAF 在生产里静默不生效
>    （管理面保护看起来正常，规则却完全不检查）；现在由 web 模块的 `Start` / `Stop` 管理它的生命周期。
> 2. **CRS 对 `application/grpc` 与缺失 `Content-Length` 的误判**：`application/grpc` / `application/grpc-web` 已加入
>    `tx.allowed_request_content_type`，交给引擎的 body 按实际读到的消息长度设置 `Content-Length`。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动日志里没有密码 | 只有首次创建配置时才会打印；忘记密码可在宿主机上删除 `config.json` 里的对应用户条目，或直接用备份恢复 |
| 端口转发不生效 | 检查源地址是否被占用、防火墙是否放行；桥接模式下必须把端口映射出来（推荐 host 网络） |
| DDNS 一直失败 | 先用「测试」按钮验证凭据；注意部分服务商需要 token 具备 DNS 编辑权限 |
| ACME http-01 失败 | 80 端口被占用或域名未解析到本机；改用 dns-01 |
| WAF 误拦正常请求 | 切到「仅检测」模式定位命中规则，把对应规则 ID 加入禁用列表，或降低 PL 等级 |
| WAF 完全没反应（规则级） | 先确认模块已启动、规则上勾了 WAF；旧版本存在「web 模块自建实例从未 Start」的缺陷，升级到含该修复的版本 |
| 收到「非 full 占比超阈值」告警 | 说明有路由在做部分检查：打开 WAF 页看未声明策略的路由与 bodyState 分布，逐条声明 `bodyPolicy`；不需要时把 `notifyBodyRatio` 改回 `0` |
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
