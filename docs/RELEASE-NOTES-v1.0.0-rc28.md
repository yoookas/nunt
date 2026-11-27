# nunt v1.0.0-rc28

第二十八个候选版本：概览页的两张柱状图换成 bklit 折线图，除总请求外还画出被访问
规则拦截和被 WAF 拦截的数量。

**没有配置变更**，升级后不需要重新配置任何规则。

## 概览页趋势图

- 原来的柱状图只画总量，一次流量尖峰和一次拦截尖峰看起来一模一样；现在每张图三条线：

  | 线 | 含义 |
  |---|---|
  | 总请求（实线） | 该小时桶内的全部请求 / 连接 |
  | 访问规则拦截（橙色虚线） | 被有序访问规则拒绝：web 记录里 `reason` 以 `deny:` / `rest:deny` / `ua-rest:deny` 开头，或转发的 `result = "denied"` |
  | WAF 拦截（红色虚线） | `waf_action` 非空的记录 |

- 两条拦截线与总量差一个数量级，共用一根 Y 轴只会画成贴零的直线，因此挂在**右侧
  Y 轴**；图例同时给出窗口内的合计（`总请求 1,584 · 访问规则拦截 42 · WAF 拦截 22`），
  用数字交代量级，避免双轴误读；
- 整条序列恒为 0 时该线自动隐藏——端口转发图里没有 WAF 拦截，就不画那根零线；
- 悬停显示十字准线、当前小时三个数值和完整时间；
- 坐标轴与 tooltip 为中文、按小时显示；空数据回落到「暂无请求数据」。

## 数据

`/api/v1/logs/access/series` 的每个点新增两个字段：

```json
{ "time": "…", "total": 43, "denied": 6, "blocked": 1 }
```

由同一条聚合 SQL 的 `SUM(CASE …)` 算出，**没有改表结构、没有迁移**。basic-auth 失败、
限流和请求体超限不计入「访问规则拦截」。

## 工程

- 引入 [Bklit UI](https://bklit.com) 的 line chart：它是 shadcn registry 而非 npm 包，
  101 个源文件（line-chart 依赖闭包 + y-axis）以 MIT 许可拷入 `frontend/src/charts/`，
  来源与唯一一处本地修改记录在 `src/charts/BKLIT.md`；
- 图表用 Tailwind utility 写自身样式，因此只引入 `tailwindcss/theme.css` 与
  `tailwindcss/utilities.css`，**不含 preflight**，不会重置周围 antd 组件；
- 配色通过 CSS 变量由 antd token 注入，亮色/暗色自动跟随；
- 新增依赖：`motion`、`d3-array`、`d3-scale`、`d3-shape`、`@number-flow/react`、`clsx`、
  `tailwind-merge`；构建期新增 `tailwindcss`、`@tailwindcss/vite`；
- **代价**：概览页懒加载 chunk 由约 8 KB 增至 307 KB（104 KB gzip），其余路由不受影响。

## 验证

- `gofmt` 干净；`go vet ./...`、`go build ./...` 通过；
- `go test ./... -count=1`：22 个包、411 个测试全部通过（新增
  `TestSeriesCountsRefusals`：web 规则拒绝、WAF 拦截、转发 denied 计入，basic-auth 不计入）；
- `npm run build`、`npm run smoke`（10 条路由，图表在 jsdom 下挂载不崩）通过；
- 概览页在 1440×1000 与 390×844 下用 Playwright 截图核对，含悬停态与图表右侧刻度。

## 镜像与校验

```sh
docker load < nunt-v1.0.0-rc28-amd64.tar.gz
NUNT_IMAGE=nunt:v1.0.0-rc28 docker compose up -d
```

四个归档（amd64 / arm64 / armv7 / oci）的校验和都在 `SHA256SUMS` 里。
