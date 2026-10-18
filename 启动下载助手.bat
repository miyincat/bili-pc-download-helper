@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title B站下载助手

rem ---------- 找 Node.js ----------
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE=C:\Program Files\nodejs\node.exe"
  ) else (
    echo.
    echo   [错误] 没有找到 Node.js。
    echo   请先安装 Node.js 再来： https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   ============================================
echo      B 站下载助手
echo      让 B 站客户端右键就能下载视频
echo   ============================================
echo.

rem ---------- 探测当前状态 ----------
"%NODE%" tools\probe.js
set "RC=%errorlevel%"

set "FLAG="
if "%RC%"=="2" (
  echo   [提示] B站客户端正在运行，但还没开启"下载功能"。
  echo          需要重启一次客户端（约 3 秒，登录状态不会丢）。
  echo.
  choice /c YN /n /m "   现在重启客户端吗？[Y=重启 / N=算了] "
  if errorlevel 2 (
    echo.
    echo   已跳过。注意：不重启的话，右键菜单不会出现。
    echo.
  ) else (
    set "FLAG=--restart"
    echo.
  )
)

echo   正在启动，请不要关闭这个窗口…
echo   （想停止：直接关掉这个黑窗口）
echo.

"%NODE%" server.js %FLAG%

echo.
echo   服务已停止。
pause
