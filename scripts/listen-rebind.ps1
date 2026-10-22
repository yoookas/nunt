# listen-rebind.ps1 - 真机验证「控制台里改监听地址，保存后立即生效」。
#
# 流程（每一步都打印 HTTP 状态与关键输出）：
#   1. 全新数据目录启动二进制，确认默认监听端口是 3113；
#   2. 登录，用同一个会话拿到 /api/v1/modules（200）；
#   3. 先占用 3199，再保存 127.0.0.1:3199 -> 期望 409 + 「端口 3199 已被占用」，旧端口仍可用；
#   4. 释放 3199，再保存 -> 期望 200 + adminListen=127.0.0.1:3199，旧端口关闭，
#      新端口可访问，且**同一个会话 cookie** 仍能拉到 /api/v1/modules；
#   5. 从新端口把地址改回 :3113 -> 新端口关闭，3113 恢复，会话仍然有效。
#
#   pwsh -File scripts/listen-rebind.ps1
#   pwsh -File scripts/listen-rebind.ps1 -KeepData
param(
  [int]$DefaultPort = 3113,
  [int]$TargetPort = 3199,
  [string]$ExePath = '',
  [switch]$KeepData
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GOMODCACHE) { $env:GOMODCACHE = Join-Path $root '.gocache\mod' }
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $root '.gocache\build' }
if (-not $env:GOPATH) { $env:GOPATH = Join-Path $root '.gocache\gopath' }
$env:GOFLAGS = '-mod=mod'
$env:GOTOOLCHAIN = 'auto'

# 二进制与数据目录都放在仓库的 .gocache 下（已 gitignore）。
# 不放进 %TEMP%：本机装了 360 主动防御，它偶尔会静默结束「刚从 %TEMP% 构建并启动」的
# 未签名二进制（exit code 0、stderr 为空），与程序行为无关，放在仓库目录下可避免误判。
$workDir = Join-Path $root '.gocache\listen-rebind'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
if (-not $ExePath) { $ExePath = Join-Path $workDir 'nunt.exe' }
$dataDir = Join-Path $workDir ([guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Port-InUse([int]$port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $client.Connect('127.0.0.1', $port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-PortFree([int]$port, [int]$seconds = 15) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Port-InUse $port)) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "端口 $port 在 $seconds 秒内没有关闭"
}

function Wait-Ready([string]$url, [int]$seconds = 40) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $last = '(没有发起过请求)'
  while ((Get-Date) -lt $deadline) {
    if ($script:appProc -and $script:appProc.HasExited) {
      throw "进程已退出（exit code $($script:appProc.ExitCode)），无法访问 $url"
    }
    try {
      $resp = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -eq 200) { return }
      $last = "HTTP $($resp.StatusCode)"
    } catch {
      $last = $_.Exception.Message
      Start-Sleep -Milliseconds 200
    }
  }
  throw "服务没有在 $seconds 秒内就绪：$url（最后一次错误：$last）"
}

# Get-Status 用同一个 WebSession（cookie）访问，返回 HTTP 状态码，失败时返回 0。
function Get-Status([string]$url, $session) {
  try {
    return (Invoke-WebRequest $url -WebSession $session -UseBasicParsing -TimeoutSec 3).StatusCode
  } catch {
    return 0
  }
}

function Read-Password([string]$path) {
  $password = $null
  foreach ($line in Get-Content $path) {
    if ($line -match 'Administrator pass\s*:\s*(\S+)') { $password = $Matches[1] }
  }
  if (-not $password) { throw "没有从 $path 读到初始管理员密码" }
  return $password
}

function Set-AdminListen([string]$base, $session, $headers, [string]$addr) {
  $settings = Invoke-RestMethod "$base/api/v1/system/settings" -WebSession $session
  $settings.adminListen = $addr
  $body = $settings | ConvertTo-Json -Depth 6
  return Invoke-WebRequest "$base/api/v1/system/settings" -Method Put -WebSession $session -Headers $headers -ContentType 'application/json' -Body $body
}

foreach ($port in @($DefaultPort, $TargetPort)) {
  if (Port-InUse $port) { throw "端口 $port 已被占用，验证脚本需要干净端口" }
}

Write-Host "== 构建"
go build -trimpath -o $ExePath ./cmd/nunt
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$out = Join-Path $dataDir 'stdout.log'
$err = Join-Path $dataDir 'stderr.log'
Write-Host "== 启动（全新数据目录的默认配置）"
$proc = Start-Process -FilePath $ExePath -ArgumentList @('-d', $dataDir, '-log-level', 'debug') `
  -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden
$script:appProc = $proc

try {
  $base = "http://127.0.0.1:$DefaultPort"
  Wait-Ready "$base/healthz"
  $listenLine = Select-String -Path $out -Pattern 'admin interface listening' | Select-Object -First 1
  Write-Host ("   启动日志: " + $listenLine.Line.Trim())
  $cfg = Get-Content (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
  Write-Host ("   config.json system.adminListen = " + $cfg.system.adminListen)
  if ($cfg.system.adminListen -ne ":$DefaultPort") { throw "默认监听地址不是 :$DefaultPort" }

  $password = Read-Password $out
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-RestMethod "$base/api/v1/auth/login" -Method Post -WebSession $session `
    -ContentType 'application/json' -Body (@{ username = 'admin'; password = $password } | ConvertTo-Json)
  $headers = @{ 'X-CSRF-Token' = $login.csrf }
  Write-Host "== 登录成功"
  $before = Get-Status "$base/api/v1/modules" $session
  Write-Host "   GET $base/api/v1/modules -> $before （同一会话）"
  if ($before -ne 200) { throw '登录后的会话不可用' }

  Write-Host "== 失败路径：先占用 $TargetPort 再切过去"
  $blocker = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $TargetPort)
  $blocker.Start()
  try {
    try {
      $null = Set-AdminListen $base $session $headers "127.0.0.1:$TargetPort"
      throw '目标端口被占用时保存不应成功'
    } catch {
      $status = [int]$_.Exception.Response.StatusCode
      # ErrorDetails.Message 是 PowerShell 重新序列化后的 JSON（非 ASCII 会变成
      # \uXXXX），先解析回对象再取 message，输出的就是后端原样的中文。
      $decoded = $_.ErrorDetails.Message
      try { $decoded = ($_.ErrorDetails.Message | ConvertFrom-Json).error.message } catch { }
      Write-Host "   PUT $base/api/v1/system/settings -> HTTP $status"
      Write-Host "   message: $decoded"
      if ($status -ne 409) { throw "期望 409，实际 $status" }
      if ($decoded -notmatch '已被占用') { throw "错误信息没有指出端口被占用：$decoded" }
    }
  } finally {
    $blocker.Stop()
  }
  $still = Get-Status "$base/api/v1/modules" $session
  Write-Host "   旧监听仍然可用: GET $base/api/v1/modules -> $still"
  if ($still -ne 200) { throw '失败路径破坏了旧监听' }

  Write-Host "== 成功路径：切到 127.0.0.1:$TargetPort"
  $resp = Set-AdminListen $base $session $headers "127.0.0.1:$TargetPort"
  $saved = $resp.Content | ConvertFrom-Json
  Write-Host "   PUT $base/api/v1/system/settings -> HTTP $($resp.StatusCode)"
  Write-Host "   adminListen=$($saved.adminListen) source=$($saved.adminListenSource) applied=$($saved.adminListenApplied)"
  if ($resp.StatusCode -ne 200) { throw "切换失败：HTTP $($resp.StatusCode)" }
  if ($saved.adminListen -ne "127.0.0.1:$TargetPort") { throw "返回的生效地址不对：$($saved.adminListen)" }

  Wait-PortFree $DefaultPort
  Write-Host "   旧端口 $DefaultPort 已关闭"
  $newBase = "http://127.0.0.1:$TargetPort"
  try {
    Wait-Ready "$newBase/healthz"
  } catch {
    Write-Host "   --- 诊断 ---"
    Write-Host ("   进程存活: " + (-not $proc.HasExited))
    netstat -ano | Select-String ":$DefaultPort|:$TargetPort" | ForEach-Object { Write-Host ("   " + $_.Line.Trim()) }
    Write-Host ("   curl: " + (curl.exe -s -m 3 -o NUL -w '%{http_code}' "$newBase/healthz"))
    Get-Content $out -Tail 12 | ForEach-Object { Write-Host ("   log| " + $_) }
    Get-Content $err -Tail 8 | ForEach-Object { Write-Host ("   err| " + $_) }
    throw
  }
  $health = Get-Status "$newBase/healthz" $session
  $modules = Get-Status "$newBase/api/v1/modules" $session
  Write-Host "   GET $newBase/healthz -> $health"
  Write-Host "   同一会话 GET $newBase/api/v1/modules -> $modules"
  if ($modules -ne 200) { throw '重绑后会话失效（cookie 不再有效）' }
  $info = Invoke-RestMethod "$newBase/api/v1/system/info" -WebSession $session
  Write-Host "   system/info: adminListen=$($info.adminListen) config=$($info.adminListenConfig) source=$($info.adminListenSource)"
  if ($info.adminListen -ne "127.0.0.1:$TargetPort") { throw "system/info 没有跟随重绑：$($info.adminListen)" }

  Write-Host "== 改回 :$DefaultPort"
  $resp = Set-AdminListen $newBase $session $headers ":$DefaultPort"
  $back = $resp.Content | ConvertFrom-Json
  Write-Host "   PUT $newBase/api/v1/system/settings -> HTTP $($resp.StatusCode)"
  Write-Host "   adminListen=$($back.adminListen) source=$($back.adminListenSource) applied=$($back.adminListenApplied)"
  if ($resp.StatusCode -ne 200 -or $back.adminListen -ne ":$DefaultPort") { throw '改回默认端口失败' }
  Wait-PortFree $TargetPort
  Write-Host "   $TargetPort 已关闭"
  $restored = Get-Status "$base/api/v1/modules" $session
  Write-Host "   同一会话 GET $base/api/v1/modules -> $restored"
  if ($restored -ne 200) { throw '改回默认端口后会话失效' }

  Write-Host ""
  Write-Host "listen rebind check passed" -ForegroundColor Green
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  if ($KeepData) {
    Write-Host "data dir kept: $dataDir"
  } else {
    Remove-Item -Recurse -Force -Path $dataDir -ErrorAction SilentlyContinue
  }
}
