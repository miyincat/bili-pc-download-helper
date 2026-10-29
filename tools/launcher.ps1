# Bilibili Downloader - launcher (PowerShell edition).
#
# 1) make sure the helper is running (start the supervisor hidden if not)
# 2) open the client through Explorer + a .lnk that carries the debug port
#
# Why Explorer: this client silently refuses to start when launched directly
# via CreateProcess/Start-Process; only the shell path works. Explorer cannot
# pass arguments to a bare exe, so tools\client-cdp.lnk holds them.

$ErrorActionPreference = 'SilentlyContinue'

$tools = Split-Path -Parent $MyInvocation.MyCommand.Path
$root  = Split-Path -Parent $tools
$lnk   = Join-Path $tools 'client-cdp.lnk'
$sup   = Join-Path $tools 'supervisor.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Test-ServerAlive {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:8765/api/health' -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (-not (Test-ServerAlive)) {
  # Start the supervisor through its own shortcut so Explorer is its parent.
  # (A supervisor started from another process dies together with that process.)
  $supLnk = Join-Path $tools 'supervisor.lnk'
  if (Test-Path $supLnk) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$supLnk`""
  } else {
    Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$sup`""
    )
  }
  Start-Sleep -Seconds 3
}

if (Test-Path $lnk) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$lnk`""
} else {
  # Fallback: run the shortcut that the user sees, if our own .lnk is missing.
  $scripts = Split-Path -Parent (Split-Path -Parent $tools)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Missing tools\client-cdp.lnk - please run the installer again.",
    'Bilibili Downloader'
  ) | Out-Null
}
