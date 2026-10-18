@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 安装开机自启

echo.
echo   正在把「B站下载助手」加入开机启动...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'; $lnk = Join-Path $startup 'B站下载助手.lnk'; $s = New-Object -ComObject WScript.Shell; $sc = $s.CreateShortcut($lnk); $sc.TargetPath = Join-Path '%~dp0' '静默启动.vbs'; $sc.WorkingDirectory = '%~dp0'; $sc.WindowStyle = 7; $sc.Description = 'B站下载助手（开机静默启动）'; $sc.Save(); Write-Host ('  已创建开机启动项：' + $lnk) -ForegroundColor Green"

echo.
echo   以后每次开机会自动静默运行（没有黑窗口）。
echo   想取消：删除下面这个文件即可
echo   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\B站下载助手.lnk
echo.
pause
