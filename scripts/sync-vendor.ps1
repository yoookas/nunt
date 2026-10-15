#Requires -Version 7.0
<#
.SYNOPSIS
  把 Shoelace 组件库同步（vendor）到 internal/webui/assets/vendor/shoelace/。

.DESCRIPTION
  来源包：@shoelace-style/shoelace（npm，MIT）
  上游仓库：https://github.com/shoelace-style/shoelace

  这个脚本只做三件事：
    1. 从 $Version 对应的包拷贝「需要的组件 + 它们的相对导入闭包 + 主题 CSS + 需要的图标」；
    2. 生成一个入口文件 nunt-shoelace.js（只 import 选中的组件，不引整个 dist/shoelace.js）；
    3. 写 VERSION.md 记录版本/许可证/来源/体积，并打印校验信息（文件数、大小、gzip 估算）。

  为什么不做打包：Shoelace 的 dist 已经是 Rollup 产物，组件之间只用相对路径 import，
  浏览器可以直接当 ESM 加载，所以 vendor 之后不需要任何构建步骤，也不破坏「零构建」。

  用法：
    pwsh -File scripts/sync-vendor.ps1                 # 从 node_modules 拷贝（先 pnpm install）
    pwsh -File scripts/sync-vendor.ps1 -Download       # 直接从 npm 下载 tgz 解包，不需要 pnpm
    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly     # 只校验，不写文件（比对 VERSION.md 的基线）
    pwsh -File scripts/sync-vendor.ps1 -AllIcons       # 连整套 Bootstrap Icons 一起 vendor（约 1.6MB）

  参数说明：
    -Components 组件名（不含 sl- 前缀）。默认就是控制台需要的那批；
    -Icons      图标名（Bootstrap Icons 文件名，不含 .svg）。默认是控制台用到的子集。
#>
[CmdletBinding()]
param(
  [string]$Version = '2.20.1',
  # cdn/ 是上游额外发布的「浏览器直载」构建：依赖（lit 等）已经内联进 chunks，
  # 没有裸模块说明符。dist/ 则保留 from "lit" 这样的裸说明符，需要打包器或
  # import map 才能跑，而本项目的 CSP（script-src 'self'）会拦截内联 import map，
  # 所以默认用 cdn/。
  [ValidateSet('cdn', 'dist')]
  [string]$SourceKind = 'cdn',
  [string]$Dest = '',
  [string]$WorkDir = '',
  [string[]]$Components = @(
    'alert', 'animation', 'badge', 'breadcrumb', 'breadcrumb-item', 'button', 'button-group',
    'card', 'checkbox', 'details', 'dialog', 'divider', 'drawer', 'dropdown', 'format-bytes',
    'format-date', 'format-number', 'icon', 'icon-button', 'input', 'menu', 'menu-item',
    'menu-label', 'mutation-observer', 'option', 'popup', 'progress-bar', 'radio', 'radio-group',
    'relative-time', 'resize-observer', 'select', 'skeleton', 'spinner', 'switch', 'tab',
    'tab-group', 'tab-panel', 'tag', 'textarea', 'tooltip', 'visually-hidden'
  ),
  [string[]]$Icons = @(
    'speedometer2', 'globe', 'arrow-left-right', 'arrow-repeat', 'patch-check', 'hdd-stack',
    'folder2-open', 'shield-check', 'clock-history', 'bell', 'journal-text', 'sliders',
    'plus-lg', 'pencil', 'trash', 'play-fill', 'pause-fill', 'arrow-clockwise', 'download',
    'upload', 'x-lg', 'check-lg', 'search', 'gear', 'moon', 'sun', 'box-arrow-right',
    'chevron-down', 'chevron-right', 'chevron-left', 'three-dots-vertical', 'info-circle',
    'exclamation-triangle', 'check-circle', 'x-circle', 'question-circle', 'clipboard', 'eye',
    'eye-slash', 'folder', 'file-earmark', 'cloud-arrow-up', 'terminal', 'key', 'person',
    'people', 'plus-circle', 'dash-circle', 'funnel', 'lock', 'unlock', 'exclamation-octagon',
    'link-45deg', 'lightbulb', 'lightning-charge', 'cpu', 'ethernet', 'wifi', 'diagram-3',
    'list-ul', 'calendar-event', 'send', 'share', 'copy', 'save', 'trash3', 'x', 'check',
    'folder-plus', 'file-earmark-arrow-up', 'arrows-collapse-vertical', 'signpost-split',
    'shield-lock', 'server', 'hdd-network', 'activity', 'graph-up', 'collection', 'database',
    'usb-drive', 'box-arrow-in-right', 'pencil-square', 'toggle-on', 'toggle-off'
  ),
  [switch]$AllIcons,
  [switch]$Download,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PackageName = '@shoelace-style/shoelace'
$SourceUrl = 'https://registry.npmjs.org/@shoelace-style/shoelace/-/shoelace-style-shoelace-' + $Version + '.tgz'
$UpstreamUrl = 'https://github.com/shoelace-style/shoelace'

if (-not $Dest) { $Dest = Join-Path $RepoRoot 'internal/webui/assets/vendor/shoelace' }
if (-not $WorkDir) { $WorkDir = Join-Path $RepoRoot '.gocache/vendor-download' }

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

function Get-GzipLength {
  param([byte[]]$Bytes)
  $ms = [System.IO.MemoryStream]::new()
  $gz = [System.IO.Compression.GZipStream]::new($ms, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $gz.Write($Bytes, 0, $Bytes.Length)
  $gz.Dispose()
  $len = $ms.Length
  $ms.Dispose()
  return [int64]$len
}

function Get-DirStats {
  # VERSION.md 自己记录着这些数字，不能算进统计里（否则永远对不上）。
  param([string]$Path, [string[]]$Exclude = @())
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Files = 0; Bytes = 0; Gzip = 0 } }
  $files = Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object { $Exclude -notcontains $_.Name }
  $bytes = 0
  $gzip = 0
  foreach ($f in $files) {
    $bytes += $f.Length
    $gzip += Get-GzipLength -Bytes ([System.IO.File]::ReadAllBytes($f.FullName))
  }
  return [pscustomobject]@{ Files = $files.Count; Bytes = $bytes; Gzip = $gzip }
}

# 找出一个文件里所有相对导入（Shoelace 的 dist 是 Rollup 产物，统一用相对路径）。
# 两个坑：
#   1. 打包产物里有大量以点开头的 CSS 类名字符串（".icon-button" 之类），
#      宽松地「取所有以点开头的引号字符串」会把它们误当成导入；
#   2. 多行 import 语句里 from 和路径不在同一行。
# 所以先把换行/制表符压成空格，再只匹配 from / import / import( 之后的引号字符串。
function Get-RelativeImports {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path)
  $text = $text.Replace([string][char]10, ' ').Replace([string][char]13, ' ').Replace([string][char]9, ' ')
  $rx = [regex]"(?:from |import |import[(])['""]([.][^'""]*)['""]"
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($m in $rx.Matches($text)) { $out.Add($m.Groups[1].Value) }
  return $out
}

# 从入口文件出发，求出 dist 内部的相对导入闭包（BFS）。
function Resolve-Closure {
  param([string]$DistRoot, [string[]]$Entries)
  $seen = New-Object System.Collections.Generic.HashSet[string]
  $queue = New-Object System.Collections.Generic.Queue[string]
  foreach ($e in $Entries) { if ($queue -notcontains $e) { $queue.Enqueue($e) } }
  $missing = New-Object System.Collections.Generic.List[string]
  while ($queue.Count -gt 0) {
    $rel = $queue.Dequeue()
    $rel = $rel.Replace('\', '/')
    while ($rel.StartsWith('./')) { $rel = $rel.Substring(2) }
    if ($seen.Contains($rel)) { continue }
    $full = Join-Path $DistRoot ($rel.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $full)) {
      if (-not $missing.Contains($rel)) { $missing.Add($rel) }
      continue
    }
    [void]$seen.Add($rel)
    $dir = Split-Path -Parent $rel
    foreach ($imp in Get-RelativeImports -Path $full) {
      $next = $imp
      if ($dir) { $next = $dir + '/' + $imp }
      $parts = New-Object System.Collections.Generic.List[string]
      foreach ($seg in $next.Split('/')) {
        if ($seg -eq '' -or $seg -eq '.') { continue }
        if ($seg -eq '..') { if ($parts.Count -gt 0) { $parts.RemoveAt($parts.Count - 1) }; continue }
        $parts.Add($seg)
      }
      $normalized = [string]::Join('/', $parts)
      if (-not $seen.Contains($normalized)) { $queue.Enqueue($normalized) }
    }
  }
  return [pscustomobject]@{ Files = @($seen); Missing = @($missing) }
}

# ---------------------------------------------------------------------------
# 1. 解析来源目录
# ---------------------------------------------------------------------------

$SourceDist = ''
$TempRoot = ''
if ($Download) {
  $TempRoot = Join-Path $WorkDir ('shoelace-' + $Version)
  $tgz = Join-Path $WorkDir ('shoelace-' + $Version + '.tgz')
  if (-not (Test-Path -LiteralPath $TempRoot)) {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    Write-Host ('下载 ' + $SourceUrl)
    Invoke-WebRequest -Uri $SourceUrl -OutFile $tgz
    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
    & tar -xzf $tgz -C $TempRoot
    if ($LASTEXITCODE -ne 0) { throw 'tar 解包失败' }
  }
  $SourceDist = Join-Path $TempRoot ('package/' + $SourceKind)
} else {
  $pkgJson = Join-Path $RepoRoot ('node_modules/' + $PackageName + '/package.json')
  if (-not (Test-Path -LiteralPath $pkgJson)) {
    throw ('找不到 ' + $pkgJson + '：先运行 pnpm install，或者用 -Download 直接从 npm 取包')
  }
  $installed = (Get-Content -Raw -LiteralPath $pkgJson | ConvertFrom-Json).version
  if ($installed -ne $Version) {
    throw ('node_modules 里是 ' + $installed + '，脚本要求 ' + $Version + '：请把 package.json 的版本对齐后重新 pnpm install')
  }
  $SourceDist = Join-Path $RepoRoot ('node_modules/' + $PackageName + '/' + $SourceKind)
}

if (-not (Test-Path -LiteralPath $SourceDist)) { throw ('来源目录不存在：' + $SourceDist) }

# ---------------------------------------------------------------------------
# 2. 求导入闭包
# ---------------------------------------------------------------------------

$entries = New-Object System.Collections.Generic.List[string]
foreach ($c in $Components) { $entries.Add('components/' + $c + '/' + $c + '.js') }
foreach ($css in @('themes/light.css', 'themes/dark.css')) { $entries.Add($css) }
# 生成的入口文件要 import 它，但它不在任何组件的依赖里，必须显式带上。
$entries.Add('utilities/base-path.js')

$closure = Resolve-Closure -DistRoot $SourceDist -Entries $entries
if ($closure.Missing.Count -gt 0) {
  throw ('来源包缺少这些文件：' + ($closure.Missing -join ', '))
}

$iconList = @()
if ($AllIcons) {
  $iconList = @(Get-ChildItem -LiteralPath (Join-Path $SourceDist 'assets/icons') -Filter '*.svg' | ForEach-Object { $_.BaseName })
} else {
  $iconList = $Icons
}
$missingIcons = @()
foreach ($i in $iconList) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDist ('assets/icons/' + $i + '.svg')))) { $missingIcons += $i }
}
if ($missingIcons.Count -gt 0) { throw ('来源包里没有这些图标：' + ($missingIcons -join ', ')) }

Write-Host ('来源：' + $SourceDist + '（' + $SourceKind + ' 构建）')
Write-Host ('版本：' + $Version + '  组件：' + $Components.Count + ' 个  闭包文件：' + $closure.Files.Count + ' 个  图标：' + $iconList.Count + ' 个')

# ---------------------------------------------------------------------------
# 3. 校验模式：只比对 VERSION.md 记录的基线
# ---------------------------------------------------------------------------

$versionFile = Join-Path $Dest 'VERSION.md'

if ($VerifyOnly) {
  if (-not (Test-Path -LiteralPath $versionFile)) { throw ('缺少 ' + $versionFile + '，先跑一次不带 -VerifyOnly 的同步') }
  $stats = Get-DirStats -Path $Dest -Exclude @('VERSION.md')
  $recorded = @{}
  foreach ($line in Get-Content -LiteralPath $versionFile) {
    if ($line -match '^(files|bytes|gzip|icons|version)=(.+)$') { $recorded[$Matches[1]] = $Matches[2].Trim() }
  }
  $problems = New-Object System.Collections.Generic.List[string]
  if ($recorded['version'] -ne $Version) { $problems.Add('版本不一致：VERSION.md=' + $recorded['version'] + ' 脚本=' + $Version) }
  if ([int64]$recorded['files'] -ne $stats.Files) { $problems.Add('文件数不一致：磁盘=' + $stats.Files + ' 记录=' + $recorded['files']) }
  if ([int64]$recorded['bytes'] -ne $stats.Bytes) { $problems.Add('字节数不一致：磁盘=' + $stats.Bytes + ' 记录=' + $recorded['bytes']) }
  # 入口文件引用的每个组件都必须存在
  $entryFile = Join-Path $Dest 'nunt-shoelace.js'
  if (-not (Test-Path -LiteralPath $entryFile)) { $problems.Add('入口文件 nunt-shoelace.js 不存在') }
  else {
    foreach ($imp in Get-RelativeImports -Path $entryFile) {
      $target = Join-Path $Dest ($imp.Replace('./', '').Replace('/', [System.IO.Path]::DirectorySeparatorChar))
      if (-not (Test-Path -LiteralPath $target)) { $problems.Add('入口引用的文件缺失：' + $imp) }
    }
  }
  Write-Host ('磁盘：文件 ' + $stats.Files + ' 个，' + $stats.Bytes + ' 字节，gzip 估算 ' + $stats.Gzip + ' 字节')
  Write-Host ('记录：文件 ' + $recorded['files'] + ' 个，' + $recorded['bytes'] + ' 字节，gzip 估算 ' + $recorded['gzip'] + ' 字节')
  if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host ('  [x] ' + $p) }
    throw 'vendor 校验失败'
  }
  Write-Host '  [ok] vendor 目录与 VERSION.md 记录一致'
  exit 0
}

# ---------------------------------------------------------------------------
# 4. 拷贝闭包 + 图标 + 主题
# ---------------------------------------------------------------------------

if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

foreach ($rel in $closure.Files) {
  $src = Join-Path $SourceDist ($rel.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  $dst = Join-Path $Dest ($rel.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dst -Force
}

# ---------------------------------------------------------------------------
# 4.5 校验：vendor 后的树里不允许出现裸模块说明符
# ---------------------------------------------------------------------------

# 浏览器只能解析相对/绝对 URL 的 import 说明符，裸说明符（from "lit"）必须靠
# 打包器或 import map，而后台 CSP（script-src 'self'）会把内联 import map 拦掉。
# 所以这里把「不许有裸说明符」变成同步脚本的硬校验。
$bareRx = [regex]"(?:from |import |import[(])[""]([^.""/][^""]*)[""]"
$bareHits = New-Object System.Collections.Generic.List[string]
foreach ($f in Get-ChildItem -LiteralPath $Dest -Recurse -File -Filter '*.js') {
  $t = [System.IO.File]::ReadAllText($f.FullName).Replace([string][char]10, ' ')
  foreach ($m in $bareRx.Matches($t)) {
    $spec = $m.Groups[1].Value
    if ($spec -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*:') {
      $bareHits.Add($f.FullName.Substring($Dest.Length + 1) + ' -> ' + $spec)
    }
  }
}
if ($bareHits.Count -gt 0) {
  throw ('vendor 树里出现裸模块说明符（浏览器无法解析，CSP 也不允许 import map）：' + [char]10 + ($bareHits -join [char]10))
}
Write-Host ('校验：' + $closure.Files.Count + ' 个 JS 文件里没有裸模块说明符')

$iconDir = Join-Path $Dest 'assets/icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
foreach ($i in $iconList) {
  Copy-Item -LiteralPath (Join-Path $SourceDist ('assets/icons/' + $i + '.svg')) -Destination (Join-Path $iconDir ($i + '.svg')) -Force
}

# ---------------------------------------------------------------------------
# 5. 生成入口文件
# ---------------------------------------------------------------------------

$entryLines = New-Object System.Collections.Generic.List[string]
$entryLines.Add('// 由 scripts/sync-vendor.ps1 生成，请勿手工编辑。')
$entryLines.Add('//')
$entryLines.Add('// Shoelace ' + $Version + ' 的本地入口：只加载控制台用到的组件，不引 dist/shoelace.js')
$entryLines.Add('//（那个入口会把全部 50+ 组件都拉进来）。setBasePath 让 sl-icon 从本地')
$entryLines.Add('// vendor 目录取 SVG，不产生任何外部请求，符合后台 CSP。')
$entryLines.Add('')
$entryLines.Add("import { setBasePath } from './utilities/base-path.js';")
foreach ($c in $Components) { $entryLines.Add("import './components/" + $c + "/" + $c + ".js';") }
$entryLines.Add('')
$entryLines.Add("setBasePath(new URL('.', import.meta.url).pathname);")
$entryLines.Add('')
$entryLines.Add('export { setBasePath };')
[System.IO.File]::WriteAllText((Join-Path $Dest 'nunt-shoelace.js'), ([string]::Join([char]10, $entryLines) + [char]10), (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# 6. VERSION.md + 校验信息
# ---------------------------------------------------------------------------

$stats = Get-DirStats -Path $Dest -Exclude @('VERSION.md')
$iconStats = Get-DirStats -Path $iconDir
$jsStats = Get-DirStats -Path (Join-Path $Dest 'components')

$md = New-Object System.Collections.Generic.List[string]
$md.Add('# Shoelace vendor 快照')
$md.Add('')
$md.Add('这个目录是 vendor 进来的第三方代码，不要手改；升级请跑同步脚本。')
$md.Add('')
$md.Add('| 项 | 值 |')
$md.Add('| --- | --- |')
$md.Add('| 包名 | ' + $PackageName + ' |')
$md.Add('| 构建 | ' + $SourceKind + '（cdn = 依赖已内联、无裸模块说明符的浏览器直载版） |')
$md.Add('| 版本 | ' + $Version + '（固定版本，不用范围） |')
$md.Add('| 许可证 | MIT |')
$md.Add('| 来源 URL | ' + $SourceUrl + ' |')
$md.Add('| 上游仓库 | ' + $UpstreamUrl + ' |')
$md.Add('| 同步脚本 | scripts/sync-vendor.ps1 |')
$md.Add('| 生成时间 | ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' |')
$md.Add('')
$md.Add('## 同步与校验命令')
$md.Add('')
$md.Add('    # 方式一：用 package.json 里锁定的版本（需要先 pnpm install）')
$md.Add('    pwsh -File scripts/sync-vendor.ps1')
$md.Add('')
$md.Add('    # 方式二：直接从 npm 下载 tgz 解包，不需要 pnpm/node')
$md.Add('    pwsh -File scripts/sync-vendor.ps1 -Download')
$md.Add('')
$md.Add('    # 校验（比对下面「校验基线」里的文件数与字节数）')
$md.Add('    pwsh -File scripts/sync-vendor.ps1 -VerifyOnly')
$md.Add('')
$md.Add('## 目录结构')
$md.Add('')
$md.Add('- nunt-shoelace.js        本仓库生成的入口（import 选中的组件 + setBasePath）')
$md.Add('- components/<name>/      组件实现（只包含选中的组件）')
$md.Add('- chunks/                 Rollup 共享 chunk（按相对导入闭包裁剪）')
$md.Add('- utilities/ internal/    base-path、icon-library 等内部工具')
$md.Add('- themes/light.css dark.css  设计 token（浅色在 :root，深色在 .sl-theme-dark）')
$md.Add('- assets/icons/*.svg     用到的 Bootstrap Icons 图标')
$md.Add('')
$md.Add('## 组件清单（' + $Components.Count + ' 个）')
$md.Add('')
$md.Add('    ' + ($Components -join ', '))
$md.Add('')
$md.Add('为什么用 cdn/ 而不是 dist/：')
$md.Add('')
$md.Add('- dist/ 的文件里保留了 from "lit"、from "@shoelace-style/localize" 这类裸模块说明符，')
$md.Add('  浏览器无法解析，需要打包器或 import map；')
$md.Add('- 后台 CSP 是 script-src ''self''，内联 import map（<script type="importmap">）会被拦截，')
$md.Add('  外链 import map 浏览器也还不支持，所以「零构建 + 零 CSP 变更」只剩下唯一一条路：')
$md.Add('  用上游已经内联好依赖的 cdn/ 构建；')
$md.Add('- 代价：cdn/chunks 比 dist/chunks 大（lit 被内联进 chunk），整棵树 640KiB / gzip 187KiB 量级。')
$md.Add('')
$md.Add('同步脚本会把「树里不允许出现裸模块说明符」当作硬校验，出现即失败。')
$md.Add('')
$md.Add('说明：Shoelace 2.x 没有表格组件（sl-table 不存在），表格继续用原生 <table> + 设计 token；')
$md.Add('「toast」也没有独立组件，用 <sl-alert toast> 实现。')
$md.Add('')
$md.Add('## 图标清单（' + $iconList.Count + ' 个）')
$md.Add('')
$md.Add('    ' + ($iconList -join ', '))
$md.Add('')
$md.Add('完整图标集（2050 个 SVG）未全部 vendor：那会让仓库和二进制多出约 1.6MB。')
$md.Add('需要新图标时把它加到 sync-vendor.ps1 的 -Icons 列表后重跑；要整套就加 -AllIcons。')
$md.Add('')
$md.Add('## 体积')
$md.Add('')
$md.Add('| 范围 | 文件数 | 未压缩 | gzip 估算 |')
$md.Add('| --- | --- | --- | --- |')
$md.Add('| 整个 vendor/shoelace | ' + $stats.Files + ' | ' + $stats.Bytes + ' 字节（' + [math]::Round($stats.Bytes / 1024, 1) + ' KiB） | ' + $stats.Gzip + ' 字节（' + [math]::Round($stats.Gzip / 1024, 1) + ' KiB） |')
$md.Add('| 其中 components/ | ' + $jsStats.Files + ' | ' + $jsStats.Bytes + ' 字节 | ' + $jsStats.Gzip + ' 字节 |')
$md.Add('| 其中 assets/icons/ | ' + $iconStats.Files + ' | ' + $iconStats.Bytes + ' 字节 | ' + $iconStats.Gzip + ' 字节 |')
$md.Add('')
$md.Add('## 校验基线（-VerifyOnly 比对用，请勿手工修改）')
$md.Add('')
$md.Add('version=' + $Version)
$md.Add('files=' + $stats.Files)
$md.Add('bytes=' + $stats.Bytes)
$md.Add('gzip=' + $stats.Gzip)
$md.Add('icons=' + $iconList.Count)
$md.Add('components=' + $Components.Count)
$md.Add('generated=' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'))
[System.IO.File]::WriteAllText($versionFile, ([string]::Join([char]10, $md) + [char]10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '--- 同步结果 ---'
Write-Host ('目标目录：' + $Dest)
Write-Host ('文件数：' + $stats.Files + '（其中组件 JS ' + $jsStats.Files + '，图标 ' + $iconStats.Files + '）')
Write-Host ('未压缩：' + $stats.Bytes + ' 字节（' + [math]::Round($stats.Bytes / 1024, 1) + ' KiB）')
Write-Host ('gzip 估算：' + $stats.Gzip + ' 字节（' + [math]::Round($stats.Gzip / 1024, 1) + ' KiB）')
Write-Host ('VERSION.md：' + $versionFile)
Write-Host '校验：pwsh -File scripts/sync-vendor.ps1 -VerifyOnly'
