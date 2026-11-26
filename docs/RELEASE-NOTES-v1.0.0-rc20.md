# nunt v1.0.0-rc20

第二十个候选版本（rc19 未发布，本次直接 rc20）：WAF 拦截不再重复计数，访问日志
附带客户端地理位置。

## WAF 与 web 记录合并

- 一个被 WAF 拦截的请求此前会写两条访问日志（`source=web` 与 `source=waf`），
  「匹配记录」「失败请求」会把同一次请求算两次；
- 现在每个 web 请求共享一份请求元数据，WAF 把第一条判定写入其中，
  web 记录直接带上 `wafAction` / `wafRuleId` / `message`，只落一条；
- 只有管理后台自身的 WAF 拦截没有 web 记录，才继续单独写 `source=waf`；
- 日志页在状态下方显示 `WAF deny #930100` 这类判定，悬停可看规则消息。

## 客户端地理位置

- web、端口转发、管理后台 WAF 的访问记录都会用地址库解析客户端 IP；
- 新增 `country` / `province` / `city` 三列，已有数据库启动时自动补列；
- 日志页「客户端」下方显示（如「中国 · 江苏省 · 南京市」）；
- CSV 导出新增国家、省份、城市与 WAF 动作列。

## 升级说明

- 现有 `access.db` 会自动 `ALTER TABLE` 补列，无需手动迁移；
- 需要先在「IP 地址库」上传 v4/v6 库，地理位置才有值；私有/保留地址保持为空；
- 地址库解析在日志写入后进行，未加载地址库时不影响请求与日志写入。

## 验证

- 实测路径穿越攻击：`403`、`wafAction=deny`、`wafRuleId=930100`，`source=waf` 记录数为 0；
- 官方地址库 + 模拟公网 IP：`114.114.114.114` 记录为 中国 / 江苏省 / 南京市；
- 现有 rc18 数据库升级后自动补列并正常写入；
- 全量 `go vet` / `go test ./...`、前端构建与 11 条路由冒烟通过。

## 镜像与校验

```sh
docker load < nunt-v1.0.0-rc20-amd64.tar.gz
NUNT_IMAGE=nunt:v1.0.0-rc20 docker compose up -d
```

四个归档（amd64 / arm64 / armv7 / oci）的校验和都在 `SHA256SUMS` 里。
