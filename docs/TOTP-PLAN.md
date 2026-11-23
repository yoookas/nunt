# TOTP 双因子：实施清单

> 状态：**计划中**，排在 RC 之后实施。
> 适用范围：单管理员部署（没有多用户/角色需求）。
> 本文是实现前的约定，动手时以本文为准；接口或字段有变化请先改本文。

---

## 1. 目标与非目标

**目标**

- 管理后台登录增加第二因子（TOTP，RFC 6238），密码泄露不再等于全盘沦陷；
- 启用页当场显示二维码（**前端本地生成**），也保留 Base32 种子手动输入；
- 一次性恢复码，解决「手机丢了」；
- 全流程不引入任何运行时外部请求，CSP 保持不变。

**非目标（本期明确不做）**

- WebAuthn / Passkey（需要 RP ID、浏览器 API 与额外的挑战存储，单独排期）；
- 多用户 MFA 策略、强制全员开启（只有一个人）；
- 短信 / 邮件验证码、第三方身份源（OIDC/LDAP）；
- 恢复码云端同步、TOTP 种子备份导出。

---

## 2. 现状与改动点

| 位置 | 现状 | 本期怎么用 |
| --- | --- | --- |
| [`internal/api/auth.go`](../internal/api/auth.go) `handleLogin` | 密码校验通过后**直接建会话** | 在此处插入「需要 TOTP」分支，不建会话 |
| [`internal/security/session.go`](../internal/security/session.go) | 内存会话表，`Create(userID, username, ip, ua, ttl)` | 第二段校验通过后照旧建会话 |
| [`internal/security/limiter.go`](../internal/security/limiter.go) | `Allow/Fail/Reset(key)`，指数退避 | TOTP 失败与密码失败共用同一套限流思路，key 加前缀 |
| [`internal/security/password.go`](../internal/security/password.go) | `HashPassword/VerifyPassword`、`RandomToken(n)`、`ConstantTimeEqual` | 恢复码哈希、challenge token |
| [`internal/secret/secret.go`](../internal/secret/secret.go) | `Box.Seal/Open(string)`、`Mask` | TOTP 种子加密落盘 |
| [`internal/model/model.go`](../internal/model/model.go) `User` | 只有密码哈希 | 增加 `TOTP` 子结构 |
| [`internal/api/system.go`](../internal/api/system.go) `maskConfigSecrets` | 导出配置时脱敏 DDNS/ACME 凭据 | 增加 TOTP 种子 |
| [`frontend/src/views/Login.tsx`](../frontend/src/views/Login.tsx) / `session.tsx` | 单步登录 | 增加第二段 |
| [`frontend/src/views/Settings.tsx`](../frontend/src/views/Settings.tsx) | 系统/日志/用户/Token/会话/备份 | 新增「安全」面板 |
| [`internal/rest/mux.go`](../internal/rest/mux.go) | CSP：`script-src 'self'`、`img-src 'self' data:` | **不改**，二维码走 canvas/SVG 或 `data:` 图片都可以 |

---

## 3. 数据模型

```go
// model.User 增加
type TOTP struct {
    Enabled    bool       `json:"enabled"`
    // Secret 是 Base32 种子的密文（secret.Box.Seal 的结果），永远不出现在 API 响应里。
    Secret     string     `json:"secret,omitempty"`
    // Codes 是恢复码的 SHA-256 十六进制串，一次性使用。
    Codes      []string   `json:"codes,omitempty"`
    EnrolledAt *time.Time `json:"enrolledAt,omitempty"`
    // LastStep 是最近一次成功使用的时间步，用来拒绝重放。
    LastStep   int64      `json:"lastStep,omitempty"`
}
```

约定：

- 迁移安全：老配置没有 `totp` 字段 → 零值 = 未启用，不需要版本号；
- `Normalize` 不写任何默认值（避免把「未启用」写成一堆空字段）；
- `Validate`：`Enabled=true` 且 `Secret` 为空 → 拒绝**保存**；
- **加载**时若遇到 `Enabled=true` 但种子无法解密/为空：记 error 日志、按未启用处理（避免管理员被永久锁在外面；此时该因子本来也无法验证）。这条要在发布说明里写明；
- 导出配置：`Secret` 与 `Codes` 一律置空或 `Mask`；导入时保留原值（与服务端其它凭据一致）。

---

## 4. 算法（零新依赖）

新增 `internal/security/totp.go`：

```go
// GenerateSecret 返回 20 字节随机种子的 Base32（无 padding，大写）。
func GenerateSecret() (string, error)
// Code 返回某个时间点的 6 位码。
func Code(secret string, t time.Time) (string, error)
// Verify 校验 code 并返回命中的时间步；容差 ±1 步。
func Verify(secret, code string, now time.Time) (step int64, ok bool)
// URI 生成 otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
func URI(issuer, account, secret string) string
```

规则：

- HMAC-SHA1、6 位、30 秒步长、T0=0（手机验证器默认值，不做可配置）；
- Base32 解码注意大小写与去 padding；
- 比较用 `crypto/subtle.ConstantTimeCompare`；
- `Verify` 的 `step` 交给调用方与 `LastStep` 比较：`step <= LastStep` 一律拒绝（重放/回退）；
- 测试用 RFC 6238 附录 B 的 SHA-1 向量（把 8 位截断成 6 位）＋自建边界用例（±30s 通过、±90s 拒绝、空码/非数字/长度错拒绝）。

---

## 5. HTTP 接口

所有写接口都走现有中间件（会话鉴权 + CSRF + 限流），不重复实现。

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/totp/setup` | 会话 | `{password}` | `{secret, uri, expiresAt}` |
| POST | `/api/v1/auth/totp/confirm` | 会话 | `{code}` | `{recoveryCodes: [...]}`（仅此一次） |
| POST | `/api/v1/auth/totp/disable` | 会话 | `{password, code}` | `{ok: true}` |
| POST | `/api/v1/auth/totp/recovery` | 会话 | `{password, code}` | `{recoveryCodes: [...]}` |
| POST | `/api/v1/auth/login/totp` | **无会话** | `{challenge, code}` | 与 `login` 相同的会话响应 |
| GET | `/api/v1/auth/session` | 会话 | — | 增加 `totpEnabled`、`recoveryCodesLeft` |
| POST | `/api/v1/auth/login` | 无会话 | 现有 | **增加** `totpRequired` + `challenge`（不建会话、不下发 cookie） |

细节：

- `setup` 要求再输一次密码（防「已登录但人离开」）；
- 待确认的种子只放**内存**（`map[userID]pending{secret, expires, attempts}`，TTL 5 分钟，进程重启即失效），不写 `config.json`；
- `confirm` 成功才把种子 `Seal` 后写入配置、生成 10 个恢复码、**撤销该用户的其它会话**（`security.SessionStore.DeleteUser` 已有）；
- `disable` 必须同时提供密码 + 当前 TOTP 或一枚未使用的恢复码；
- 错误码沿用现有风格：`invalid_credentials` / `invalid_code` / `challenge_expired` / `locked`；
- 响应里永远不回显种子；日志与审计里不出现种子和 `otpauth://` URI。

---

## 6. 登录两段式

```
POST /auth/login {username, password}
  密码错 → 401（限流计数，行为不变）
  密码对 + 未启用 TOTP → 建会话（行为不变，完全兼容老用户）
  密码对 + 已启用 TOTP → 200 {totpRequired: true, challenge}，不下发 cookie

POST /auth/login/totp {challenge, code}
  challenge 无效/过期/已用/绑定不匹配 → 401 challenge_expired
  限流未通过 → 429 locked
  码错 → 401 invalid_code（并计数）
  码对（含 LastStep 前进） → 建会话，返回与 login 相同结构
```

- challenge：`security.RandomToken(32)`，内存表 `token → {userID, ip, ua, expires, attempts}`，**一次性**，用掉即删；
- 绑定 IP + User-Agent，与现有会话绑定策略保持一致（`sessionBindIp` 打开时更严格）；
- 失败计数 key：`totp|<user>|<ip>`，复用 `security.Limiter`，阈值与登录一致（`LoginMaxFail`）；
- 恢复码走同一接口：`/auth/login/totp` 的 `code` 允许 `xxxxx-xxxxx` 形式，命中则消费并删除。

---

## 7. 恢复码

- 数量 10，格式 `xxxxx-xxxxx`（10 个字符，32 符号集 ≈ 50 bit 熵），字符集去掉易混淆的 `0/O/1/I`；
- 存储：SHA-256（十六进制）——高速、无盐，但 50 bit 的随机串离线爆破不现实，在线尝试又受「5 次即锁定」限制；比较用常量时间；
- 展示：只在 `confirm` / `recovery` 的响应里出现一次，前端提供复制与下载 `.txt`；
- 消费：登录成功即从 `Codes` 删除并写回配置；
- 重生成：需要密码 + 当前因子，成功即作废旧码；
- 设置页只显示「剩余 N 个」，永不回显内容。

---

## 8. 前端

**二维码（本地生成，运行时不联网）**

- 选一个**零运行时依赖**的小编码库（候选：`qrcode-generator`、`uqr`），锁版本、进 `package-lock.json`；
- 随设置页 chunk 懒加载，渲染到 `<canvas>` 或内联 `<svg>`；用 `data:` 图片也可以（CSP 的 `img-src` 已允许 `data:`），但 canvas/SVG 更省事；
- 二维码内容只来自后端返回的 `otpauth://` URI；
- **CSP 一个字都不改**；构建产物提交后 CI 会重跑构建并比对，保证不引入外部资源；
- 种子与 URI 只存在组件 state：不写 `localStorage/sessionStorage`、不进 URL、不 `console.log`；离开页面即清。

**登录页**

- 第一步不变；返回 `totpRequired` 时切到第二步：6 位数字输入（自动聚焦、满 6 位自动提交）、「改用恢复码」切换、返回上一步；
- 错误提示区分「验证码错误」「挑战过期，请重新登录」「尝试过多」。

**设置页新增「安全」面板**

- 状态：已启用 / 未启用、启用时间、剩余恢复码数量；
- 启用流程：输密码 → 显示二维码 + 种子 + 复制 → 输入 6 位码确认 → 一次性展示恢复码；
- 关闭 / 重生成恢复码：密码 + 当前因子；
- 明确提示：「二维码与种子仅在本页显示一次，请立即添加到验证器」。

---

## 9. 安全验收项

- [ ] 种子落盘必须是 `secret.Box` 密文；`grep` 配置文件确认无明文 Base32；
- [ ] 任何 API 响应、日志、审计、导出配置里都不出现种子或 `otpauth://`；
- [ ] 同一时间步第二次提交被拒绝（重放）；
- [ ] 时钟偏差 ±30 秒可用、±90 秒拒绝；
- [ ] 恢复码一次性：用过一次后同一码再登录失败，剩余数量减一；
- [ ] 启用后其它在线会话立即失效；关闭后同样失效；
- [ ] 连续错误触发锁定，锁定期间正确码也拒绝（防爆破）；
- [ ] `Enabled=true` 但种子缺失/无法解密时，不锁死管理员（降级为未启用 + error 日志）；
- [ ] CSP 与改动前逐字节一致；页面无任何外部域名请求；
- [ ] `internal/webui/assets` 中无外部 URL（构建产物 `grep -E 'https?://'` 只允许出现在注释/示例）。

---

## 10. 测试清单

**单元（`internal/security`）**：RFC 向量、±1 步容差、重放、非法输入、URI 拼接、恢复码格式/熵。

**API 集成（`internal/api`）**：
- 未启用时登录行为与现在完全一致（回归）；
- setup → confirm → 登录需要第二段 → 通过；
- 挑战过期、复用、绑定不符；
- 错误码限流；
- 恢复码登录一次即失效；
- 关闭需要双因子；
- 导出配置不含种子。

**前端**：`npm run build` + `npm run smoke`；手测脚本（见下）。

---

## 11. 手工验收脚本

1. 设置页启用：输密码 → 断网 → 二维码仍在（证明本地生成）→ 扫码 → 填码 → 拿到恢复码；
2. 退出登录 → 密码 → 第二步 → 验证器码 → 进入后台；
3. 用恢复码登录一次 → 再登一次失败 → 设置页显示剩余 9；
4. 改系统时间 ±30 秒 → 仍可登录；±2 分钟 → 拒绝；
5. 设备丢失场景：用恢复码登录 → 关闭 TOTP → 重新绑定；
6. 浏览器 Network：除本机请求外为零；DevTools 里搜不到种子被写入 storage。

---

## 12. 拆分与工作量

| # | 内容 | 估计 |
| --- | --- | --- |
| 1 | `internal/security/totp.go` + RFC 向量测试 | 0.5 天 |
| 2 | model / secret / 导出脱敏 / config 校验 | 0.3 天 |
| 3 | `setup/confirm/disable/recovery` 接口 + 内存 pending | 0.5 天 |
| 4 | 登录两段式 + challenge + 限流 + 重放 | 0.5 天 |
| 5 | 恢复码生成/校验/消费 | 0.3 天 |
| 6 | 前端登录第二步 + 设置「安全」面板 + 二维码 | 0.7 天 |
| 7 | API 集成测试、`-race`、文档与验收 | 0.5 天 |
| | **合计** | **约 3~3.5 天** |

建议按 PR 拆：①算法 → ②存储与接口 → ③登录流程 → ④前端 → ⑤文档/验收。每一步都能独立编译、独立测试，②③④ 不合入时前端功能不开放。

---

## 13. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 把自己锁在外面 | 确认前强制生成恢复码；禁用/重生成都要双因子；文档写清「设备丢失 + 恢复码」与「直接编辑 `config.json` 把 `totp.enabled` 改为 false」两条路 |
| 时钟漂移 | ±1 步容差；登录失败提示里带上「请检查服务器时间」 |
| 回滚代码 | 旧版本读到多出来的 `totp` 字段会忽略（JSON 不拒绝未知字段），已启用用户会变成单因子——**发布说明必须写明**；如需彻底回退，先关闭 TOTP 再降级 |
| 内存态重启丢失 | challenge 与 pending 都在内存，重启即失效，用户重新登录即可，可接受 |
| 二维码库供应链 | 锁版本 + 提交 lock 与构建产物 + CI 一致性检查；库只做本地编码，无网络能力 |

---

## 14. 完成定义（DoD）

- 第 9 节全部勾选；
- `go test ./...`、`go test -race ./...`、`go vet`、前端 `build` + `smoke` 全绿；
- README 增加一段「双因子」说明，`docs/DEPLOY.md` 增加「忘记验证器怎么办」；
- 本文档状态改为「已实现」，并补上实际接口字段与截图位置。
