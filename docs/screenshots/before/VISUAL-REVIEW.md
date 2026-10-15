这一节是人工逐张看 12 张截图（1440×900，深色主题）得出的清单，配合第 1~4 节的机器数据看。
所有截图都在本目录：`login.png` 与 12 个 `<page>.png`。

### A. 渲染错误（先修这些，它们是用户「样式有问题」抱怨里最刺眼的部分）

1. **7 个页面的卡片标题被渲染成字面量 "h3"，标题文字整个丢失。**
   受影响页面：`web`、`forward`、`ddns`、`acme`、`files`、`waf`、`task`（共 12 页里的 7 页）。
   证据：
   - [web.png](web.png) 第一张卡片顶部是 `h3点击规则行可查看最近访问日志`；
   - [files.png](files.png) 是 `h3GET /api/v1/storage/mounts/{id}/list?path=` 与 `h3GET/DELETE /api/v1/files/shares`；
   - [waf.png](waf.png) 有 5 处（`h3 GET/PUT /api/v1/waf/config`、`h3 测试`、`h3 每 10 秒自动刷新` 等）；
   - [forward.png](forward.png) 甚至只剩一个孤零零的 `h3` 占了一行；
   - 反例：[dashboard.png](dashboard.png) 的「系统指标/模块状态/最近日志」、[settings.png](settings.png) 的「系统参数」、[storage.png](storage.png) 的「存储挂载」、[notify.png](notify.png) 的「通知渠道」、[logs.png](logs.png) 的「运行日志」都正常。
   根因（已定位）：这 7 个页面各自内置了一份本地兜底的 `el()`（见 `internal/webui/assets/pages/waf.js:59` 等），
   判断标签名用的是 `/^[a-zA-Z]+$/` —— 这个正则不接受数字，而 `h3` 带数字，
   于是走了「回退分支」：`makeEl('span', null, ['h3'], false)`，属性对象被丢弃，结果是 `<span>h3</span>`。
   另外 5 个页面（dashboard/storage/notify/logs/settings）已经改成直接用 `lib/ui.js` 的 `el()`，
   所以同一个控制台里同时存在「对的」和「错的」两套渲染路径 —— 这正是「半新半旧」的观感来源。
   现场验证：`.gocache/dom-probe.mjs` 打出的真实 DOM 是 `<div class="card-head"><span>h3</span>...`，
   而在同一页面里 `el('h3', { text: 'WAF 配置' })`（lib 版）得到的是正确的 `<h3>WAF 配置</h3>`。

2. **版本号显示成 `[object Object]`。** 三处：顶栏右上（`v[object Object]`）、左侧栏底部（`v[object Object]`）、
   [dashboard.png](dashboard.png) 的「版本」卡片（`[object Object]`）。
   `GET /api/v1/system/info` 的 `version` 字段是对象，前端直接拼进文本节点。

3. **/files 页面把后端的原始 404 文案直接摊在界面上。** [files.png](files.png) 第二张卡片显示
   「分享链接接口不可用 / `404 page not found`」（Go 的默认响应体）。该请求 `GET /api/v1/files/shares` 在未启用 filebrowser 模块时确实 404，
   但界面应该只给一句人话，而不是把协议层的原文透出来（同一页还重复请求了两次，见第 3 节 console）。

### B. 布局与视觉一致性

4. **表格列宽失衡，内容被挤到变形。** [web.png](web.png) 最明显：名称列窄到「演示静态站点」断成两行；
   状态列把「已启用」竖排成三行（已/启/用）；操作列的三个图标按钮竖着排且最右边一个被表格边缘裁切；
   目标列的超长路径（`D:\Desktop\nunt\.gocache\ui-baseline\...\www`）换行后把行高撑到别的行的两倍。
   表头「操作」是空列（axe 的 `empty-table-header` 在 7 个页面都报了）。

5. **标题与提示文字粘在一起。** 卡片头里 `h3` 丢失后，提示文字顶到了最左边（「h3点击规则行…」），
   标题与说明之间没有任何视觉分隔；[forward.png](forward.png) 只剩一个 `h3` 占位，看着像没写完的页面。

6. **同一种「操作」在不同页面是两种控件。** 规则类页面（web/forward/ddns/acme/task）用图标按钮，
   [storage.png](storage.png)、[notify.png](notify.png) 用文字按钮（浏览/测试/编辑/删除）。行高、对齐、可点击区都不一样。

7. **中英文混排。** 概览页模块卡片标题是 `Certificates`/`Port forwarding`/`Scheduled tasks`/`Web service`
   （旁边「动态域名」「Web 应用防火墙」却是中文）；[task.png](task.png) 运行结果标签是 `never run`；
   [files.png](files.png) 类型列 `file`/`目录` 混用；按钮「新建 Webhook」。

8. **空状态与空白区域过大。** [acme.png](acme.png) 的「暂无已签发的证书」占了半屏高；
   [logs.png](logs.png) 日志框下方留了整屏空白；[waf.png](waf.png) 的「暂无 bodyState 计数」区域是几个大灰块。
   页面高度差也很夸张：概览 1389px、WAF 2726px，其余 10 页都正好 900px（内容不足一屏）。

9. **概览页卡片网格两行不同列宽。** [dashboard.png](dashboard.png) 第一行 4 张卡（CPU/Go 内存/主机内存/磁盘）、
   第二行 3 张卡（系统负载/运行时长/版本），两行的列边界对不齐；「主机内存」「磁盘」「系统负载」在 Windows 上永远是「—」+「当前平台未提供」，
   等于 4 张卡里 3 张是空的。

10. **日志换行没有悬挂缩进。** [logs.png](logs.png) 第一条日志折行后从时间戳列的最左边继续，和消息列对不齐，长日志很难扫读。

11. **WAF 页面信息层级混乱。** [waf.png](waf.png) 把接口路径当正文展示（`GET/PUT /api/v1/waf/config`、`来自 GET /api/v1/waf/config 的 undeclaredRoutes 字段` 之类），
    一屏里塞了配置表单、策略说明、计数面板、规则文件树、测试区、日志区，2726px 里三种字号混排，普通用户很难找到「我要改什么」。
    此外「签发」这种主按钮出现在表格行内（[acme.png](acme.png)），和同行的开关抢视觉重心。

### C. 无障碍（axe 明细见第 4 节，这里是对应的视觉解释）

12. **主题切换按钮没有可访问名称**：12 个页面每个都报一条 `button-name`（critical，`button[data-theme-toggle="1"]`）——
    它是纯图标按钮，只有 `title`，屏幕阅读器读到的是空按钮。
13. **对比度不足共 110 处**：侧栏「控制台」副标题、未选中导航项、顶栏版本号、表格里的次要文字（时间、备注、说明）在深色主题下都是灰压灰；
    日志页一页就有 17 处，概览页 28 处。axe 报的是 `color-contrast`（serious）。
14. **下拉框/输入框没有可访问名称**：waf 页 6 个 `select`、2 个数字输入框，设置页 3 个输入框 + 2 个下拉，文件页 1 个下拉，
    axe 报 `select-name` / `label`（critical）。视觉上它们只是「标签在左边」，但标签没有和控件关联（没有 `for`/`id`）。
15. **没有 `<h1>`、没有 `main` landmark，内容不在 landmark 里**：12 个页面都报
    `landmark-one-main`/`page-has-heading-one`（moderate），`region` 一共 188 处（waf 页 32 处）。
    —— 这条与第 1 条其实是同一个病根：标题元素根本没生成出来，页面自然没有标题层级。
