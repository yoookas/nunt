# 部署与运维

## 1. 运行方式

| 方式 | 适用场景 | 命令 |
| --- | --- | --- |
| Docker Compose（host 网络） | Linux 主机、软路由、NAS；需要端口转发 / IPv6 / 80、443 | `docker compose up -d --build` |
| Docker Compose（桥接网络） | Docker Desktop（macOS / Windows） | `docker compose -f docker-compose.bridge.yml up -d --build` |
| Release 镜像归档 | 不能联网构建、需要固定版本 | `docker load < nunt-v1.0.0-amd64.tar.gz` |
| 直接运行二进制 | 路由器 / 小主机 | `./nunt -d /etc/nunt` |

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
| 16601 | 管理后台 | 建议只在内网开放，必要时配 `system.adminAllowIps` |
| 80 / 443 | Web 服务 | 由 Web 服务规则里的监听地址决定，可改成任意端口 |
| 自定义 | 端口转发 | 规则里的源地址 |

容器内以非 root（uid 1000）运行，镜像里已经给二进制设置了 `cap_net_bind_service`，因此可以直接绑定 80/443。

## 3. 数据与备份

所有状态都在数据目录里（compose 中映射为 `./data`）：

- `config.json`：全部配置，写入时保留 `config.json.bak`；
- `secret.key`：加密凭据用的密钥，**丢失后已加密的密码/令牌无法恢复**；
- `certs/`、`acme/`：证书与 ACME 账号；
- `shares/`：文件分享记录；
- `logs/`：运行日志。

备份：直接打包整个数据目录即可（包含密钥）。
恢复：把数据目录放回原位并重启；配置也可以在「设置 → 配置导入/导出」里做（导出会自动脱敏，导入时掩码字段保持原值）。

## 4. 证书

1. 在「证书」页新建任务，填写域名（可多个）、密钥类型、挑战方式：
   - **http-01**：需要外部能访问 80 端口，且该域名解析到本机；
   - **dns-01**：需要选择 DNS 服务商并填写凭据（与 DDNS 共用同一批服务商），支持泛域名 `*.example.com`；
   - **tls-alpn-01**：443 端口必须空闲。
2. 签发成功后证书自动入库，Web 服务规则把 TLS 设为 `auto` 即可使用（按 SNI 热加载，无需重启）。
3. 到期前 `renewDays`（默认 30 天）自动续期。

> http-01 会临时占用 80 端口：如果 Web 服务已经监听了 80，请改用 dns-01 或 tls-alpn-01。

## 5. 反向代理与 HTTPS 之外的场景

- 已经有 Caddy/Nginx 在最前面？把 Web 服务规则监听在高端口（如 `127.0.0.1:8080`），TLS 设为 off，由外层反代终止 TLS。
- 需要访问内网服务：规则类型选「反向代理」，上游填 `http://192.168.1.10:5000`；同一条规则可以有多个上游做轮询。
- 需要暴露无认证的内网服务：开启 BasicAuth 或设置 IP 白名单（白名单模式更安全）。

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动日志里没有密码 | 只有首次创建配置时才会打印；忘记密码可在宿主机上删除 `config.json` 里的对应用户条目，或直接用备份恢复 |
| 端口转发不生效 | 检查源地址是否被占用、防火墙是否放行；桥接模式下必须把端口映射出来（推荐 host 网络） |
| DDNS 一直失败 | 先用「测试」按钮验证凭据；注意部分服务商需要 token 具备 DNS 编辑权限 |
| ACME http-01 失败 | 80 端口被占用或域名未解析到本机；改用 dns-01 |
| WAF 误拦正常请求 | 切到「仅检测」模式定位命中规则，把对应规则 ID 加入禁用列表，或降低 PL 等级 |
| 容器里看不到真实客户端 IP | 使用 host 网络；若前面还有一层代理，打开「信任代理」 |

## 7. 升级

```bash
# 源码方式
git pull && docker compose up -d --build

# 镜像方式
docker load < nunt-v1.0.1-amd64.tar.gz
NUNT_IMAGE=nunt:v1.0.1 docker compose up -d
```

配置格式带版本号（`version` 字段），升级时会自动补齐新增字段与默认值；跨大版本升级前建议备份数据目录。
