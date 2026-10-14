# smoke-waf.ps1 - run the binary and exercise the A+C+E body policy for real.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $env:GOMODCACHE) { $env:GOMODCACHE = Join-Path (Get-Location) '.gocache\mod' }
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path (Get-Location) '.gocache\build' }
if (-not $env:GOPATH) { $env:GOPATH = Join-Path (Get-Location) '.gocache\gopath' }
$env:GOFLAGS = '-mod=mod'; $env:GOTOOLCHAIN = 'local'

$dataDir = Join-Path $env:TEMP ('nunt-waf-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
& go build -trimpath -o (Join-Path $dataDir 'nunt.exe') ./cmd/nunt
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
$out = Join-Path $dataDir 'stdout.log'
$proc = Start-Process -FilePath (Join-Path $dataDir 'nunt.exe') -ArgumentList @('-d', $dataDir, '-log-level', 'warn') -PassThru -RedirectStandardOutput $out -RedirectStandardError (Join-Path $dataDir 'stderr.log') -WindowStyle Hidden

function Send-Chunked([int]$Port, [string]$Path) {
  $client = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $Port)
  $stream = $client.GetStream()
  $req = "POST $Path HTTP/1.1`r`nHost: 127.0.0.1`r`nTransfer-Encoding: chunked`r`nContent-Type: application/octet-stream`r`n`r`n5`r`nhello`r`n0`r`n`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($req)
  $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
  Start-Sleep -Milliseconds 400
  $buf = New-Object byte[] 512
  $n = $stream.Read($buf, 0, 512)
  $client.Close()
  if ($n -le 0) { return '(no response)' }
  return ([Text.Encoding]::ASCII.GetString($buf, 0, $n)).Split("`r`n")[0]
}

try {
  $base = 'http://127.0.0.1:16601'
  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    try { if ((Invoke-WebRequest "$base/healthz" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $ready) { throw 'service did not start' }
  $pw = $null; foreach ($l in Get-Content $out) { if ($l -match 'Administrator pass\s*:\s*(\S+)') { $pw = $Matches[1] } }
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-RestMethod "$base/api/v1/auth/login" -Method Post -WebSession $session -ContentType 'application/json' -Body (@{ username = 'admin'; password = $pw } | ConvertTo-Json)
  $h = @{ 'X-CSRF-Token' = $login.csrf }
  $cfg = Invoke-RestMethod "$base/api/v1/waf/config" -WebSession $session -Headers $h
  "policy      : mode=$($cfg.config.enforcementMode) default=$($cfg.config.defaultBodyPolicy) peek=$($cfg.config.peekBytes)B/$($cfg.config.peekTimeoutMs)ms alert=$($cfg.config.notifyBodyRatio)"
  "bodyStates  : $($cfg.stats.bodyStates | ConvertTo-Json -Compress)"
  "counters    : wouldReject=$($cfg.stats.wouldReject) refused=$($cfg.stats.refused) undeclared=$($cfg.undeclaredRoutes.Count)"

  # The WAF engine has a global master switch; enable it so the per rule flag can work.
  $c0 = $cfg.config; $c0.enable = $true
  $null = Invoke-RestMethod "$base/api/v1/waf/config" -Method Put -WebSession $session -Headers $h -ContentType 'application/json' -Body ($c0 | ConvertTo-Json -Depth 6)
  Start-Sleep -Milliseconds 400
  $ce = Invoke-RestMethod "$base/api/v1/waf/config" -WebSession $session -Headers $h
  "engine      : enable=$($ce.config.enable) mode=$($ce.config.mode) crs=$($ce.config.useCrs) engineReady=$($ce.engine.ready)"
  $www = Join-Path $dataDir 'www'; New-Item -ItemType Directory -Force $www | Out-Null
  Set-Content (Join-Path $www 'a.txt') 'ok' -NoNewline
  $rule = @{ name = 'waf-static'; enable = $true; type = 'static'; listen = @('127.0.0.1:18081'); path = '/'; waf = $true
             tls = @{ mode = 'off' }; access = @{ mode = 'off'; uaMode = 'off' }
             static = @{ root = $www; listing = $true } } | ConvertTo-Json -Depth 6
  $null = Invoke-RestMethod "$base/api/v1/web/rules" -Method Post -WebSession $session -Headers $h -ContentType 'application/json' -Body $rule
  Start-Sleep -Milliseconds 800
  "chunked POST under observe -> $((Send-Chunked 18081 '/upload'))"
  $cfg2 = Invoke-RestMethod "$base/api/v1/waf/config" -WebSession $session -Headers $h
  "after observe : wouldReject=$($cfg2.stats.wouldReject) bodyStates=$($cfg2.stats.bodyStates | ConvertTo-Json -Compress)"

  $newCfg = $cfg2.config; $newCfg.enforcementMode = 'enforce'
  $null = Invoke-RestMethod "$base/api/v1/waf/config" -Method Put -WebSession $session -Headers $h -ContentType 'application/json' -Body ($newCfg | ConvertTo-Json -Depth 6)
  Start-Sleep -Milliseconds 400
  $cfg3 = Invoke-RestMethod "$base/api/v1/waf/config" -WebSession $session -Headers $h
  "mode now      : $($cfg3.config.enforcementMode)"
  "chunked POST under enforce -> $((Send-Chunked 18081 '/upload'))"
  $cfg4 = Invoke-RestMethod "$base/api/v1/waf/config" -WebSession $session -Headers $h
  "after enforce : wouldReject=$($cfg4.stats.wouldReject) refused=$($cfg4.stats.refused)"
  "undeclared    : $(($cfg4.undeclaredRoutes | ForEach-Object { $_.name + '(' + $_.path + ')' }) -join ', ')"
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  "data dir: $dataDir"
}
