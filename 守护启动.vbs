' Bilibili Downloader - supervisor.
'
' Keeps server.js alive: if it is not running (or died), start it; otherwise
' do nothing. The health check also prevents duplicate instances when the
' supervisor happens to be started twice.

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
    If Not ServerAlive() Then
        On Error Resume Next
        sh.Run cmd, 0, True
        On Error GoTo 0
    End If
    WScript.Sleep 5000
Loop

Function ServerAlive()
    Dim http
    ServerAlive = False
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", "http://127.0.0.1:8765/api/health", False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then ServerAlive = True
    End If
    Err.Clear
    On Error GoTo 0
End Function