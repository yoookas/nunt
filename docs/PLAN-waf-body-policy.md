# 实施清单：请求体检查策略（A + C + E 收敛版）

> 状态：待开工。范围已按"用约 30% 的核心代码拿到约 80% 的安全收益"收敛，
> 并为将来的 per-message 检查（D）、ext_proc 外呼、描述符/契约校验留出接口。

## 1. 范围

### 做（A + C + E）

- **A 缺口由部署声明，不由攻击者决定**
  - 每条 Web 规则显式声明请求体策略；缺省继承全局默认值。
  - 默认策略为 full（fail-closed）：形态上无法完整检查的请求（无 Content-Length、
    非声明过的流式类型）在强制模式下直接拒绝，并给出可操作的错误文案。
  - 提供 observe（观察）模式：只记录"本应拒绝"，不真的拒绝，用于上线前扫出漏声明的路由。
- **C 原子性按协议形态收窄**
  - 首消息 + 立即 EOF 判定为 unary/server-streaming：整请求在联系上游之前完成判定。
  - 路由可声明 grpc-unary 强制：若出现第二帧则拒绝（防止把 unary 路由伪装成流式来降级）。
  - bidi 明确声明为 grpc-stream：只做首消息检查 + 帧校验，不再假装拥有请求级原子性。
- **E 缺口可见**
  - 每次请求落一个 bodyState（full / peeked / skipped / grpc-unary / grpc-stream / grpc-server-first / frame-error）。
  - 指标 + 告警：非 full 占比、wouldReject 计数超阈值时通过 notify 模块发通知。

### 不做（明确延后，接口已预留）

| 延后项 | 预留的接缝 |
| --- | --- |
| D 逐消息 CRS 检查 + 跨消息累计评分 | BodyInspector 接口 + grpcFrameScanner 的 MessageSink 槽位 |
| B 磁盘溢写式全量缓冲 | full 策略的读取器可替换（Spooler 接口） |
| 外部检查（Envoy ext_proc / 独立鉴权服务） | BodyInspector 的远程实现 |
| 描述符/契约（.proto、OpenAPI）校验 | PolicyResolver 接口，可按 /pkg.Svc/Method 细化 |
| WebSocket 逐帧检查 | 与 grpcFrameScanner 同构的 WsFrameScanner（另立需求） |
| HTTP/3 | 不在本清单内 |

## 2. 配置面（刻意只有 4 项 + 每规则 1 项）

全局 model.WAFConfig：

    EnforcementMode   string  // observe | enforce       默认 observe（上线观察期）
    DefaultBodyPolicy string  // full | peek | skip | grpc 默认 full
    PeekBytes         int     // 默认 65536
    PeekTimeoutMS     int     // 默认 250

每规则 model.WebRule：

    BodyPolicy string  // "" 继承全局；full | peek | skip | grpc-unary | grpc-stream

约束：配置校验拒绝未知枚举；Normalize 补齐默认值；版本号不变（靠 Normalize 回填）。

## 3. 策略决策表（每次请求执行一次）

| 判定顺序 | 条件 | 策略 | 行为 |
| --- | --- | --- | --- |
| 1 | 规则/全局声明 skip | skip | 只查 URI/headers，body 原样透传；计 skipped:declared |
| 2 | 规则/全局声明 peek | peek | 读满 PeekBytes 或空闲 PeekTimeoutMS，检查已到部分，其余透传 |
| 3 | Content-Type 为 application/grpc* | grpc-unary 或 grpc-stream | 见第 4 节；默认按 grpc-unary 处理，若检测到第二帧则按声明决定拒绝或降级 |
| 4 | Content-Length 已知且 <= BodyLimitKB | full | 全量检查后转发（今天的行为） |
| 5 | Content-Length 未知且策略为 full | 拒绝（enforce）／记录 wouldReject（observe） | 411 Length Required + 明确文案，或在 gRPC 场景返回 grpc-status |

说明：攻击者只能通过"改变请求形态"落到第 5 行，而第 5 行在 enforce 下是拒绝，
因此不存在"用 chunked 自动降级为部分检查"的路径。

## 4. gRPC 路径（C 的核心）

组件：grpcFrameScanner（io.ReadCloser 包装，pull 驱动，只缓冲一条消息）。

流程：

1. 在调用下游之前，尝试读第一条消息（5 字节头 + 声明长度），受 PeekTimeoutMS 约束。
2. 读满后立刻探测是否 EOF：
   - EOF 到达：判定 unary / server-streaming，**整套请求体已完整**，
     用现有引擎做请求级判定；违规则直接返回（上游零请求，gRPC 场景返回 grpc-status）。
   - 未 EOF：判定为流式。首消息仍然先判定（能挡掉绝大多数"第一发就是攻击"的情况），
     通过后把首消息与 scanner 一起交给下游；后续帧只做帧校验，bodyState=grpc-stream。
   - 超时（服务端先说话的流）：立即放行，bodyState=grpc-server-first，计数并在指标中可见。
3. 帧校验（始终生效，独立于 CRS）：compressed flag 只能是 0/1；长度 <= MaxMessageBytes（默认 4MiB）；
   截断流报错；声明 grpc-unary 的路由出现第二帧则按模式拒绝/记录。

错误语义（三条路径分开）：

| 时机 | 处理 | 客户端看到 |
| --- | --- | --- |
| 首消息违规，未联系上游 | 中间件直接写响应 | gRPC：HTTP 200 + grpc-status 7 + grpc-message；非 gRPC：403 |
| 帧层违规（畸形/超长/截断） | 哨兵错误经 body reader 返回，proxy 的 ErrorHandler 识别后写响应 | grpc-status 8（RESOURCE_EXHAUSTED） |
| 声明 unary 却出现第二帧 | 同首消息路径 | grpc-status 7/13 + 说明 |

## 5. 观察模式与切换流程

1. 默认 EnforcementMode=observe：所有"本应拒绝"的请求照常放行，但落一条 wouldReject 记录
   （规则、路径、原因、客户端、本应返回的状态码），环形缓冲 500 条 + 计数。
2. WAF 页展示：未声明策略的路由列表 + wouldReject 样例表 + 非 full 覆盖率卡片。
3. 运维补齐路由声明后，在 UI 上一键切到 enforce；建议同时打开 notify 告警（非 full 占比阈值）。
4. 代码路径完全一致，enforce 只改变响应，不改变判定逻辑——两者的差异必须有测试覆盖。

## 6. 要写的代码（按顺序）

| 步 | 内容 | 文件 | 规模 |
| --- | --- | --- | --- |
| 1 | 模型/配置/校验/默认值 | internal/model/model.go, internal/config/validate.go | ~110 |
| 2 | 策略解析 + full/peek/skip 三条路径 + observe/enforce | internal/modules/waf/policy.go（新）, waf.go | ~220 |
| 3 | grpcFrameScanner（含 unary 探测与帧校验） | internal/modules/waf/grpc.go（新） | ~180 |
| 4 | 首消息判定 + 中止语义 + proxy ErrorHandler 映射 | waf.go, internal/modules/web/proxy.go | ~100 |
| 5 | 指标、wouldReject 环形缓冲、notify 告警 | internal/modules/waf/{metrics.go,api.go} | ~110 |
| 6 | 测试（见第 7 节） | internal/modules/waf/*_test.go, internal/modules/web/http2_test.go | ~350 |
| 7 | 前端（WAF 页策略面板 + 规则表单策略下拉与 WAF 开关）与文档 | internal/webui/assets/pages/{waf.js,web.js}, docs/*, README.md | ~220 |

合计约 1200-1400 行（含测试与前端）。

## 7. 验收用例

| # | 用例 | 断言 |
| --- | --- | --- |
| T1 | unary gRPC 消息内含攻击 | 被拦，上游零请求，返回 grpc-status |
| T2 | 声明 grpc-unary 却发两帧 | enforce 下拒绝；observe 下放行且落入 wouldReject |
| T3 | bidi：首消息干净、第二帧含攻击 | 首消息放行；bodyState=grpc-stream 且被计数（明确不做二级检查） |
| T4 | bidi：首消息即攻击 | 上游零请求即被拦 |
| T5 | 服务端先说话的流 | PeekTimeoutMS 量级内返回，bodyState=grpc-server-first |
| T6 | chunked 普通请求 + full 策略 | enforce 下 411 + 文案；observe 下放行并记录 |
| T7 | 声明 peek 的路由 | 前 PeekBytes 被检查，其余流式透传，bodyState=peeked |
| T8 | 畸形帧 / 超长消息 / 截断流 | 被拒且不 panic，返回 RESOURCE_EXHAUSTED |
| T9 | 回归：现有 web 27 例 + waf 27 例 | 全绿（含 WebSocket 隧道、h2c、gRPC over TLS） |
| T10 | h2c 与 TLS-h2 各跑 T1/T3 | 行为一致 |

## 8. 完成标准

1. gofmt / go vet ./... / go test ./... -count=1 全绿，T1-T10 全过。
2. 任何策略分支都不存在"等待客户端把 body 发完"的路径（代码审查 + T4/T5 覆盖）。
3. WAF 页能看到：bodyState 分布、未声明策略的路由、wouldReject 样例、一键切换强制模式。
4. README / docs/DEPLOY.md / docs/CONTRACT.md 三处与新默认值一致，并明确写清
   "gRPC 流式路由只做首消息检查 + 帧校验"这一能力边界。
5. 交叉编译 linux/amd64、arm64、armv7、386 与 windows/amd64 全通过。

## 9. 将来接 D / ext_proc / 描述符时的接缝

    // BodyInspector 由 per-message CRS（D）、ext_proc 外呼或描述符校验实现。
    type BodyInspector interface {
        Inspect(ctx context.Context, meta RequestMeta, msg []byte, index int) (Verdict, error)
    }

    // Spooler 由磁盘溢写实现（B）。
    type Spooler interface {
        NewReader(r io.Reader, limit int64) (io.ReadCloser, error)
    }

    // PolicyResolver 允许将来按 /pkg.Svc/Method 或 schema 细化策略。
    type PolicyResolver interface {
        Resolve(ruleName, method, contentType string, contentLength int64) (Policy, error)
    }

本清单只需保证：gRPC 帧解析、首消息判定、错误语义三处都走接口调用，
不把"只检查首消息"的假设写死在流程里。

## 10. 待确认（不给就用括号内默认）

1. EnforcementMode 初始值：observe（默认）还是 enforce？
2. DefaultBodyPolicy：full（默认，fail-closed）还是 peek（对现状最友好）？
3. gRPC 路由未声明时的默认策略：grpc-unary（默认）还是 skip？
4. observe 模式下 wouldReject 是否立即发通知：默认否（只在切换前提示）。
