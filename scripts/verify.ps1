# verify.ps1 - full local verification of the nunt tree.
#
#   pwsh -File scripts/verify.ps1
#
# It formats, builds, vets and tests every package and cross compiles the
# targets the release workflow produces.

param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GOMODCACHE) { $env:GOMODCACHE = Join-Path $root '.gocache\mod' }
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $root '.gocache\build' }
if (-not $env:GOPATH) { $env:GOPATH = Join-Path $root '.gocache\gopath' }
$env:GOFLAGS = '-mod=mod'
$env:GOTOOLCHAIN = 'auto'

function Step($name, [scriptblock]$body) {
  Write-Host ""
  Write-Host "== $name" -ForegroundColor Cyan
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE" }
}

Step 'gofmt' {
  # Only the project sources: .gocache holds third party modules.
  $unformatted = gofmt -l ./cmd ./internal 2>$null
  if ($unformatted) { Write-Host "unformatted files:"; $unformatted; exit 1 }
}

Step 'vet' { go vet ./... }
if (-not $SkipTests) { Step 'test' { go test ./... -count=1 } }

Step 'build' {
  $ldflags = "-s -w -X github.com/nunt/nunt/internal/version.Version=dev -X github.com/nunt/nunt/internal/version.Commit=local -X github.com/nunt/nunt/internal/version.BuildTime=unknown"
  New-Item -ItemType Directory -Force -Path dist | Out-Null
  foreach ($target in @(
      @{ os = 'linux'; arch = 'amd64'; name = 'nunt-linux-amd64' },
      @{ os = 'linux'; arch = 'arm64'; name = 'nunt-linux-arm64' },
      @{ os = 'windows'; arch = 'amd64'; name = 'nunt-windows-amd64.exe' })) {
    Write-Host "building $($target.name)"
    $env:CGO_ENABLED = '0'
    $env:GOOS = $target.os
    $env:GOARCH = $target.arch
    go build -trimpath -tags nomsgpack -ldflags $ldflags -o (Join-Path dist $target.name) ./cmd/nunt
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "all checks passed" -ForegroundColor Green
