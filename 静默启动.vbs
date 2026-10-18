' Bilibili Downloader - start the background helper silently (no console window).
'
' This script only launches server.js and exits immediately.
' To stop it: run "停止下载助手.bat", or end node.exe in Task Manager.
'
' Keep this file ASCII-only: Windows Script Host reads .vbs as ANSI,
' and non-ASCII characters can break parsing.

Option Explicit

Dim sh, fso, dir, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)

If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = """C:\Program Files\nodejs\node.exe"""
Else
    nodeExe = "node"
End If

sh.CurrentDirectory = dir
cmd = nodeExe & " """ & dir & "\server.js"" --no-launch"
sh.Run cmd, 0, False
