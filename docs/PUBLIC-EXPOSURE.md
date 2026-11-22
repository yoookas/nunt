# 公网部署就绪检查（Public Exposure Readiness）

> **适用前提**：本文与文末清单针对**把 nunt 直接暴露到公网**的部署形态——80/443 直接对外、域名对外解析、管理面可能被扫描到。
> 纯内网 / 自用场景（只在局域网或 VPN 内使用）**不要求**满足清单里的全部条目：威胁模型不同，按需裁剪。
>
> 本文里的「已验证 / 未验证」是**验证状态**，不是「代码写没写」。代码合并、单测通过都不等于验证通过。
> **勾选代表已验证，不代表已部署**：某一条被勾上，只说明它在当前仓库里已经实现并被测试覆盖过；
> 是否已经在你的公网实例上生效，仍然要按第 6 节的判据自己跑一遍。

相关文档：[部署与运维](DEPLOY.md) · [开发契约](CONTRACT.md)

---

## 1. 威胁模型：内网 vs 公网差在哪

内网部署的隐含假设是「能连上的人已经是自己人」；公网部署没有这个假设。具体差异：

| 维度 | 内网 | 公网 |
| --- | --- | --- |
| 谁在连接 | 已知网段里的设备 | 全互联网的扫描器、爬虫、恶意机器人；上线后**几分钟内**就会被扫到 80/443/3113 |
| 管理面价值 | 和业务面差不多 | **最高价值目标**：拿到管理面 = 拿到全部规则、全部凭据（DDNS/WebDAV/Webhook）、全部文件挂载。管理面一旦暴露且只靠密码，唯一防线就是密码强度与登录锁定 |
| 每条规则 | 一条配错的规则顶多内网可达 | 每条规则都是一个被扫描入口；错配（匿名文件服务、无认证反代到内网管理口、端口转发当成开放中继）会立刻被利用 |
| 证书 | 自签/忽略告警也能用 | **证书过期 = 全站不可用**：浏览器直接拦截，没有「继续访问」；ACME 续期失败必须在到期前被发现 |
| WAF | 误报能自己忍 | **WAF 误报会掉业务**：拦掉的是真实用户与真实交易，且往往在下班后/半夜才被发现 |
| 失败模式 | 服务挂了重启即可 | 被入侵后要面对数据泄露、被当作跳板、被加进黑名单；恢复成本远大于一次重启 |

由此得到三条设计取向，本文其余部分都围绕它们：

1. **管理面与业务面物理/网络隔离**，而不是靠一个密码区分（第 2 节）。
2. **默认拒绝**：没显式声明放行的能力，不对外提供（第 3 节，含文件服务的配置校验）。
3. **先观察后强制**：任何会拒绝流量的开关（WAF、请求体策略）都先跑观察期（第 4 节）。

---

## 2. 管理面隔离

管理面（默认 `:3113`，由 `system.adminListen` 决定）**不应该直接从公网可达**。按优先级从高到低：

> 这个端口可以在控制台里随时改、保存后立即生效（见 [部署与运维](DEPLOY.md) 2.1 节），
> 换端口本身**不是**安全边界——扫描器会跟着扫新端口；隔离要看下面的监听地址与网络位置。

### 方案 A（推荐）：只监听回环 + 隧道

```json
{
  "system": {
    "adminListen": "127.0.0.1:3113"
  }
}
```

- 公网/防火墙层面 3113 完全不可达，端口扫描看不到它；
- 运维通过 WireGuard / Tailscale / SSH 端口转发进入：
  ```bash
  ssh -N -L 3113:127.0.0.1:3113 user@edge-host   # 然后浏览器打开 http://127.0.0.1:3113
  ```
- 这是唯一不依赖应用自身校验的隔离方式，**在公网场景应作为默认选择**。注意容器使用 host 网络时同样成立（监听地址写在配置里，不由 compose 决定）。

### 方案 B（次选）：反代规则 + TLS + BasicAuth + IP 白名单 + WAF adminProtect

如果确实需要从公网访问管理面（例如没有 VPN），必须叠加多层，缺一不可：

1. 用一条 Web 规则反代到 `http://127.0.0.1:3113`（**不要**再把 adminListen 本身监听在 `0.0.0.0`）；
2. `tls.mode` 设为 `auto`（或 `custom` 指定证书），管理面必须走 HTTPS；
3. 该规则开启 **BasicAuth**（`basicAuth.enable=true` + 至少一个用户）；
4. 该规则设置 **访问控制白名单**（`access.mode="allow"` + `access.ips`，例如公司出口 IP / 家庭固定 IP）；这样即使 BasicAuth 被爆破也无入口；
5. 打开 **WAF 管理面保护**（`waf.enable=true` 且 `waf.adminProtect=true`），让后台接口本身也过 CRS；
6. `system.adminAllowIps` 作为**应用内**的第二道闸（见下）。

另可选：`web.rules[].tls.hsts=true`，以及用计划任务/通知监控登录失败。

### `system.adminAllowIps` 的实际行为（写文档时的代码事实）

- 该列表**已经在请求路径上强制执行**（`internal/api/allowlist.go`）：它包住整个管理面——REST API、静态资源、登录页；只有 `/healthz` 例外（容器健康检查从容器内部发起，必须放行）。
- `adminAllowIps` **为空 = 不限制**（保持历史行为）；**非空但一条都解析不出来 = 全拒**（fail-closed，启动时日志会打 error）；列表里的非法条目会被丢弃并记 warning。
- 客户端地址的取法受 `system.trustProxy` 影响：`trustProxy=true` 时取 `X-Forwarded-For`/`X-Real-IP`。**只有在你确实信任前置代理时才能打开它**——否则任何人都能用伪造的 `X-Forwarded-For` 绕过白名单。
- 反代到管理面时，若外层是 nunt 自己的 Web 规则，客户端 IP 由 nunt 注入，可信；若外层是第三方反代（Caddy/Nginx/CDN），必须保证它**覆盖**而不是追加客户端传入的 XFF 头，并只在直连该代理的链路上开 `trustProxy`。
- 概览/系统信息里能看到生效状态（`adminAllowList`：`restricted` / `entries` / `valid` / `failClosed` / `trustProxy` / `blocked`），可用来确认「白名单到底有没有在管事」。

> 结论：**方案 A + `adminAllowIps`** 是公网场景的底线组合；只靠密码 + 登录锁定不够。

---

## 3. 最小暴露面清单

原则：**只开你需要的那一条**，其余全部关掉；能被别人扫到的东西越少越好。

### 3.1 只开必要的监听与路由

- `web.rules[].listen` 只写需要的地址与端口；能用 `127.0.0.1:8080`（前面有别的反代）就不要写 `:80`。
- `web.rules[].domains` 尽量写具体域名；泛域名（`*.example.com`）会把这个监听上的所有子域都吃进来，只有确实需要时再用。
- `web.rules[].path` 用精确路径，避免整站都被一条规则接走。
- 不用的规则**删掉**，不要只把 `enable` 改成 `false` 留在配置里（配置本身就是攻击面与误操作面）。
- 静态托管不要随手打开目录列表（`static.listing`）：列表会把不打算公开的文件名、备份文件、`.git` 之类暴露出去。
- 计划任务的 shell 能力保持关闭（`tasks.allowShell=false`），公网实例上不建议打开。

### 3.2 WebDAV 必须认证

**这是配置校验强制的**：类型为 `webdav` 的 Web 规则，如果**既没有启用的 BasicAuth**（`basicAuth.enable=true` 且 `users` 非空）**也没有 IP 白名单**（`access.mode="allow"` 且 `access.ips` 非空），保存/更新配置会直接失败，报错形如：

```
web rule "文件": type webdav exposes the file storage without authentication,
enable BasicAuth for this rule (basicAuth.enable with at least one user)
or set the access control to allow + IP list
```

放行方式二选一（也可以都配）：

| 方式 | 配置 | 适用 |
| --- | --- | --- |
| BasicAuth | `basicAuth.enable=true` + 至少一个 `users` 条目 | 需要给外部用户/设备访问 |
| IP 白名单 | `access.mode="allow"` + `access.ips`（CIDR 或单 IP） | 只给内网/VPN/回源段访问，最省事也最安全 |

注意几个容易踩的点：

- `access.mode="deny"` **不算**白名单：deny 只是拒绝列出的地址，其它地址仍然放行，因此不满足校验；
- `basicAuth.enable=false`、或 enable 了但 `users` 为空，都不算；
- 文件服务默认就不该匿名：匿名可写的 WebDAV 等于把一个不需要密码的网盘挂到公网，扫描器有现成的指纹与利用工具。

### 3.3 端口转发：ACL + 并发上限

每条 `forward` 规则都应当：

- 有 `access.mode` 白名单（`allow` + 具体 `ips`），至少不要对全网开放；`deny` 只能挡已知坏地址，挡不住「谁都能连」；
- 设置并发上限，避免被当成放大器或连接耗尽器：
  - `maxConns`：该规则同时在转发的连接数上限（**默认 1024**，0 表示不限制，落盘时由 Normalize 补齐默认值）；
  - `maxConnsPerIP`：单个源 IP 的并发连接上限（**默认 64**）；
  - `timeoutSec`：空闲超时，及时回收半死连接；
- UDP 转发另有内置的会话数上限（`udpMaxSessions = 1024`，超过直接丢弃并记日志），防止被当作反射放大器；
- **不要把端口转发指向内网管理口**（如路由器 22/80、数据库、Docker socket、其它设备的管理页面）；这是「内网穿透」类事故最常见的成因；
- 明确知道自己开的是什么端口：`445`、`3389`、`6379`、`2375` 这类端口在公网上被扫到就会被爆破。

### 3.4 反向代理：速率与体积极限 + 上游约束

- 每条对外代理规则设置：
  - `proxy.rateLimitPerSec`：单客户端每秒请求数上限（0 = 不限速，按业务压测定一个不误伤的值）；
  - `proxy.maxBodyBytes`：请求体大小上限（0 = 不限制，建议按业务最大值设置，例如 8MiB）；
  - `proxy.timeoutSec`：上游超时，避免慢连接把连接数占满；
- 上游只允许 `http://` / `https://`，不要代理到 `file://` 之类（服务端已限制）；
- 上游是内网服务时，**先确认那个服务自己有没有认证**：反代不会替它加认证（要加就配 BasicAuth 或白名单）；
- 该剥离的响应头（`Server`、内部路径、调试头）用 `proxy.respHeaders` 裁掉，减少信息泄漏；
- 不需要出站流量的规则就别开 WAF body 检查之外的额外功能，保持链路简单。

### 3.5 CDN / 前置代理：隐藏源站 + 只放行回源段

- 源站 IP 一旦暴露，前面套多少层都白搭：**源站只允许 CDN 回源段访问**（用本机防火墙 + 云安全组；nunt 侧可在规则上再加一层 `access.ips` 白名单）；
- 只放行 CDN 官方公布的回源网段，并随 CDN 更新（部分厂商提供自动更新的源站白名单）；
- 真实客户端 IP 由 CDN 通过 `X-Forwarded-For`（或 `CF-Connecting-IP` 等）传递：确认 nunt 侧取到的是真实 IP（`system.trustProxy=true` **且**只有 CDN 能直连源站，二者必须同时成立）；
- 回源建议走 HTTPS + 自定义回源头校验，避免有人直接以源站 IP 发请求；
- 上 CDN 后，日志与访问控制里的客户端 IP 会变成 CDN 节点地址——白名单、限速、封禁全部要按「CDN 转发后的真实 IP」重新验证一遍。

### 3.6 持续守卫（CI）

- `.github/workflows/ci.yml`：`gofmt` 检查、`go vet`、`go test`、构建二进制与镜像；
- 同文件里的 **`govulncheck` job 是阻塞的**（不设 `continue-on-error`）：依赖里存在「可达的已知漏洞」时 CI 直接失败——面向公网的服务不该把这种发现降级成警告；
- `.github/dependabot.yml`：gomod 每周检查（同时最多 3 个 PR，minor/patch 自动分组）、GitHub Actions 每月检查（最多 2 个 PR），避免更新 PR 刷屏；
- `.github/workflows/docker-smoke.yml`：在真实 docker daemon 上构建镜像、host 网络启动、校验容器契约（uid 1000、`cap_net_bind_service`、`/data` 下配置与密钥 600、管理 UI 与静态资源可访问、用日志里的随机密码登录并拉到模块列表、两个 compose 文件可被 `docker compose config` 解析）。

---

## 4. 上线顺序：先观察，后强制

**一次只改一个变量，每一步都留回滚点。** 建议顺序：

0. **备份**：打包整个数据目录（含 `secret.key`），并把这次变更前的 `config.json` 单独留一份（配置导入/导出界面也支持，导出会自动脱敏）。
1. **WAF 先只记录**：`waf.enable=true` + `waf.logOnly=true`（等价于「仅检测」），或 `waf.mode="detect"`。
   - 跑够覆盖业务周期的时间（至少一个完整的工作日 + 一次批量任务/报表窗口）；
   - 在 WAF 页看命中日志，把误报的规则 ID 加进 `waf.disabledRules`，必要时降低 `waf.paranoiaLevel`；
   - 误报清零（或降到可接受）后再切 `waf.logOnly=false` + `waf.mode="block"`。
2. **证书先在 staging CA 上跑通**：`acme.ca` 选 `letsencrypt-staging`（或 `custom` + `acme.caCustomUrl` 指向测试目录），确认 http-01 / dns-01 流程、入库、热加载都正常，再切回 `letsencrypt` / `zerossl` / `buypass` 正式 CA。
   - 注意 ACME 有速率限制，调试期反复签发用 staging，别把正式 CA 的配额打满。
3. **业务流量先小范围**：先切一个低风险域名/路径，观察 30–60 分钟（错误率、5xx、WAF 拦截量、连接数），再逐步扩大。
4. **管理面收紧放在最后一步之前**：确认隧道或白名单可用**之后**再改 `adminListen`/`adminAllowIps`——顺序反了会把自己关在门外（此时只能上机改 `config.json` 并重启）。

---

## 5. 上线勾选清单

**本清单的勾选状态代表已通过验证，不是已写代码。**

### P0（不满足就别上公网）

- [x] AdminAllowIPs 真正强制执行 + 管理面只监听回环/内网 —— **代码已实现并有测试**：白名单在请求路径上包住整个管理面
      （`internal/api/allowlist.go`，行为见第 2 节）；「只监听回环」是部署动作，勾选后仍须自己把 `adminListen` 改掉并从外网确认端口不可达（判据见第 6 节）
- [x] 端口转发加每规则最大连接数 + 每 IP 连接上限 —— **代码已实现并有测试**（`maxConns` 默认 1024、`maxConnsPerIP` 默认 64、UDP 会话上限 1024）
- [x] 反向代理加每规则速率限制 + 请求体上限 —— **代码已实现并有测试**（`proxy.rateLimitPerSec` / `proxy.maxBodyBytes`）
- [x] WebDAV 默认要求认证（未配认证时显式拒绝）—— **代码已实现并有测试**：保存配置即被拒绝（fail-closed），见第 3.2 节
- [ ] ACME 对真实 CA（先 staging 再正式）实测签发 + 续期 + 热加载 —— **保持未勾**：代码在，真实 CA 没跑过（见第 7 节第 2 条）
- [x] CI 加 govulncheck + Dependabot —— **已实现**：阻塞式 `govulncheck` job + `.github/dependabot.yml`（见第 3.6 节）
- [x] 容器契约在 CI 的真实 docker daemon 上验证通过 —— **已验证**：`docker-smoke.yml` 于 2026-10-15 首次全绿，覆盖镜像构建、
      以 uid 1000 运行、`setcap` 允许绑定低端口、`/data` 下 `config.json`/`secret.key` 权限 600、Dockerfile 的 HEALTHCHECK 变为
      `healthy`、管理 UI 与静态资源可访问、用日志里的随机密码登录并拉到模块列表。该轮同时修掉两个真实缺陷（WebDAV 上传字节计数
      的数据竞争；`GET /api/v1/modules` 因子树模式返回 301 而非数据）
- [ ] 在目标主机上实跑 `docker compose up`（host）—— **保持未勾**：CI 只做了 `docker compose config` 解析与直接 `docker run`，
      真正的 `compose up`（含卷权限、host 网络下的端口占用）仍需在你自己的机器或服务器上跑一次（见第 7 节第 1 条）

> 勾选说明：打勾代表**已验证**（在当前仓库里已实现并被测试覆盖），**不代表已部署**——是否已经在你的实例上生效，
> 仍要按第 6 节的判据自己跑一遍（与开头的说明一致）。

### P1（上线前应有）

- [ ] CDN/前置代理 + 源站回源白名单
- [ ] 通知渠道打通（证书到期、模块异常、WAF 拦截突增）
- [ ] 24h soak + 并发压测（含 gRPC 流式与 WebSocket 长连接）
- [ ] 备份/恢复与升级回滚各演练一次

### P2（上线后按需）

- [ ] WAF 误报排除工作流（按规则 ID 禁用 + 文档）
- [ ] 真实 CA / 真实 DNS 联调 —— **保持未勾**：ACME 未对真实 CA 完成过签发；`internal/dnsprov` 的两家国内提供商（阿里云、DNSPod）与自定义回调只有接口形状与单测（见第 7 节第 2、3 条）

> 上面打勾的条目同样只代表「已实现 + 有测试」，不代表已在真实环境跑过。

---

## 6. 每条怎么算「通过」（验收判据）

| 条目 | 判定方式（可复现） |
| --- | --- |
| AdminAllowIPs 强制执行 | 把 `adminAllowIps` 设成非本机网段 → 立刻 403（登录页与静态资源同样 403）；`/healthz` 仍 200；概览里的 `adminAllowList.blocked` 增长；再把 `adminListen` 改为 `127.0.0.1:3113`，从外网 `nmap`/`curl` 确认端口不可达 |
| 端口转发并发上限 | 用 `maxConns`/`maxConnsPerIP` 设小值（如 5 / 2），多开连接观察：超出被拒并落访问日志；连接释放后能恢复；UDP 规则超过 1024 会话被丢弃并记日志 |
| 反代速率/体积极限 | `proxy.rateLimitPerSec` 设小值后用 `ab`/`hey` 打，确认超限返回限流响应且不误伤正常速率；`proxy.maxBodyBytes` 设 1MiB 后上传 2MiB 被拒、1MiB 通过 |
| WebDAV 认证 | 新建 webdav 规则不配认证 → 保存被拒（错误信息见 3.2）；配 BasicAuth 或白名单后保存成功；匿名请求实际返回 401/403 |
| ACME 真实 CA | staging 上完成一次完整签发 + 到期前自动续期 + 不重启热加载（浏览器证书指纹变化）；再在正式 CA 上重复一次；证书过期前有通知 |
| govulncheck + Dependabot | CI 上 `govulncheck` job 真实跑过一次并绿；故意引入一个已知漏洞版本时 job 变红；仓库 Insights → Dependency graph 能看到 Dependabot 的 PR |
| 真实 Docker（compose up） | `docker compose -f docker-compose.yml up -d --build` 在目标主机上跑通一次；`docker-smoke.yml` 在 CI 上真实执行过一次并绿 |
| CDN + 回源白名单 | 直接访问源站 IP 被拒（非 CDN 回源段）；经 CDN 正常；日志里看到真实客户端 IP；安全组/防火墙规则可复现导出 |
| 告警打通 | 主动制造事件（证书剩余天数告急、模块异常退出、WAF 拦截突增）→ 通知渠道收到；且不会重复轰炸 |
| soak + 压测 | 24h 连续运行无内存/goroutine/连接泄漏（对比前后 RSS 与统计）；压测达到预期 QPS 且 P99 达标；gRPC 流式与 WebSocket 长连接各跑一轮 |
| 备份/恢复与回滚 | 从备份恢复到一个干净主机能起来（含证书与凭据可用）；把版本回滚到上一版并确认配置可读（`version` 字段向后兼容） |
| 真实 CA / 真实 DNS 联调 | 见「ACME 真实 CA」一行；DNS 侧另需：用真实账号跑一次 DDNS 更新（记录出现在服务商控制台）与一次 ACME dns-01 签发，失败路径（错凭据、错域名）也各跑一次并确认有通知 |

---

## 7. 当前**尚未验证**的事项（诚实清单）

以下都是「代码在，但没在真实条件下验过」，在勾选清单之前请先补上：

1. **Docker 未实跑**：本机没有跑过 `docker compose up`；`.github/workflows/docker-smoke.yml` 已经写好（构建镜像 + host 网络启动 + 校验容器契约），并在 CI 上跑通过一次。
2. **ACME 未对真实 CA 跑过**：没有在 Let's Encrypt（staging 或正式）/ZeroSSL/Buypass 上完成过真实签发；续期循环、失败重试、证书热加载都只有单元测试与本地自签验证。
3. **DNS 提供商未真实联调**：`internal/dnsprov` 只保留了阿里云 DNS 与 DNSPod（腾讯云）两家国内提供商，外加自定义回调；它们目前只有接口形状与单元测试，没有用真实账号调过 API（DDNS 与 ACME dns-01 都依赖它们）。
4. **没有 race / 压测 / soak**：没有跑过 `go test -race` 的长时间运行，没有并发压测，没有 24h soak；连接泄漏、goroutine 泄漏、限流参数是否合适都还是未知数。
5. **前端未真机浏览器验证**：管理界面只做过静态资源可访问性检查（HTTP 200），没有在真实浏览器里逐页点过（尤其是 WAF 规则编辑、SSE 日志这几处）。
6. **管理面白名单未在真实公网验证**：`adminAllowIps` 的强制逻辑有单测覆盖，但没有在真实公网环境（含 CDN/第三方反代 + `trustProxy`）验证过取到的客户端 IP 是否就是期望值。
7. **WAF 误报率未知**：CRS 在真实业务流量下的误报率没有数据；`paranoiaLevel`、`inboundThreshold` 等参数目前是按经验值设的。
   **非 full 占比告警也还没在真实流量下发过**：阈值门限、每小时一次的去重、样本下限都有单测覆盖，但「真实业务下占比多少算异常」需要你自己定（先设一个值跑一周，再按收到的告警调）。
8. **TLS 配置未经第三方扫描**：TLS 1.2+ / ECDHE 套件是代码里的约束，但没有用 SSL Labs 之类工具实测过评级，也没有验证 OCSP/证书链在移动端与老设备上的兼容性。

---

## 8. 迁移：现存的匿名 WebDAV 配置

### 为什么会保存失败

WebDAV 的认证校验是 **fail-closed** 的：只要规则没有「启用的 BasicAuth」或「allow + IP 白名单」，**保存配置**就会被拒绝。这是刻意的——匿名可写的 WebDAV 在公网上等于一个免密网盘。

### 具体行为（很重要）

- **启动时不会因为这条规则拒绝配置**：`config.Load` 只做 `Normalize`，不做 `Validate`。也就是说，磁盘上已有的匿名 WebDAV 规则在升级后会**照旧继续提供服务**，直到你下一次保存任何配置。
- **写入时会被拒绝**：之后任何一次配置保存（改规则、开关模块、改设置、计划任务改配置……）只要配置里还带着匿名 WebDAV 规则，就会失败并返回上面的错误信息，改动不会落盘。
- 因此这条校验挡的是「新的/被改动的配置」，**不是运行时的兜底**。如果你现在的规则是匿名 WebDAV，请主动去加认证，不要等它报错。

### 迁移步骤（3 步）

1. 打开「Web 服务」页，编辑目标 webdav 规则；
2. 二选一（也可都配）：
   - **BasicAuth**：勾选「启用 Basic 认证」，至少添加一个用户名 + 密码（保存时会做 argon2id 哈希）；
   - **IP 白名单**：把「访问控制」模式设为 `allow`，在 IP 列表里填允许的网段，例如 `192.168.1.0/24`、`10.0.0.0/8`、`100.64.0.0/10`（Tailscale）、`::1`、`127.0.0.1`；
3. 保存。若保存成功但你还想确认「真的挡住了」，用手机流量 / 外网主机访问该规则的地址，应当看到 401（BasicAuth）或 403（白名单）。

### 常见坑

| 现象 | 原因 |
| --- | --- |
| 配了白名单仍报错 | 模式写成了 `deny`；deny 不是白名单，必须选 `allow` |
| 勾了 BasicAuth 仍报错 | `enable` 没勾上，或者用户列表是空的 |
| 保存成功但外网仍能访问 | 白名单里填了过宽的网段（如 `0.0.0.0/0`、`::/0`），等于没限制 |
| 反代到 WebDAV，但规则认证没生效 | 认证配在**被反代的规则**上没用——要配在**对外那条规则**上 |
| 只想临时关掉这个站点 | 直接删除该规则，或给它配 `allow + 127.0.0.1`；校验只看声明，不看你是否真会访问 |

---

## 9. 附：一句话版本

> 管理面进隧道（或反代 + TLS + BasicAuth + 白名单 + adminProtect）；只开必要路由；WebDAV 必须认证；端口转发配 ACL 与并发上限；反代配速率与体积上限；WAF 先 LogOnly 再 block；证书先 staging 再正式；上线后按 P0 → P1 → P2 逐条验证，**没验证过的就当它不存在**。
