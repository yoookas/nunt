# nunt 前端冒烟报告（light 主题）

- 生成时间：2026-10-16T14:10:47.752Z
- 服务：http://127.0.0.1:16601（脚本自行启动的临时实例）
- axe-core：4.14.0（运行时 4.14.0，规则标签 wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice）
- 浏览器：Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36

## 1. 结论

| 指标 | 数值 |
| --- | --- |
| 检查点 | 66 |
| 通过 | 66 |
| 失败 | 0 |
| 页面数 | 12 |
| axe critical / serious / moderate / minor | 0 / 0 / 0 / 0 |
| console / 未捕获异常 / 失败请求 / 4xx·5xx / 外部请求 | 0 / 0 / 0 / 0 / 0 |

## 2. 检查点明细

| 区域 | 检查点 | 结果 | 说明 |
| --- | --- | --- | --- |
| shell | 登录页处于浅色主题 | PASS | html class = sl-theme-light |
| shell | 浏览器表单登录成功（外壳顶栏出现） | PASS |  |
| shell | 侧边栏 12 个导航项 | PASS | 导航项 12 |
| shell | 主题切换深/浅两向都生效 | PASS | 深色 true，浅色 true |
| dashboard | 页面挂载并渲染内容 | PASS | 顶栏「概览」，内容子节点 1 |
| dashboard | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| dashboard | 概览卡片渲染（h2 标题 >= 3） | PASS | h2 数量 5 |
| dashboard | 「刷新」后模块卡片仍在 | PASS | h2 数量 5 |
| web | 页面挂载并渲染内容 | PASS | 顶栏「Web 服务」，内容子节点 1 |
| web | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| web | 规则表有演示数据（>= 2 行） | PASS | 行数 2 |
| web | 「新建 Web 规则」对话框打开 | PASS |  |
| web | 反向代理暴露「限速（请求/秒）」与「请求体上限（字节）」 | PASS | 限速可见 true，请求体上限可见 true |
| web | 对话框打开时没有 sl-dialog 的 landmark 误报 | PASS | 0 条（其余对话框级违规：label-title-only） |
| web | 取消后对话框关闭 | PASS | 仍打开的对话框 0 |
| forward | 页面挂载并渲染内容 | PASS | 顶栏「端口转发」，内容子节点 1 |
| forward | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| forward | 转发规则表有数据 | PASS | 行数 1 |
| forward | 转发日志对话框有真实日志行（真实 TCP 连接产生） | PASS | 行数 1，首行「2026-10-16 22:09:57 127.0.0.1:59296 -> 127.0.0.1:12231 上行 19 B / 下行 37 B」 |
| forward | 关闭对话框后 5 秒轮询真的停止 | PASS | 关闭后新增日志请求 0 次（总请求 947→948） |
| ddns | 页面挂载并渲染内容 | PASS | 顶栏「动态域名」，内容子节点 1 |
| ddns | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| ddns | 运行状态显示后端真实失败计数 failures=7 | PASS | 成功/失败徽标 = 12/7 |
| ddns | 存在演示用的停用规则行 | PASS |  |
| ddns | 未启用规则点「立即执行」提示「该规则未启用，已跳过」 | PASS | toast「该规则未启用，已跳过」 |
| ddns | 未启用规则不发出 POST /run | PASS | 新增 /run 请求 0 次 |
| acme | 页面挂载并渲染内容 | PASS | 顶栏「证书」，内容子节点 1 |
| acme | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| acme | 证书任务表有数据 | PASS | 行数 1 |
| acme | 密钥类型选项是后端取值 ec256/ec384/rsa2048/rsa4096（默认 ec256） | PASS | 默认 ec256，选项 ec256,ec384,rsa2048,rsa4096 |
| storage | 页面挂载并渲染内容 | PASS | 顶栏「存储」，内容子节点 1 |
| storage | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| storage | 存储挂载表有数据 | PASS | 行数 1 |
| storage | 「新建挂载」对话框字段齐全 | PASS | 10 个字段 |
| files | 页面挂载并渲染内容 | PASS | 顶栏「文件管理」，内容子节点 1 |
| files | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| files | 文件页拿到存储挂载点 | PASS | 挂载点选项 1 |
| files | 根目录下列出真实文件条目 | PASS | 行数 3，首行「assets/ 目录 - 2026-10-16 22:09:55 打开」 |
| waf | 页面挂载并渲染内容 | PASS | 顶栏「WAF 防护」，内容子节点 1 |
| waf | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| waf | 五张卡片标题齐全 | PASS | WAF 配置 / 请求体检查策略 / 规则文件 / 规则组 / 请求测试 / 拦截日志 |
| waf | 请求测试返回结果（拦截判定渲染出来） | PASS | 判定：未拦截 |
| task | 页面挂载并渲染内容 | PASS | 顶栏「计划任务」，内容子节点 1 |
| task | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| task | 计划任务表有数据 | PASS | 行数 1 |
| task | 「新建任务」对话框含 Cron 与常用示例 | PASS | cron 可见 true，示例按钮 1 |
| notify | 页面挂载并渲染内容 | PASS | 顶栏「通知」，内容子节点 1 |
| notify | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| notify | Webhook 表有数据 | PASS | 行数 1 |
| notify | 「新建 Webhook」对话框含事件多选 | PASS | 可选事件 5，multiple=true |
| logs | 页面挂载并渲染内容 | PASS | 顶栏「日志」，内容子节点 1 |
| logs | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| logs | 日志页渲染出日志行 | PASS | 行数 11 |
| logs | 级别过滤生效（切到 error 后行数不增加） | PASS | 11 行 → 0 行（0 / 11 条） |
| settings | 页面挂载并渲染内容 | PASS | 顶栏「设置」，内容子节点 1 |
| settings | 浅色主题 axe 四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |
| settings | 五个设置 tab | PASS | tab 数 5 |
| settings | 管理端 IP 白名单用 nunt-tags（内层输入有可见 label） | PASS | chips 2，内层 label「管理端 IP 白名单」，外层重复标签 false，值 ["127.0.0.1","10.0.0.0/8"] |
| settings | 新建 Token 的「权限范围」用 nunt-tags | PASS | 内层 label「权限范围」 |
| settings | nunt-tags 能加出多枚标签 | PASS | 标签数 2，值 ["read","write"] |
| global | console 报错+警告 0 | PASS | console 0 |
| global | 未捕获异常 0 | PASS | pageerror 0 |
| global | 失败请求 0 | PASS | 失败请求 0（SSE 中断 0 条不计） |
| global | HTTP 4xx/5xx 0 | PASS | 4xx/5xx 0 |
| global | 外部请求 0 | PASS | 外部请求 0 |
| global | 12 页 axe 合计四档全 0 | PASS | critical 0 / serious 0 / moderate 0 / minor 0 |

## 3. 逐页 axe（浅色主题）

| 页面 | critical | serious | moderate | minor | 说明 |
| --- | --- | --- | --- | --- | --- |
| #/dashboard | 0 | 0 | 0 | 0 | — |
| #/web | 0 | 0 | 0 | 0 | — |
| #/forward | 0 | 0 | 0 | 0 | — |
| #/ddns | 0 | 0 | 0 | 0 | — |
| #/acme | 0 | 0 | 0 | 0 | — |
| #/storage | 0 | 0 | 0 | 0 | — |
| #/files | 0 | 0 | 0 | 0 | — |
| #/waf | 0 | 0 | 0 | 0 | — |
| #/task | 0 | 0 | 0 | 0 | — |
| #/notify | 0 | 0 | 0 | 0 | — |
| #/logs | 0 | 0 | 0 | 0 | — |
| #/settings | 0 | 0 | 0 | 0 | — |

## 4. 截图

- light-acme-keytype.png
- light-acme.png
- light-dashboard.png
- light-ddns-skip.png
- light-ddns.png
- light-files-root.png
- light-files.png
- light-forward-log.png
- light-forward.png
- light-login.png
- light-logs.png
- light-notify.png
- light-settings-tags.png
- light-settings-token.png
- light-settings.png
- light-storage.png
- light-task.png
- light-waf-test.png
- light-waf.png
- light-web-proxy-hardening.png
- light-web.png
