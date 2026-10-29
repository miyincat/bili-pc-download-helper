@echo off
chcp 65001 >nul
rem Restart the bilibili client (and make sure the download helper is running).
rem PowerShell edition: no dependency on VBScript, which Windows is retiring.

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\restart.ps1"
exit /b 0
