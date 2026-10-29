# Restart the bilibili client (used by 重启客户端.bat).
# Kills every client process, then relaunches through the launcher.

$ErrorActionPreference = 'SilentlyContinue'

Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and ($_.Path -like '*\bilibili\*') } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 3

$launcher = Join-Path $PSScriptRoot 'launcher.ps1'
if (Test-Path $launcher) {
  & $launcher
}
