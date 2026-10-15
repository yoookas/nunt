#Requires -Version 7.0
<#
.SYNOPSIS
  把 Lit 同步（vendor）到 internal/webui/assets/vendor/lit/。

.DESCRIPTION
  来源包：lit（npm，MIT），版本与 @shoelace-style/shoelace 的依赖一致（lit 3.x）。
  上游仓库：https://github.com/lit/lit

  为什么需要单独一份 vendor：
    Shoelace 的 cdn 构建把 lit 内联进了 hash 命名的 chunk，没有稳定的公开导出
    （chunk 只导出 t/e/r 这样的压缩名），下游无法复用；而 dist 构建保留
    from "lit" 这样的裸模块说明符，浏览器在 script-src 'self' 下既不能解析，
    也不能用内联 import map。所以自研组件（lib/kit.js）需要一个「相对路径、
    浏览器可直接当 ESM 加载」的 lit 副本。

  这个脚本做三件事：
    1. 按固定清单从 node_modules 拷贝 lit / lit-element / lit-html /
       @lit/reactive-element 里真正用到的文件（不是整包）；
    2. 把跨包的裸模块说明符改写成同目录的相对路径，并去掉 sourceMappingURL
       （源码映射文件没有一起 vendor，留着只会让 devtools 去请求不存在的文件）；
    3. 写 VERSION.md 记录版本/许可证/来源/体积，并校验「树里没有裸模块说明符」
       「相对导入全部落在 vendor 目录内」。

  用法：
    pwsh -File scripts/sync-lit.ps1               # 从 node_modules 拷贝（先 pnpm install）
    pwsh -File scripts/sync-lit.ps1 -VerifyOnly   # 只校验磁盘结果与 VERSION.md 基线
#>
[CmdletBinding()]
param(
  [string]$Version = '3.3.3',
  [string]$Dest = '',
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$UpstreamUrl = 'https://github.com/lit/lit'
if (-not $Dest) { $Dest = Join-Path $RepoRoot 'internal/webui/assets/vendor/lit' }

# 固定清单：只需要 LitElement 基类 + html/nothing + repeat/ifDefined/classMap。
# （repeat 依赖 directive/directive-helpers，classMap 依赖 directive。）
$Files = @(
  [pscustomobject]@{ Pkg = 'lit';                     Src = 'index.js';                 Dst = 'index.js' },
  [pscustomobject]@{ Pkg = 'lit-element';             Src = 'lit-element.js';           Dst = 'lit-element.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'lit-html.js';              Dst = 'lit-html.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'is-server.js';             Dst = 'is-server.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'directive.js';             Dst = 'directive.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'directive-helpers.js';     Dst = 'directive-helpers.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'directives/repeat.js';     Dst = 'directives/repeat.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'directives/if-defined.js'; Dst = 'directives/if-defined.js' },
  [pscustomobject]@{ Pkg = 'lit-html';                Src = 'directives/class-map.js';  Dst = 'directives/class-map.js' },
  [pscustomobject]@{ Pkg = '@lit/reactive-element';   Src = 'reactive-element.js';      Dst = 'reactive-element.js' },
  [pscustomobject]@{ Pkg = '@lit/reactive-element';   Src = 'css-tag.js';               Dst = 'css-tag.js' }
)

# 跨包裸说明符 -> vendor 目录内的相对路径（只有 lit/index.js 与 lit-element.js 用得到）。
$Rewrites = @(
  [pscustomobject]@{ Pattern = '@lit/reactive-element';      Target = './reactive-element.js' },
  [pscustomobject]@{ Pattern = 'lit-element/lit-element.js'; Target = './lit-element.js' },
  [pscustomobject]@{ Pattern = 'lit-html/is-server.js';      Target = './is-server.js' },
  [pscustomobject]@{ Pattern = 'lit-html';                   Target = './lit-html.js' }
)

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

# 找出一个文件里所有相对导入（改写之后，vendor 树里应该只有相对导入）。
function Get-RelativeImports {
  param([string]$Path)
  $text = [System.IO.File]::ReadAllText($Path)
  $text = $text.Replace([string][char]10, ' ').Replace([string][char]13, ' ').Replace([string][char]9, ' ')
  $rx = [regex]"(?:from |import |import[(])['""]([.][^'""]*)['""]"
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($m in $rx.Matches($text)) { $out.Add($m.Groups[1].Value) }
  return $out
}

# vendor 树里不允许出现裸模块说明符（浏览器解析不了，CSP 也不允许 import map）。
function Assert-NoBareSpecifiers {
  param([string]$Path)
  $bareRx = [regex]"(?:from |import |import[(])[""]([^.""/][^""]*)[""]"
  $hits = New-Object System.Collections.Generic.List[string]
  foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File -Filter '*.js') {
    $t = [System.IO.File]::ReadAllText($f.FullName).Replace([string][char]10, ' ')
    foreach ($m in $bareRx.Matches($t)) {
      $spec = $m.Groups[1].Value
      if ($spec -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*:') {
        $hits.Add($f.FullName.Substring($Path.Length + 1) + ' -> ' + $spec)
      }
    }
  }
  if ($hits.Count -gt 0) { throw ('vendor 树里出现裸模块说明符：' + [char]10 + ($hits -join [char]10)) }
}

function Assert-RelativeImportsResolve {
  param([string]$Path)
  $problems = New-Object System.Collections.Generic.List[string]
  $prefix = $Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  foreach ($f in Get-ChildItem -LiteralPath $Path -Recurse -File -Filter '*.js') {
    $dir = Split-Path -Parent $f.FullName
    foreach ($imp in Get-RelativeImports -Path $f.FullName) {
      $target = [System.IO.Path]::GetFullPath((Join-Path $dir $imp))
      if (-not (Test-Path -LiteralPath $target)) {
        $problems.Add($f.Name + ' -> ' + $imp)
      } elseif (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $problems.Add($f.Name + ' -> ' + $imp + '（跑到 vendor 目录外）')
      }
    }
  }
  if ($problems.Count -gt 0) { throw ('相对导入无法解析：' + [char]10 + ($problems -join [char]10)) }
}

$versionFile = Join-Path $Dest 'VERSION.md'

# ---------------------------------------------------------------------------
# 校验模式
# ---------------------------------------------------------------------------

if ($VerifyOnly) {
  if (-not (Test-Path -LiteralPath $versionFile)) { throw ('缺少 ' + $versionFile + '，先跑一次不带 -VerifyOnly 的同步') }
  $stats = Get-DirStats -Path $Dest -Exclude @('VERSION.md')
  $recorded = @{}
  foreach ($line in Get-Content -LiteralPath $versionFile) {
    if ($line -match '^(files|bytes|gzip|version)=(.+)$') { $recorded[$Matches[1]] = $Matches[2].Trim() }
  }
  $missing = @()
  foreach ($f in $Files) { if (-not (Test-Path -LiteralPath (Join-Path $Dest $f.Dst))) { $missing += $f.Dst } }
  $problems = New-Object System.Collections.Generic.List[string]
  if ($recorded['version'] -ne $Version) { $problems.Add('版本不一致：VERSION.md=' + $recorded['version'] + ' 脚本=' + $Version) }
  if ([int64]$recorded['files'] -ne $stats.Files) { $problems.Add('文件数不一致：磁盘=' + $stats.Files + ' 记录=' + $recorded['files']) }
  if ([int64]$recorded['bytes'] -ne $stats.Bytes) { $problems.Add('字节数不一致：磁盘=' + $stats.Bytes + ' 记录=' + $recorded['bytes']) }
  foreach ($m in $missing) { $problems.Add('缺少文件：' + $m) }
  Assert-NoBareSpecifiers -Path $Dest
  Assert-RelativeImportsResolve -Path $Dest
  Write-Host ('磁盘：文件 ' + $stats.Files + ' 个，' + $stats.Bytes + ' 字节，gzip 估算 ' + $stats.Gzip + ' 字节')
  Write-Host ('记录：文件 ' + $recorded['files'] + ' 个，' + $recorded['bytes'] + ' 字节，gzip 估算 ' + $recorded['gzip'] + ' 字节')
  if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host ('  [x] ' + $p) }
    throw 'lit vendor 校验失败'
  }
  Write-Host '  [ok] lit vendor 目录与 VERSION.md 记录一致'
  exit 0
}

# ---------------------------------------------------------------------------
# 定位来源（pnpm 布局：node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>）
# ---------------------------------------------------------------------------

function Resolve-PackageRoot {
  param([string]$Pkg)
  $flat = Join-Path $RepoRoot ('node_modules/' + $Pkg)
  if (Test-Path -LiteralPath (Join-Path $flat 'package.json')) { return $flat }
  $dirName = ($Pkg -replace '/', '+') + '@' + $Version
  $candidate = Join-Path $RepoRoot ('.pnpm/' + $dirName + '/node_modules/' + $Pkg)
  if (Test-Path -LiteralPath (Join-Path $candidate 'package.json')) { return $candidate }
  $found = Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'node_modules/.pnpm') -Directory -Filter (($Pkg -replace '/', '+') + '@*') -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($found) {
    $candidate = Join-Path $found.FullName ('node_modules/' + $Pkg)
    if (Test-Path -LiteralPath (Join-Path $candidate 'package.json')) { return $candidate }
  }
  throw ('找不到包 ' + $Pkg + '：先运行 pnpm install（lit 是 @shoelace-style/shoelace 的依赖，装完之后就在 .pnpm 里）')
}

$roots = @{}
foreach ($f in $Files) {
  if (-not $roots.ContainsKey($f.Pkg)) { $roots[$f.Pkg] = Resolve-PackageRoot -Pkg $f.Pkg }
}

Write-Host ('来源：' + (($roots.Keys | Sort-Object) -join ', '))

if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in $Files) {
  $src = Join-Path $roots[$f.Pkg] ($f.Src.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  if (-not (Test-Path -LiteralPath $src)) { throw ('来源文件不存在：' + $src) }
  $text = [System.IO.File]::ReadAllText($src)
  foreach ($r in $Rewrites) {
    # 只改 import / from / import( 后面的字符串字面量，避免误伤压缩代码里的同名子串。
    $rx = "(?<=(?:from|import|import\())[""']" + [regex]::Escape($r.Pattern) + "[""']"
    $text = [regex]::Replace($text, $rx, '"' + $r.Target + '"')
  }
  # 源码映射没有一起 vendor，去掉引用，避免 devtools 去请求不存在的 .map。
  $text = [regex]::Replace($text, '//# sourceMappingURL=[^\r\n]*', '')
  $lines = [regex]::Split($text, "\r?\n") | Where-Object { $_.Trim().Length -gt 0 }
  $dst = Join-Path $Dest ($f.Dst.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($dst, ([string]::Join([char]10, $lines) + [char]10), $utf8)
}

Assert-NoBareSpecifiers -Path $Dest
Assert-RelativeImportsResolve -Path $Dest
Write-Host ('校验：' + $Files.Count + ' 个文件里没有裸模块说明符，相对导入全部可解析')

$stats = Get-DirStats -Path $Dest -Exclude @('VERSION.md')
$md = New-Object System.Collections.Generic.List[string]
$md.Add('# Lit vendor 快照')
$md.Add('')
$md.Add('这个目录是 vendor 进来的第三方代码，不要手改；升级请跑同步脚本。')
$md.Add('')
$md.Add('| 项 | 值 |')
$md.Add('| --- | --- |')
$md.Add('| 包名 | lit（含 lit-element / lit-html / @lit/reactive-element） |')
$md.Add('| 版本 | ' + $Version + '（固定版本，与 Shoelace 2.20.1 的依赖一致） |')
$md.Add('| 许可证 | MIT |')
$md.Add('| 上游仓库 | ' + $UpstreamUrl + ' |')
$md.Add('| 同步脚本 | scripts/sync-lit.ps1 |')
$md.Add('| 生成时间 | ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' |')
$md.Add('')
$md.Add('## 同步与校验命令')
$md.Add('')
$md.Add('    pwsh -File scripts/sync-lit.ps1')
$md.Add('    pwsh -File scripts/sync-lit.ps1 -VerifyOnly')
$md.Add('')
$md.Add('## 文件清单（' + $Files.Count + ' 个）')
$md.Add('')
$md.Add('| 目标 | 来源 |')
$md.Add('| --- | --- |')
foreach ($f in $Files) { $md.Add('| ' + $f.Dst + ' | ' + $f.Pkg + '/' + $f.Src + ' |') }
$md.Add('')
$md.Add('## 与上游的差异（只有两处，都是为了让浏览器直接加载）')
$md.Add('')
$md.Add('1. 跨包裸模块说明符改写成相对路径：' + (($Rewrites | ForEach-Object { $_.Pattern + ' -> ' + $_.Target }) -join '；') + '；')
$md.Add('2. 去掉 //# sourceMappingURL 注释（.map 文件没有一起 vendor）。')
$md.Add('')
$md.Add('## 体积')
$md.Add('')
$md.Add('| 范围 | 文件数 | 未压缩 | gzip 估算 |')
$md.Add('| --- | --- | --- | --- |')
$md.Add('| 整个 vendor/lit | ' + $stats.Files + ' | ' + $stats.Bytes + ' 字节（' + [math]::Round($stats.Bytes / 1024, 1) + ' KiB） | ' + $stats.Gzip + ' 字节（' + [math]::Round($stats.Gzip / 1024, 1) + ' KiB） |')
$md.Add('')
$md.Add('## 校验基线（-VerifyOnly 比对用，请勿手工修改）')
$md.Add('')
$md.Add('version=' + $Version)
$md.Add('files=' + $stats.Files)
$md.Add('bytes=' + $stats.Bytes)
$md.Add('gzip=' + $stats.Gzip)
$md.Add('generated=' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'))
[System.IO.File]::WriteAllText($versionFile, ([string]::Join([char]10, $md) + [char]10), $utf8)

Write-Host ''
Write-Host '--- 同步结果 ---'
Write-Host ('目标目录：' + $Dest)
Write-Host ('文件数：' + $stats.Files)
Write-Host ('未压缩：' + $stats.Bytes + ' 字节（' + [math]::Round($stats.Bytes / 1024, 1) + ' KiB）')
Write-Host ('gzip 估算：' + $stats.Gzip + ' 字节（' + [math]::Round($stats.Gzip / 1024, 1) + ' KiB）')
Write-Host ('VERSION.md：' + $versionFile)
Write-Host '校验：pwsh -File scripts/sync-lit.ps1 -VerifyOnly'
