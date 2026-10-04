# ============================================================================
# Build the Windows installer (NSIS) for VaultHub Desktop.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# BOM-less .ps1 files as ANSI, which garbles non-ASCII text and breaks parsing.
#
# Three environment quirks handled below:
#   1) The host sets ELECTRON_RUN_AS_NODE=1, which turns electron.exe into plain
#      Node. It must be cleared before any Electron invocation.
#   2) There is no global `pnpm` command, but electron-builder runs
#      `pnpm list --prod --json` to collect production deps -> .shim\pnpm.cmd.
#   3) electron-builder 26.17.0 calls @electron/get's ElectronDownloadCacheMode
#      while declaring @electron/get@^3.0.0 (which lacks that export), so it
#      throws "Cannot read properties of undefined (reading 'ReadWrite')".
#      electronDist points at our locally verified Electron unpack dir instead.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
# ============================================================================

$ErrorActionPreference = 'Stop'

$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

$NodeDir = 'C:\Users\Enged\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$NodeExe = Join-Path $NodeDir 'node.exe'

Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "$proj\.shim;$NodeDir;$env:PATH"

# NSIS uses !tempfile at compile time; if TEMP is not writable it aborts with
# "!tempfile: Unable to create temporary file!". Point it at a project-local dir.
$TmpDir = Join-Path $proj '.tmp'
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$env:TEMP = $TmpDir
$env:TMP = $TmpDir

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = Join-Path $proj '.cache\electron-builder'
$env:npm_config_registry = 'https://registry.npmmirror.com'
New-Item -ItemType Directory -Force -Path $env:ELECTRON_BUILDER_CACHE | Out-Null

Write-Host '=== 1/4 check pnpm shim ===' -ForegroundColor Cyan
if (-not (Test-Path '.shim\pnpm.cmd')) {
  throw 'Missing .shim\pnpm.cmd (electron-builder needs a pnpm command)'
}
& pnpm --version

Write-Host '=== 2/4 check Electron binary ===' -ForegroundColor Cyan
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
  Write-Host '  not found; fetching with SHA256 verification' -ForegroundColor Yellow
  & $NodeExe 'scripts\fetch-electron.cjs'
} else {
  $sz = [math]::Round((Get-Item 'node_modules\electron\dist\electron.exe').Length / 1MB, 1)
  Write-Host "  ready (electron.exe $sz MiB)"
}

Write-Host '=== 3/4 clean previous output ===' -ForegroundColor Cyan
Remove-Item 'dist' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '=== 4/4 electron-builder ===' -ForegroundColor Cyan
& "$proj\node_modules\.bin\electron-builder.CMD" --win nsis --config electron-builder.yml
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host '=== artifacts ===' -ForegroundColor Green
  Get-ChildItem 'dist' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.exe', '.blockmap', '.yml' } |
    Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
    Format-Table -AutoSize
} else {
  Write-Host "build failed, exit code $code" -ForegroundColor Red
}
exit $code
