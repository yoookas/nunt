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

## 6. 实现顺序

1. `internal/model`：`AccessEntry`/`AccessList`/`Access`；删除旧字段；
2. `internal/ipfilter`：按上述算法重写 `Filter`，`Allowed(ip, ua) (bool, string)`，测试覆盖顺序、
   地区缺失、默认值、UA 组合；
3. `internal/config`：归一化与校验、版本升到 2、加载旧版本时的告警；
4. 接入：`modules/web/access.go`（UA 从 `netutil.UAAllowed` 移入 filter）、`modules/forward`；
5. 前端：`web/RouteForm`、`web/ListenerForm`、`forward/RuleForm` 共用新的访问控制编辑器，
   `AccessTag` 改为摘要；
6. 文档与 release note。
