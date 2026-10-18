@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 停止 B站下载助手

echo.
echo   正在停止 B站下载助手...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '  已停止。' -ForegroundColor Green } else { Write-Host '  下载助手当前没有在运行。' -ForegroundColor Yellow }"

echo.
echo   注意：B站客户端不会被关闭，只是右键菜单不再出现。
echo.
timeout /t 3 >nul
