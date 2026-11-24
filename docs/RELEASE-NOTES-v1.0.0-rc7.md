# nunt v1.0.0-rc7

第七个候选版本，两个针对实际使用中暴露的问题的修复。

## 修复

- **腾讯云 dns-01 仍失败：`LimitExceeded.RecordTtlLimit`**
  挑战记录为了快速过期用了 60 秒 TTL，而 DNSPod 免费套餐的 TTL 下限是 600 秒，
  低于下限会被 API 拒绝，导致整个签发流程停在「创建 TXT 记录」这一步。
  现在腾讯云 provider 会把写入的 TTL 抬到 600（创建与修改都走同一份载荷）；
  挑战记录在验证后本来就会删除，600 秒不会留下副作用。

- **「复制 JSON」在 HTTP 下报「复制失败」**
  复制用的是 `navigator.clipboard`，它只在安全上下文（HTTPS 或 localhost）存在。
  内网用 `http://` + 局域网地址访问时这个 API 直接不可用，于是只能提示手动选择。
  现在统一为一条实现：临时 textarea + `execCommand('copy')`，同步执行在点击处理器里
  （Safari 也要求如此），iOS 会先聚焦再选中。日志详情、TOTP 恢复码、配置导出
  三个复制按钮共用同一个函数，HTTP / HTTPS 行为一致，没有上下文分支。

## 说明

- 没有配置格式或数据变化，升级只需换镜像；
- 重启后需要重新登录一次（会话保存在内存）；
- 浏览器强刷一次拿到新前端。

## 仍未验证（同前）

- 真实 Let's Encrypt 签发与自动续期：腾讯云的记录创建路径已按文档修正两次
  （`SubDomain` 参数、TTL 下限），但仍未用真实账号跑通完整签发；
- 其他 DNS 提供商的真实账号联调；
- 真机 `docker compose` 长期运行、浏览器逐页 E2E、24 小时长跑与压测。

## 镜像与校验

```sh
docker load < nunt-v1.0.0-rc7-amd64.tar.gz
NUNT_IMAGE=nunt:v1.0.0-rc7 docker compose up -d
```

四个归档（amd64 / arm64 / armv7 / oci）的校验和都在 `SHA256SUMS` 里。
