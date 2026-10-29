# Bilibili Downloader - supervisor (PowerShell edition).
#
# Replaces the old .vbs supervisor: Windows is deprecating VBScript, and after
# a Windows update the scripted supervisor stopped being restarted.
#
# Behaviour: every 5 seconds ask the helper's own health endpoint. If it does
# not answer, (re)start node server.js hidden. Single instance by design,
# because a second copy would see "healthy" and do nothing.

$ErrorActionPreference = 'SilentlyContinue'

$tools  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root   = Split-Path -Parent $tools
$server = Join-Path $root 'server.js'

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function Test-ServerAlive {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:8765/api/health' -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

while ($true) {
  if (-not (Test-ServerAlive)) {
    Start-Process -FilePath $node -ArgumentList @("`"$server`"", '--no-launch') -WindowStyle Hidden
  }
  Start-Sleep -Seconds 5
}
