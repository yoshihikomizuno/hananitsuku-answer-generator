# Render tools/ogp-source.html to images/ogp.png (1200x630) with headless Edge.
# ASCII-only on purpose: PowerShell 5.1 misreads Japanese in BOM-less files,
# so every Japanese string lives in ogp-source.html (UTF-8) instead.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'tools\ogp-source.html'
$outDir = Join-Path $root 'images'
$outPath = Join-Path $outDir 'ogp.png'

if (-not (Test-Path $source)) { throw "source not found: $source" }
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$edge = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'msedge.exe not found' }

$profile = Join-Path $env:TEMP ('ogp-shot-' + [System.Guid]::NewGuid().ToString('N'))
$uri = ([System.Uri]$source).AbsoluteUri

& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
  --window-size=1200,630 --virtual-time-budget=15000 `
  --user-data-dir="$profile" --screenshot="$outPath" $uri | Out-Null

if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
if (-not (Test-Path $outPath)) { throw 'screenshot was not created' }

$img = [System.Drawing.Image]::FromFile($outPath)
$size = '{0}x{1}' -f $img.Width, $img.Height
$img.Dispose()
Write-Output ("saved: {0} ({1}, {2} bytes)" -f $outPath, $size, (Get-Item $outPath).Length)
