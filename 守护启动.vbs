' Bilibili Downloader - supervisor.
'
' Why: server.js can exit (crash, killed by a system tool, OOM...). If nothing
' restarts it, the right-click menu silently disappears until you reboot.
' This script keeps it alive: whenever node exits, wait 5s and start it again.
'
' To stop everything: run 停止下载助手.bat (it kills this supervisor first).
'
' Keep this file ASCII-only: Windows Script Host reads .vbs as ANSI.

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

Do
    ' 0 = hidden window, True = wait until node exits
    sh.Run cmd, 0, True
    WScript.Sleep 5000
Loop
