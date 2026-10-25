' Restart the bilibili client when it freezes (black player / unresponsive).
' Kills every client process then relaunches through the helper launcher.
' Keep this file ASCII-only: WSH reads .vbs as ANSI.

Option Explicit

Dim sh, fso, dir, clientExe, launcher, wmi, col, p, ep, n

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
clientExe = "C:\Program Files\bilibili\" & ChrW(21716) & ChrW(21737) & ChrW(21716) & ChrW(21737) & ".exe"
launcher = dir & "\" & ChrW(21551) & ChrW(21160) & ChrW(21716) & ChrW(21737) & ChrW(21716) & ChrW(21737) & ".vbs"

n = 0
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set col = wmi.ExecQuery("SELECT ProcessId, ExecutablePath FROM Win32_Process")
For Each p In col
    ep = ""
    ep = p.ExecutablePath
    If InStr(1, ep, "\bilibili\", 1) > 0 Then
        sh.Run "taskkill /PID " & p.ProcessId & " /F", 0, True
        n = n + 1
    End If
Next
On Error GoTo 0

WScript.Sleep 2500

If fso.FileExists(launcher) Then
    sh.Run "wscript.exe """ & launcher & """", 0, False
Else
    sh.CurrentDirectory = "C:\Program Files\bilibili"
    sh.Run """" & clientExe & """ --remote-debugging-port=9333", 1, False
End If

WScript.Echo "closed " & n & " client process(es), restarting..."