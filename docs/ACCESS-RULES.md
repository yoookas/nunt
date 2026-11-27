# 访问控制规则（有序列表）

> 本文是 Web 路由、监听器、端口转发共享的访问控制规格。**旧的 `mode=allow|deny` + `ips` + `geo`
> 模型已废弃**，配置版本将从 1 升到 2。

## 1. 模型

一条规则由两个**相互独立**的有序列表组成，各自以一条固定兜底收尾：

```go
type AccessEntry struct {
    Action string `json:"action"` // allow | deny
    Kind   string `json:"kind"`   // ip | geo（IP 列表）/ ua（UA 列表）
    Value  string `json:"value"`
}

type AccessList struct {
    Entries []AccessEntry `json:"entries,omitempty"`
    Rest    string        `json:"rest,omitempty"` // allow | deny：列表末尾的“其余”
}

type Access struct {
    Mode string     `json:"mode"` // off | rules | inherit
    IP   AccessList `json:"ip"`   // IP 段与地区，按顺序匹配
    UA   AccessList `json:"ua"`   // 客户端标识，按顺序匹配
}
```

- `Mode=off` 不做任何过滤（列表保留但不生效）；`Mode=inherit` 整体采用监听器的规则；
- 两个列表之间是 **AND**：IP 列表放行后，UA 列表还要放行；
- 每个列表内 **从上到下匹配，第一条命中的生效**，都不命中则用该列表的 `Rest`；
- 列表上限 512 条；`Kind` 缺省时按值推断（可解析为 CIDR → ip，否则 geo）。

## 2. 判定

```
Allowed(ip, ua):
  if Mode != rules: return true, "off"

  // 1) IP / 地区列表
  record = 惰性加载（只在遇到 geo 条目时查库，且只查一次）
  for e in IP.Entries:
      ip   → e.CIDR.Contains(ip)        ? return 结论, "allow|deny:ip:"+value
      geo  → 查库失败 ? return false, "geo-unavailable"      // fail-closed
           → 命中    ? return 结论, "allow|deny:geo:"+value
  未命中 → IP.Rest 决定，reason 记 "rest:"+Rest

  // 2) UA 列表（大小写不敏感的子串匹配，与旧行为一致）
  for e in UA.Entries:
      命中 ? return 结论, "allow|deny:ua:"+value
  未命中 → UA.Rest 决定，reason 记 "ua-rest:"+Rest

  return true, "pass"
```

要点：

| 情况 | 结果 |
|---|---|
| 同一 IP 同时命中白、黑 | **先出现的那条赢** |
| 地区库缺失/报错，且流程走到 geo 条目 | 拒绝（fail-closed，与今天一致） |
| 地区库缺失，但前面的 IP 条目已命中 | 按该条目判定，**完全不查库** |
| 内网/回环 IP 遇到 geo 条目 | 库中无数据 → 不匹配，继续往下 |
| 列表为空 | 只用 `Rest` |
| `Mode=off` | 一律放行 |

## 3. 配置兼容

**不写迁移代码。** 旧字段（`ips`/`geo`/`uaMode`/`uas` 与 `mode=allow|deny`）不再被识别：

- `config.CurrentVersion` 升到 **2**；
- 加载到 v1 配置时，启动日志输出明确告警：旧的访问控制规则已移除，请重新配置；
- 若规则原本是白名单（`mode=allow`），升级后等价于 `mode=off`，即**放行所有人**——这是本规格
  唯一的 fail-open 行为，所以必须有上面那条告警。

## 4. 校验

- `action ∈ {allow,deny}`、`kind ∈ {ip,geo}`（IP 列表）/ `ua`（UA 列表）、`value` 非空；
- `kind=ip` 必须能被 `netutil.ParseIPList` 解析，报错指出第几条；
- `kind=geo` 沿用现有规则（无 `|`、≤32 字符、无控制字符），存在 geo 条目时必须有地址库；
- `Rest` 必须是 `allow` 或 `deny`（缺省按 `deny` 归一化，保存时要求显式选择）；
- `Mode=inherit` 时清空两个列表。

## 5. 界面

```
访问控制
  模式   ( 关闭 )  ( 自定义规则 )  ( 继承监听器 )

  IP 与地区（从上到下匹配，第一条命中生效）
  ⠿ 1  [允许 ▾] [IP 段 ▾] [10.0.0.0/8    ] ✕
  ⠿ 2  [拒绝 ▾] [IP 段 ▾] [10.0.0.66/32  ] ✕
  ⠿ 3  [拒绝 ▾] [地区  ▾] [中国           ] ✕
  ── 其余流量  [拒绝 ▾] ──            ← 固定最后一行，不可拖动/删除
  ＋ 添加规则（支持粘贴多行，一行一条）

  客户端标识（UA）                                  [折叠]
  ⠿ 1  [允许 ▾] [curl          ] ✕
  ── 其余流量  [通过 ▾] ──
```

- “其余”这一行**在界面上是一条行，存储在 `Rest` 字段**：无需维护“有且仅有一条、必须在最后”的
  不变量，也不存在把兜底拖到中间的非法状态；
- 首次向空列表添加条目且用户未动过兜底时，按该条目的方向自动设置 `Rest`（加白名单 → 其余拦截，
  加黑名单 → 其余通过）；之后不再自动改；
- 规则列表行显示摘要：`规则 3 条 · 其余拦截`；`inherit` 显示 `继承监听器：3 条 · 其余拦截`；
- 两个列表都为空且 `Rest=allow` 等价于不过滤，界面提示可关闭。

## 6. 端口转发

端口转发复用同一个 `Access`，但有两处本质差异：

- **没有 HTTP 请求，就没有 User-Agent**：转发表单不显示 UA 编辑器，保存时清空 `ua` 列表。
  `Filter.Allowed(ip, "")` 在 UA 列表为空且 `rest=allow` 时直接通过，所以不会误伤；但**必须保证
  转发的规则里不可能出现 UA 条目**（API 层清空），否则一条从 Web 复制过来的 UA 规则会静默阻断
  全部连接。
- **规则变更靠指纹判断是否重启代理**，所以指纹必须覆盖新结构：
  - `forward.go` 的 `fingerprint()` 把访问规则纳入比较，决定监听器是否重建；
  - `logs.go` 的 `accessCache` 用指纹做缓存 key。
  - 新指纹要包含 `entries`（**顺序敏感，序列化时不能排序**）、每条的动作/类型/值、`rest`、`ua`。
    漏掉任何一项都会导致"改完规则不生效 / 日志仍按旧规则解释"，这是本次改动最容易漏的回归点。

转发侧的改动清单：

| 位置 | 改动 |
|---|---|
| `forward/listener.go:411` / `:712` | TCP 新连接、UDP 会话的准入判定，调用新的 `Allowed(ip, "")` |
| `forward/logs.go:217` `allow()` | 拒绝日志的 `reason` 用新词汇，去掉 `mode` 字段 |
| `forward/logs.go:186` `loadAccess()` | 缓存 key 换成新指纹 |
| `forward/forward.go:513` `fingerprint()` | 纳入新访问规则，保证修改后重建代理 |
| `forward/api.go:352-380` | 删掉手写的 mode 校验，改用 `config` 里的共享归一化/校验，避免 Web 与转发两套规则漂移 |
| `frontend/pages/forward/RuleForm.tsx`、`types.ts` | 复用同一个 `AccessEditor`，传 `allowUA={false}` |
| 列表行标签 | 与 Web 一致的摘要（`规则 3 条 · 其余拦截`） |

## 7. 实现顺序

1. `internal/model`：`AccessEntry` / `AccessList` / `Access`，删除旧字段；
2. `internal/ipfilter`：按顺序匹配重写，`Allowed(ip, ua) (bool, string)`，geo 惰性查询；
   表驱动测试覆盖顺序、地区缺失、默认值、UA 组合；
3. `internal/config`：共享的归一化与校验、版本升到 2、加载 v1 时告警（范围涵盖 Web 与转发规则）；
4. 接入 **Web**：`access.go` 里 UA 从 `netutil.UAAllowed` 移入 filter；
5. 接入 **端口转发**：准入判定、拒绝日志、`loadAccess` 缓存 key、`fingerprint()`、
   `api.go` 改用共享校验；补一个"改规则后代理必须重建"的测试；
6. 前端：一个共享的 `AccessEditor`（IP/地区列表 + 固底行 + 可选 UA 列表），三张表单接入；
   `AccessTag` 改为摘要；
7. 文档（README 功能表里的"源 IP 黑白名单"描述）与 release note。

验收标准：`go vet` / `go test ./...` / `-race`（受影响包）全绿；旧配置加载时日志有明确告警；
Web 与转发修改规则后立即生效（不重启进程）；Playwright 截图覆盖两种表单。
