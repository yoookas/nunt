# smoke.ps1 - start the built binary against a throwaway data directory and
# exercise the admin API plus the embedded UI.
#
#   pwsh -File scripts/smoke.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GOMODCACHE) { $env:GOMODCACHE = Join-Path $root '.gocache\mod' }
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $root '.gocache\build' }
if (-not $env:GOPATH) { $env:GOPATH = Join-Path $root '.gocache\gopath' }
$env:GOFLAGS = '-mod=mod'
$env:GOTOOLCHAIN = 'auto'

$port = 3113
$dataDir = Join-Path $env:TEMP ('nunt-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "== building"
go build -trimpath -o (Join-Path $dataDir 'nunt.exe') ./cmd/nunt
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$out = Join-Path $dataDir 'stdout.log'
$err = Join-Path $dataDir 'stderr.log'
Write-Host "== starting on port $port (data: $dataDir)"
$proc = Start-Process -FilePath (Join-Path $dataDir 'nunt.exe') -ArgumentList @('-d', $dataDir, '-log-level', 'info') `
  -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

try {
  $base = "http://127.0.0.1:$port"
  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "$base/healthz" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $ready) { throw "service did not become ready; log: $(Get-Content $out -Raw)" }

  $password = $null
  foreach ($line in Get-Content $out) {
    if ($line -match 'Administrator pass\s*:\s*(\S+)') { $password = $Matches[1] }
  }
  if (-not $password) { throw "could not read the generated password from $out" }
  Write-Host "== generated password captured"

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-RestMethod -Uri "$base/api/v1/auth/login" -Method Post -WebSession $session `
    -ContentType 'application/json' -Body (@{ username = 'admin'; password = $password } | ConvertTo-Json)
  $csrf = $login.csrf
  Write-Host "== signed in"

  $headers = @{ 'X-CSRF-Token' = $csrf }
  foreach ($path in @('/api/v1/system/info', '/api/v1/modules', '/api/v1/web/rules', '/api/v1/forward/rules',
      '/api/v1/ddns/rules', '/api/v1/ddns/providers', '/api/v1/acme/certificates', '/api/v1/waf/config',
      '/api/v1/storage/mounts', '/api/v1/auth/sessions')) {
    try {
      $null = Invoke-RestMethod -Uri "$base$path" -WebSession $session -Headers $headers
      Write-Host ("  OK   " + $path)
    } catch {
      Write-Host ("  FAIL " + $path + " -> " + $_.Exception.Message) -ForegroundColor Red
    }
  }

  $shell = Invoke-WebRequest -UseBasicParsing "$base/" -WebSession $session
  if ($shell.Content -notmatch 'id="app"') { throw 'the admin shell is not the Vue app' }
  $bundle = [regex]::Match($shell.Content, 'src="(/static/[^"]+\.js)"')
  if (-not $bundle.Success) { throw 'the admin shell references no script bundle' }
  foreach ($asset in @('/', $bundle.Groups[1].Value)) {
    $r = Invoke-WebRequest -Uri "$base$asset" -UseBasicParsing
    Write-Host ("  GET  " + $asset + " -> " + $r.StatusCode + " (" + $r.RawContentLength + " bytes)")
  }

  # Create a static rule through the API and fetch the file.
  $www = Join-Path $dataDir 'www'
  New-Item -ItemType Directory -Force -Path $www | Out-Null
  Set-Content -Path (Join-Path $www 'hello.txt') -Value 'hello from smoke test' -NoNewline
  $webPort = 18080
  $rule = @{
    name    = 'smoke'
    enable  = $true
    type    = 'static'
    listen  = @("127.0.0.1:$webPort")
    path    = '/'
    tls     = @{ mode = 'off' }
    access  = @{ mode = 'off'; uaMode = 'off' }
    static  = @{ root = $www; listing = $true; index = @('index.html') }
  } | ConvertTo-Json -Depth 6
  $created = Invoke-RestMethod -Uri "$base/api/v1/web/rules" -Method Post -WebSession $session -Headers $headers `
    -ContentType 'application/json' -Body $rule
  Write-Host ("== created web rule " + $created.id)
  Start-Sleep -Seconds 1
  $page = Invoke-WebRequest -Uri "http://127.0.0.1:$webPort/hello.txt" -UseBasicParsing
  Write-Host ("  static rule served: " + $page.StatusCode + " '" + $page.Content + "'")

  Write-Host ""
  Write-Host "smoke test passed" -ForegroundColor Green
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Write-Host "data dir kept for inspection: $dataDir"
}
