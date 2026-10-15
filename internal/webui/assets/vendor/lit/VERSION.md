# Lit vendor 快照

这个目录是 vendor 进来的第三方代码，不要手改；升级请跑同步脚本。

| 项 | 值 |
| --- | --- |
| 包名 | lit（含 lit-element / lit-html / @lit/reactive-element） |
| 版本 | 3.3.3（固定版本，与 Shoelace 2.20.1 的依赖一致） |
| 许可证 | MIT |
| 上游仓库 | https://github.com/lit/lit |
| 同步脚本 | scripts/sync-lit.ps1 |
| 生成时间 | 2026-10-15 16:49:32 |

## 同步与校验命令

    pwsh -File scripts/sync-lit.ps1
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly

## 文件清单（11 个）

| 目标 | 来源 |
| --- | --- |
| index.js | lit/index.js |
| lit-element.js | lit-element/lit-element.js |
| lit-html.js | lit-html/lit-html.js |
| is-server.js | lit-html/is-server.js |
| directive.js | lit-html/directive.js |
| directive-helpers.js | lit-html/directive-helpers.js |
| directives/repeat.js | lit-html/directives/repeat.js |
| directives/if-defined.js | lit-html/directives/if-defined.js |
| directives/class-map.js | lit-html/directives/class-map.js |
| reactive-element.js | @lit/reactive-element/reactive-element.js |
| css-tag.js | @lit/reactive-element/css-tag.js |

## 与上游的差异（只有两处，都是为了让浏览器直接加载）

1. 跨包裸模块说明符改写成相对路径：@lit/reactive-element -> ./reactive-element.js；lit-element/lit-element.js -> ./lit-element.js；lit-html/is-server.js -> ./is-server.js；lit-html -> ./lit-html.js；
2. 去掉 //# sourceMappingURL 注释（.map 文件没有一起 vendor）。

## 体积

| 范围 | 文件数 | 未压缩 | gzip 估算 |
| --- | --- | --- | --- |
| 整个 vendor/lit | 11 | 20795 字节（20.3 KiB） | 9786 字节（9.6 KiB） |

## 校验基线（-VerifyOnly 比对用，请勿手工修改）

version=3.3.3
files=11
bytes=20795
gzip=9786
generated=2026-10-15T16:49:32+08:00
