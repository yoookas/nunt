# nunt 开发契约（所有并行开发者必须遵守）

> 本文档是模块之间的接口约定。**只修改你负责目录下的文件**，不要动其他人的文件。
> 如果确实需要改动公共代码（`internal/model`、`internal/rest` 等），先在说明里写清楚，不要擅自修改。

## 1. 环境与构建

Go 1.26（`go.mod` 声明 `go 1.26.0`，工具链由 `toolchain go1.26.9` 固定；
`GOTOOLCHAIN=auto` 会从 GOPROXY 自动拉取 go1.26.9）。模块缓存必须放在工作区内，**每条 pwsh 命令都要带这个前缀**：

```powershell
$env:GOMODCACHE='D:\Desktop\nunt\.gocache\mod';$env:GOCACHE='D:\Desktop\nunt\.gocache\build';$env:GOPATH='D:\Desktop\nunt\.gocache\gopath';$env:GOFLAGS='-mod=mod';$env:GOTOOLCHAIN='auto';
Set-Location D:\Desktop\nunt; go build ./...
```

校验自己负责的包：`go build ./internal/modules/xxx/... ` 和 `go vet ./internal/modules/xxx/...`。
并行开发期间其他包可能暂时编译不过，**只需要保证自己负责的包编译通过**；最后统一由主开发者执行 `go build ./...`。

已批准依赖（不要引入其它第三方依赖）：
`golang.org/x/crypto`（argon2/acme）、`golang.org/x/net`（webdav、http2）、
`github.com/corazawaf/coraza/v3`、`github.com/corazawaf/coraza-coreruleset/v4`、`github.com/robfig/cron/v3`。
需要新依赖时先在结果里说明，不要直接 `go get`。

## 2. 代码风格

- Go 代码注释、标识符用英文；前端面向用户的文案用中文。
- 错误必须带上下文（`fmt.Errorf("doing x: %w", err)`），不要 panic，不要在库代码里 `os.Exit`。
- 共享状态用 `sync.Mutex/RWMutex` 保护；模块的 `Start/Stop/Reload` 必须幂等、可重复调用。
- 所有 goroutine 必须能在 `Stop(ctx)` 后退出，不允许泄漏。
- 每个网络监听都要设置超时（`http.Server{ReadHeaderTimeout: ...}`、`net.Dialer{Timeout: ...}`）。
- 安全红线：路径穿越、命令注入、任意文件读写、把用户输入直接拼进 shell/SQL 都是禁止的；
  访问用户提供的文件路径一律走 `internal/vfs`（基于 `os.Root`）。

## 3. 可直接使用的基础设施

| 包 | 用途 | 关键 API |
| --- | --- | --- |
| `internal/rest` | 路由与 JSON | `rest.Mux`（`Get/Post/Put/Delete`、`Group`）、`rest.OK/Fail/FailCode/Decode` |
| `internal/module` | 生命周期 | `Module` 接口、`Base`（`Init/SetRunning/SetDetail/SetError/SetStats/Status`）、`Deps`、`Reloader`、`APIProvider`、`CertProvider` |
| `internal/config` | 配置读写 | `Store.Snapshot() *model.Config`、`Store.Update(func(*model.Config) error) error`、`Store.Subscribe(func(*model.Config))` |
| `internal/model` | 持久化类型 | 所有规则结构体，JSON tag 为 camelCase |
| `internal/netutil` | 网络匹配 | `ParseIPList`、`IPAllowed`、`UAAllowed`、`ClientIP`、`HostOnly`、`MatchDomain`、`NormalizeListen`、`TargetAllowed` |
| `internal/secret` | 凭据加密 | `Box.Seal/Open/SealMap/OpenMap`、`Mask`（脱敏展示） |
| `internal/httpc` | 出站 HTTP | `httpc.New(timeout, insecure)`、`httpc.Do`、`httpc.GetJSON`、`httpc.PublicIP` |
| `internal/vfs` | 安全文件系统 | `FS` 接口、`OpenLocal(dir,label,readOnly)`、`Clean`、`Entry` |
| `internal/mounts` | 存储挂载 | `Manager.Get(id) (vfs.FS, model.Mount, error)`、`Manager.Local(root,label,ro)`、`Find/List/Test` |
| `internal/certs` | 证书仓库 | `Store.GetCertificate`、`Add`、`List`、`Delete`、`Has`、`TLSConfig()` |
| `internal/notify` | 通知 | `Service.Emit(event, title, message, fields)`，事件名见包内常量 |
| `internal/security` | 安全原语 | `HashPassword/VerifyPassword`、`RandomToken`、`Limiter`、`RateLimiter` |
| `internal/dnsprov` | DNS 提供商 | `Registry.New(id, creds)`、`Provider.Set/Delete`、`Default()` |
| `internal/httpc.PublicIP` | 获取公网 IP | `PublicIP(ctx, "4"|"6", extraURLs)` |

模块构造签名统一为 `func New(deps *module.Deps) *X`，`X` 内嵌 `module.Base`，
通过 `m.Init(deps, "<name>", "<Title>")` 初始化，并实现：

```go
Start(ctx context.Context) error   // 幂等
Stop(ctx context.Context) error    // 幂等
Status() module.Status             // 由 Base 提供，可覆盖补充 Stats
Reload(cfg *model.Config)          // 必须幂等、快速，不允许阻塞或再次写配置
RegisterAPI(mux *rest.Mux)         // 注册 /api/v1/<name>/... 路由
```

## 4. REST 约定

- 路径前缀 `/api/v1/<module>/`；列表接口返回数组或 `{"items":[...]}`。
- 写接口：`POST /xxx` 新建、`PUT /xxx/{id}` 更新、`DELETE /xxx/{id}` 删除、`POST /xxx/{id}/toggle` 开关。
- 请求体字段与 `internal/model` 的 JSON tag 一致；用 `rest.Decode` 解析。
- 鉴权、CSRF、限流、CORS 已由 `internal/api` 统一处理，模块里不要重复实现。
- 更新配置统一走 `deps.Cfg.Update(func(c *model.Config) error { ... })`；改动后自己再调用一次
  `m.Reload(deps.Cfg.Snapshot())` 保证立即生效（`Update` 也会通过 `Subscribe` 触发一次，重复调用必须无害）。
- 返回凭据时必须脱敏（`secret.Mask`）；保存时若字段值等于掩码（含 `********`）则沿用旧值，不要覆盖成掩码。
- 统计信息用 `Status().Stats`（`map[string]any`）暴露给概览页。

## 5. 参考实现（只读，禁止整段复制）

Lucky v1.10.8 源码（Go module 缓存里已下载好）：

    D:\Desktop\nunt\.gocache\mod\github.com\gdy666\lucky@v1.10.8

- `module/ddns/providers/*.go`：各家 DNS API 的调用方式（cloudflare、alidns、dnspod、godaddy、porkbun、huawei、callback 等）
- `module/reverseproxy`、`module/portforward`、`module/sslcertficate`：反代、端口转发、证书申请的实现思路
- `thirdlib/gdylib/*`：工具函数思路

参考它的**行为**即可，代码要按本项目风格重写，界面文案与 API 一律用本项目自己的设计。

## 6. 任务与负责人（一个目录只有一个负责人）

| 负责人 | 目录 | 内容 |
| --- | --- | --- |
| A | `internal/modules/web` | 监听器管理、Host/Path 路由、反向代理（WebSocket、负载均衡、路径重写）、重定向、静态托管（含目录列表/SPA）、访问控制、BasicAuth、TLS（自动证书/指定证书/HSTS）、访问日志缓冲。调用 `filebrowser.Service.Site`、`webdav.Service.Site`、`waf.WAF.Middleware` |
| B | `internal/modules/forward`、`internal/modules/task` | TCP/UDP 端口转发（连接计数、访问控制、日志）、cron 计划任务（模块开关、规则开关、HTTP 请求、webhook、shell 需配置显式开启） |
| C | `internal/modules/ddns`、`internal/dnsprov/*` | DDNS 规则调度、公网 IP 探测（网卡/URL/静态）、自定义回调、各家 DNS 提供商 |
| D | `internal/modules/acme` | ACME 账号与订单（`golang.org/x/crypto/acme`）、http-01 / dns-01、证书入库、续期循环 |
| E | `internal/modules/filebrowser`、`internal/modules/webdav`、`internal/mounts/webdav.go` | 文件管理站点（列表/上传/下载/删除/重命名/新建目录/分享链接）、WebDAV 服务端（基于 `golang.org/x/net/webdav` + vfs 适配器）、远程 WebDAV 挂载后端 |
| F | `internal/modules/waf` | Coraza v3 引擎、CRS 内置规则、自定义规则、按规则开关、拦截统计与日志、管理接口 |
| G/H | `internal/webui/assets` | 纯静态前端（无构建步骤） |

## 7. 前端契约（纯静态、零构建、Web Components）

### 7.1 技术栈与硬约束

- 组件库 **Shoelace 2.20.1**（MIT）vendor 在 `internal/webui/assets/vendor/shoelace/`，
  同步与校验：`pwsh -File scripts/sync-vendor.ps1` / `... -VerifyOnly`；
- 自研组件的编写层 **Lit 3.3.3**（MIT）vendor 在 `internal/webui/assets/vendor/lit/`，
  同步与校验：`pwsh -File scripts/sync-lit.ps1` / `... -VerifyOnly`。
  两棵 vendor 树都只包含用到的文件，都是「相对导入、没有裸模块说明符」的 ESM，浏览器直接当模块加载，
  **没有任何构建步骤**（npm 只用于 devDependencies 与这两个同步脚本；Go 构建与 Docker 镜像不需要 Node）。
- 通过 `//go:embed all:assets` 打进二进制。CSP 保持不变（`script-src 'self'`）：
  **不允许 CDN / 外部请求，不允许内联脚本与事件属性，不允许 import map**；
  图标与字体全部来自本地 vendor（`sl-icon` 的 base path 指向 `vendor/shoelace/`）。
- 所有自研组件都是 **light DOM**：`NuntElement.createRenderRoot()` 返回 `this`，
  全局样式与设计 token 直接生效；微调 Shoelace 控件用 `::part()` 与 `--sl-*` 变量，
  **不要**用 shadow DOM 把样式隔断。
- 主题：`<html>` 上挂 `sl-theme-dark` / `sl-theme-light`（`index.html` 默认 dark，`app.js` 切换），
  持久化在 `localStorage['nunt.theme']`，跨标签页用 `storage` 事件同步。
  nunt 的语义变量（`--bg/--bg-elev/--text/--brand/--ok/--warn/--err/...`）在 `style.css` 第 1 节里
  全部是 Shoelace token 的别名，浅色一套、深色一套 —— 页面里不要再写死颜色。
- `style.css` 分层：1 主题 token 映射、2 基础排版与工具类、3 外壳布局、4 kit 组件样式
  （含 12 个页面共用的容器类 `.card/.card-header/.card-body/.sub/.notice`）、5 登录页。
  阶段 3 已把原第 6 节「迁移期遗留层」（`.btn/.table/.field/.modal/.toast/...` 约 270 行、只服务老页面）
  **整节删除**；现在页面只用第 2 节的工具类（`.mono/.muted/.row/.spacer/.hidden` 等）
  与第 4 节的容器类，**不允许**再往 style.css 里加页面私有样式（写进页面、随 `mount` 的清理函数移除）。

### 7.2 目录

- `index.html`：外壳，只引 3 个样式（`vendor/shoelace/themes/light.css`、`dark.css`、`style.css`）与 `/app.js`；
- `app.js`：hash 路由、页面清单、动态 import、登录页、外壳（侧边栏/顶栏/窄屏 sl-drawer）、SSE、主题；
- `lib/api.js`：API 客户端（自动带 `X-CSRF-Token`）——**不要改**；
- `lib/kit.js`：共享组件层（表格/表单/反馈/对话框/状态块/容器类约定），页面一律用它。
  **它不注册任何 `sl-*` 组件**，也**不再**导出 `lib/ui.js` 的转发（原 `lib/ui.js` 已删除，
  `renderIcon/fmtBytes/fmtTime/fmtDuration/escapeHtml` 全部搬进 kit）；
- `lib/components/*.js`：**组件入口**（按需加载的落点，见 7.4 之后的一节）；
- `pages/<id>.js`：页面模块（顶部 import 自己需要的组件入口）。

### 7.3 页面模块契约（不变）

每个页面模块默认导出：

```js
export default {
  id: 'web',
  title: 'Web 服务',
  icon: '<svg viewBox="0 0 24 24" ...>...</svg>', // 24x24 stroke 图标
  async mount(root, ctx) {
    // root: 页面容器 HTMLElement；ctx: 见下
    // 返回可选的清理函数
  },
}
```

- `ctx` 提供：`ctx.api`（`get/post/put/del`，自动附带 `X-CSRF-Token`，失败抛出带中文 message 的错误）、
  `ctx.toast(msg, type)`、`ctx.confirm(msg)`、`ctx.state`（当前会话信息）、`ctx.navigate(id)`、
  `ctx.fmtBytes/ctx.fmtTime/ctx.escapeHtml`、`ctx.onSSE(handler)`。
- 需要的页面 id / 文件名：
  `dashboard`、`web`、`forward`、`ddns`、`acme`、`storage`、`files`、`waf`、`task`、`notify`、`logs`、`settings`（→ `pages/<id>.js`）。
- 前端调用的模块接口（必须按此实现，避免联调失败）：

```
GET    /api/v1/web/rules                 GET/POST/PUT/DELETE /api/v1/web/rules[/{id}]
POST   /api/v1/web/rules/{id}/toggle     GET  /api/v1/web/logs?rule=<id>&limit=
GET    /api/v1/forward/rules             POST/PUT/DELETE /api/v1/forward/rules[/{id}]
POST   /api/v1/forward/rules/{id}/toggle GET  /api/v1/forward/logs?rule=<id>
GET    /api/v1/ddns/rules                POST/PUT/DELETE /api/v1/ddns/rules[/{id}]
POST   /api/v1/ddns/rules/{id}/run       GET  /api/v1/ddns/providers
GET    /api/v1/ddns/status
GET    /api/v1/acme/jobs                 POST/PUT/DELETE /api/v1/acme/jobs[/{id}]
POST   /api/v1/acme/jobs/{id}/issue      GET  /api/v1/acme/certificates
DELETE /api/v1/acme/certificates/{id}    POST /api/v1/acme/certificates/upload
GET/PUT /api/v1/waf/config               GET  /api/v1/waf/rules
GET    /api/v1/waf/logs?limit=           POST /api/v1/waf/test
GET    /api/v1/task/items                POST/PUT/DELETE /api/v1/task/items[/{id}]
POST   /api/v1/task/items/{id}/run
GET    /api/v1/storage/mounts            POST/PUT/DELETE /api/v1/storage/mounts[/{id}]
POST   /api/v1/storage/mounts/test       GET  /api/v1/storage/mounts/{id}/list?path=
GET/PUT /api/v1/notify/webhooks          POST /api/v1/notify/webhooks/test
GET    /api/v1/system/info|stats|logs|interfaces|settings|config
PUT    /api/v1/system/settings|config    POST /api/v1/system/reload
GET    /api/v1/auth/session|users|tokens POST /api/v1/auth/login|logout|password|users|tokens
DELETE /api/v1/auth/users/{id}|tokens/{id}
GET    /api/v1/modules                   POST /api/v1/modules/{name}/start|stop|restart
GET    /api/v1/events                    (SSE，消息格式 {"type":"log|status|event","data":...})
```

### 7.4 共享组件层（lib/kit.js）

页面不要自己拼表格 / 表单 / 弹窗，统一用 kit（导出清单见文件末尾注释）：

| 用途 | 导出 | 说明 |
| --- | --- | --- |
| 数据表格 | `nunt-table` 元素 / `table(config)` / `applyTableConfig(node, config)` | 原生 table + 设计 token。列定义 `{key,title,width,align,sortable,sort(row),render(row,i),actions}`；内置排序（点表头）、空状态、加载态、错误卡＋重试、分页（给了 `onPage` 就出现）；`title` 省略时按「操作」渲染，避免 axe 的 `empty-table-header`；`actions: true` 的列右对齐、不换行、统一包在 `.nunt-actions` 里（不会再被裁切） |
| 表单 | `nunt-form` / `formGrid(fields)` | 字段定义与老的 `formGrid` 一致（text/password/number/url/email/textarea/select/switch/checkbox/tags/kv/custom，`wide` 跨列）；`read()/get()/set()/error(msg)/fieldError(name,msg)/toggle(name,show)`。标签交给 `sl-input/sl-select` 的 `label`，控件与标签天然关联（axe 的 `label`/`select-name` 不再报） |
| 多行标签输入 | `nunt-tags` | 值是字符串数组；回车/逗号/分号/换行都能加标签，可单独删除。**`label` 必须传**（formGrid 的 `type:'tags'` 会自动把字段 label 转交进来）：内层 `sl-input` 的 `<input>` 在阴影里，没有可见标签时 axe 会判 `label-title-only/serious`。用 formGrid 时不要再自己渲染外层标签（`ownsLabel` 已包含 tags） |
| 键值对编辑 | `nunt-kv` | 值是对象，用于自定义请求头之类 |
| 反馈 | `toast(msg, tone)` / `confirmDialog(msg, opts)` / `promptDialog(msg, def)` / `badge(text, tone)` | `tone` 取 `ok/warn/err/info/neutral`；toast 用 `<sl-alert toast>` 进 Shoelace 右上角堆栈，`confirmDialog` 用 `sl-dialog` |
| 空 / 加载 / 错误 | `emptyState()` / `loadingState()` / `errorCard(err, {onRetry})`（或 `nunt-empty` 等元素） | 错误文案走 `friendlyMessage()`：404 显示成人话，不把后端的 `404 page not found` 摊在界面上 |
| 对话框 | `openDialog({title, body, actions, wide, onClose, onMount})` | `actions = [{label, kind, onClick(dialogApi, button), close}]`；`dialogApi.setBusy(bool, button)` 做提交中的忙碌态 |
| 工具 | `versionText()` / `infoVersionText()` / `errorMessage()` / `friendlyMessage()` / `html/nothing/repeat/classMap/ifDefined` / `NuntElement` / `define` / `NuntPager` | `versionText` 把 `/api/v1/system/info` 的对象版本号变成 `dev` 这样的字符串 |

两条硬规矩：

1. **light DOM 没有 `<slot>`**：组件的「插槽」用属性传 —— 表格操作列用 `columns[].render`，
   状态块的附加内容用 `action`，对话框内容用 `openDialog({body})`；
2. **不要拼 `innerHTML`**：数据一律走 Lit 的文本绑定或 DOM 节点（后端字符串不会变成 HTML）。

### 7.4.1 组件按需加载（lib/components/*）

背景：`vendor/shoelace/nunt-shoelace.js`（由 `scripts/sync-vendor.ps1` 生成）把 42 个组件一次性注册，
于是**登录页首屏也要为整套组件付 217 个请求 / 361 KB**。vendor 不能改（会被同步脚本覆盖），
所以在我们自己的 assets 下按域拆成入口模块 —— **谁用到谁 import**：

| 入口 | 内容 | 谁引 |
| --- | --- | --- |
| `lib/components/core.js` | sl-icon / sl-icon-button / sl-badge / sl-button / sl-spinner / sl-alert，并按本地路径 `setBasePath`（零外部请求） | 所有入口都引它 |
| `lib/components/shell.js` | core + sl-input / sl-card / sl-drawer / sl-dropdown / sl-menu / sl-menu-item | `app.js`（登录页与外壳） |
| `lib/components/feedback.js` | core + sl-dialog | toast / confirmDialog / promptDialog / openDialog 的调用方 |
| `lib/components/form.js` | core + sl-input / select / option / checkbox / radio / radio-group / switch / textarea / tag | 用到 `formGrid`、`nunt-form`、`nunt-tags`、`nunt-kv` 的页面 |
| `lib/components/tabs.js` | core + sl-tab / tab-group / tab-panel / divider | settings、web |
| `lib/components/progress.js` | core + sl-progress-bar | acme |
| `lib/components/table.js` | core + sl-skeleton | 表格密集的页面（可选，NuntTable 本身只用 core） |
| `lib/components/disclosure.js` | core + sl-details | 用折叠面板的页面 |
| `lib/components/datetime.js` | core + sl-format-bytes / format-date / format-number / relative-time | 目前无人使用（nunt 用自带 `fmtBytes/fmtTime`），保留给以后 |

规矩：

1. 组件必须在**创建元素之前**注册 —— 入口写成同步 `import`，放在页面文件顶部，Lit 首次渲染时元素已升级；
2. Shoelace 的 vendor 包是自包含的：每个组件文件会自己带上依赖的 chunk（例如 sl-tag 会把
   sl-icon-button 拉进来），**不需要**替它补依赖；
3. `sl-tooltip` / `sl-popup` **不在 core 里**：nunt 的模板没有 `<sl-tooltip>`，它们只是 Shoelace
   自己的 tooltip 指令的可选依赖，一并注册要多花约 7.5 KB br（实测）。要用时 import core 之外自行补；
4. 漏引入口的症状是「页面上出现一个没升级的空 `<sl-xxx>`」，浏览器会在控制台报
   `… has not been registered` 之类 —— `ui-smoke` 与 `ui-baseline` 每页都有一条检查点守着它
   （见 7.6），CI 会红。

### 7.5 页面模板（新页面照抄这一份）

```js
// pages/demo.js
import { NuntElement, html, define, formGrid, openDialog, toast, errorMessage } from '../lib/kit.js';

class DemoPage extends NuntElement {
  static properties = { rows: { attribute: false }, loading: { type: Boolean }, error: { attribute: false } };

  constructor() {
    super();
    this.ctx = null;              // 由 mount() 注入
    this.rows = [];
    this.loading = true;
    this.error = null;
    this.disposed = false;
  }

  connectedCallback() { super.connectedCallback(); this.load(); }
  disconnectedCallback() { super.disconnectedCallback(); this.disposed = true; }

  async load() {
    this.loading = true;
    try {
      this.rows = (await this.ctx.api.get('/api/v1/demo/items')) || [];
      this.error = null;
    } catch (err) {
      this.error = err;
    } finally {
      if (!this.disposed) this.loading = false;
    }
  }

  async edit(row) {
    const form = formGrid([
      { name: 'name', label: '名称', value: row ? row.name : '' },
      { name: 'enable', label: '启用', type: 'switch', value: row ? row.enable !== false : true, text: '启用' },
    ]);
    openDialog({
      title: row ? '编辑' : '新建',
      body: form.node,
      actions: [
        { label: '取消' },
        { label: '保存', kind: 'primary', close: false, onClick: async (dlg, button) => {
            const values = form.read();
            if (!values.name) { form.fieldError('name', '请填写名称'); return; }
            dlg.setBusy(true, button);
            try { await this.ctx.api.put('/api/v1/demo/items/' + row.id, values); toast('已保存', 'ok'); dlg.close(); }
            catch (err) { form.error(errorMessage(err, '保存失败')); }
            finally { dlg.setBusy(false, button); }
          } },
      ],
    });
  }

  render() {
    const columns = [
      { key: 'name', title: '名称' },
      { key: 'mode', title: '模式', width: 90, render: (row) => html`<sl-badge pill variant="neutral">${row.mode || '-'}</sl-badge>` },
      { title: '操作', actions: true, width: 140,
        render: (row) => html`<sl-button size="small" @click=${() => this.edit(row)}>编辑</sl-button>` },
    ];
    return html`
      <section class="card">
        <div class="card-header">
          <h2>演示列表</h2>
          <span class="sub">${this.rows.length ? '共 ' + this.rows.length + ' 条' : ''}</span>
          <span class="spacer"></span>
          <sl-button size="small" @click=${() => this.load()}>刷新</sl-button>
        </div>
        <div class="card-body tight">
          <nunt-table caption="演示列表" .columns=${columns} .rows=${this.rows}
            .loading=${this.loading} .error=${this.error} .onRetry=${() => this.load()}
            empty="还没有数据"></nunt-table>
        </div>
      </section>`;
  }
}

define('nunt-page-demo', DemoPage);

export default {
  id: 'demo',
  title: '示例',
  icon: '<svg viewBox="0 0 24 24" ...></svg>',
  async mount(root, ctx) {
    const page = document.createElement('nunt-page-demo');
    page.ctx = ctx;            // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.disposed = true; page.remove(); };
  },
};
```

约定：

- 页面模块契约与 `ctx` 语义**不变**（见 7.3）；页面内部怎么渲染随意，但请用 kit；
- **页面顶部要 import 自己需要的组件入口**（见 7.4.1），例如表单页写
  `import '../lib/components/form.js';`、`import '../lib/components/feedback.js';` ——
  页面是动态 import 的，所以这些组件只在真正打开这一页时才加载；
- 页面骨架固定用容器类：`<section class="card">` + `<div class="card-header">`（`<h2>` 标题 +
  `<span class="sub">` + `<span class="spacer">` + 右侧按钮）+ `<div class="card-body">`
  （放表格时用 `class="card-body tight"` 去掉内边距），页内提示条用 `<div class="notice">`。
  这些类定义在 `style.css` 第 4 节，页面不要再自带这几条样式；
- 卡片标题用 `<h2>`：`<h1>` 是外壳顶栏的当前页标题，从 h3 起会被 axe 判 `heading-order`；
- 每个 `ctx.api` 调用都要有 loading / error 分支，错误用 `errorCard` 或 `toast` 呈现；
- 页面卸载时把 `disposed` 打开，异步回调不要再写已经卸载的节点；
- 页面自己的样式（很少需要）写在页面里并随 `mount` 的清理函数移除，不要往 `style.css` 加。

### 7.6 UI 测试怎么跑（阶段 3 固化）

四层，全部是「真实二进制 + 无头 Chromium」，都不需要 npm 参与构建（Playwright / axe-core 只在 devDependencies）：

| 脚本 | 覆盖 | 产物 / 退出码 |
| --- | --- | --- |
| `node scripts/vendor-smoke.mjs` | vendor 树完整性：组件注册、图标本地可取、零 404、零外部请求 | `docs/screenshots/vendor/`；失败非零退出 |
| `node scripts/ui-smoke.mjs [--out dir] [--exe nunt.exe]` | **浅色主题**：登录 → 12 页挂载 + axe 四档 + 每页关键交互 + **每页「没有未注册组件」断言** + WAF 请求测试的**必然命中**断言 + console/未捕获异常/失败请求/4xx·5xx/外部请求统计（84 个检查点） | `<out>/ui-smoke.json`、`ui-smoke.md`、`<out>/*.png`；任一检查失败或 axe 非 0 时非零退出 |
| `node scripts/ui-baseline.mjs --out docs/screenshots/phaseX --label '...'` | **深色主题**：12 页整页截图 + 逐页 axe + console/请求统计 + **每页「没有未注册组件」断言** + 演示数据播种（含一条真实 TCP 转发连接，让「转发日志」对话框有真实数据） | `REPORT.md` / `a11y.json` / `baseline.json` + 13 张截图 |
| `node scripts/firstload.mjs [--out dir] [--label before\|after]` | **首屏传输实测**：全新 context 冷缓存下量登录页首屏 / 登录+外壳 / 单页增量的请求数与字节（`Request.sizes()` 的 body + 响应头，服务端 br 协商），按「自有代码 / vendor 组件 / vendor 图标 / 主题 CSS / API」分桶 | `<out>/firstload.json` + 控制台汇总表 |
| `node scripts/theme-check.mjs` | 浅色主题与窄屏外壳（420x900 侧栏收进 sl-drawer） | `docs/screenshots/phase1/` |

另有 `node scripts/kit-smoke.mjs`（notify 页的 kit 全链路：新建 → 校验 → 保存 → 删除）、
`node scripts/theme-check.mjs`（浅色 + 窄屏抽屉）与 `node scripts/vendor-smoke.mjs`（vendor 树完整性）。

两个 Playwright 脚本与 `firstload.mjs` 共用 `scripts/lib/devserver.mjs`（临时实例、端口探测、回显服务、
管理 API 客户端、演示数据），因此「演示数据」只有一份实现：里面**包含 WAF 配置**（引擎 + CRS + block），否则「请求测试」永远返回「未拦截」，测不出拦截路径。

**每页的「未注册组件」断言**：页面挂载 + axe 之后，控制台里不允许出现
`… has not been registered` / `has already been defined` / `Failed to upgrade` 这类报错。
这是「组件按需加载」这个改动的回归防线：漏引 `lib/components/*` 时页面会静默失效。

前置：`go build -o nunt.exe ./cmd/nunt`（脚本默认用仓库根的 `nunt.exe`，可用 `--exe` 指定）。
两个 Playwright 脚本默认**自己起一个临时实例**（数据目录在 `.gocache/` 下，结束即删），
也可以 `--base http://127.0.0.1:3113 --password <管理员密码>` 连一个已在运行的实例；
它们都只用默认管理端口 3113（`nunt` 的默认监听地址，脚本不写配置文件）。

> 端口默认值已从 16601 改为 **3113**（`config.DefaultAdminListen`）。`docs/screenshots/` 下
> `before` / `phase*` / `polish` 里的 `16601` 是**当时采集的历史记录**，不是当前默认值；
> 只有 `scripts/*.mjs`、`scripts/*.ps1` 与本文的默认端口需要跟着代码走。

CI：`.github/workflows/ci.yml` 的 `frontend` job（**独立 job**，不影响 Go / Docker / govulncheck 的耗时）：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
go build -o nunt ./cmd/nunt
node scripts/ui-smoke.mjs --exe ./nunt --out artifacts/ui-smoke
node scripts/ui-baseline.mjs --exe ./nunt --out artifacts/ui-baseline --label ci
# 截图与报告作为 artifact 上传（if: always()，失败的那次最需要看）
```

### 7.7 已知限制（阶段 3 结论，别再重复踩）

1. **sl-dialog 的 landmark 误报（已用运行时补丁消除）**：`sl-dialog` 的阴影 DOM 里有一个 `<header>`，
   它在 ARIA 里映射成 banner landmark；对话框一打开页面就有两个 banner，axe 报
   `landmark-no-duplicate-banner` + `landmark-unique`（`.topbar` 是被指向的那个）。
   kit 的 `openDialog()` 在挂载后把对话框阴影里那个 header 降级为 `role="presentation"`
   （**运行时补丁，不改 vendor 文件**；拿不到阴影就静默跳过，最坏退化成这条限制）。
   对话框本身不受影响：面板仍然由 `aria-labelledby="title"` 指向阴影里的 `<h2>`，可访问名称不变。
   `scripts/ui-smoke.mjs` 里有一条「对话框打开时没有 sl-dialog 的 landmark 误报」的检查点守着它；
   **升级 Shoelace 之后必须重新确认这条补丁仍然命中**（`kit.js` 的 `demoteDialogHeader`，选择器取自 `<header part="header">`）。
2. **axe 的 `label-title-only` 对滚出视口的控件误判**：Shoelace 控件的阴影 `<input>` 永远带
   `aria-describedby="help-text"`；控件被滚出对话框的可视区时 axe 认为它「没有可见标签」，
   于是报 serious。它与滚动位置相关（同一个控件滚回视口内就消失），只会出现在**对话框内部的长表单**上；
   12 页的页面级扫描不受影响（都是 0）。给控件传 `label`（而不是 `aria-label`）才是真正的修法。
3. **`nunt-tags` 必须传 `label`**（见 7.4），否则内层 `sl-input` 同样命中 `label-title-only`。
   位置固定：标签输入框在上、已添加的标签在下面（label 由 `sl-input` 渲染，`nunt-form` 不再重复渲染外层标签）。
4. ~~`lib/ui.js` 仍在仓库里~~ —— **已删除**（发版前收尾）：`renderIcon/fmtBytes/fmtTime/fmtDuration/escapeHtml`
   五个还有调用方的纯函数搬进了 `lib/kit.js`，手写构件（`el/modal/tableEl/formGrid/toast`…）本来就没有调用方，
   随文件一起删掉；全仓库不再有 `lib/ui.js` 的 import。以后写页面只用 kit。

---
