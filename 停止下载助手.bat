@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 停止 B站下载助手

echo.
echo   正在停止 B站下载助手（含守护进程）...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sup = Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*守护启动.vbs*' }; if ($sup) { $sup | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host '  已停止守护进程' -ForegroundColor Green } else { Write-Host '  守护进程未在运行' -ForegroundColor Yellow }; $c = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '  已停止下载服务' -ForegroundColor Green } else { Write-Host '  下载服务当前没有在运行' -ForegroundColor Yellow }"

echo.
echo   注意：B站客户端不会关闭，只是右键菜单不再出现。
echo.
timeout /t 3 >nul
