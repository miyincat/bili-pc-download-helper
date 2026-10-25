' Launch the bilibili client together with the download helper.
'
' Why: if the helper (node server.js + its supervisor) is not running,
' the right-click menu is simply absent and nothing tells the user why.
' This wrapper starts the helper first, then opens the client as usual.
'
' Keep this file ASCII-only: Windows Script Host reads .vbs as ANSI,
' so Chinese paths/names are assembled with ChrW() below.

Option Explicit

Dim sh, fso, dir, clientExe, supVbs, lnk

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
clientExe = "C:\Program Files\bilibili\" & ChrW(21716) & ChrW(21737) & ChrW(21716) & ChrW(21737) & ".exe"
supVbs = dir & "\" & ChrW(23432) & ChrW(25252) & ChrW(21551) & ChrW(21160) & ".vbs"

' 1) make sure the helper is alive (ask its own health endpoint)
If Not HelperAlive() Then
    On Error Resume Next
    sh.Run "wscript.exe """ & supVbs & """", 0, False
    On Error GoTo 0
    WScript.Sleep 2500
End If

' 2) open the client through Explorer + a .lnk that carries the debug port.
' Why not run the exe directly: on this client, a direct Run/Start from WSH or
' cmd silently fails to launch (only the shell path works), and Explorer cannot
' pass arguments to a bare exe. A shortcut can.
lnk = dir & "\tools\client-cdp.lnk"
On Error Resume Next
If fso.FileExists(lnk) Then
    sh.Run "explorer.exe """ & lnk & """", 0, False
Else
    sh.CurrentDirectory = "C:\Program Files\bilibili"
    sh.Run """" & clientExe & """ --remote-debugging-port=9333", 1, False
End If
On Error GoTo 0

Function HelperAlive()
    Dim http
    HelperAlive = False
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", "http://127.0.0.1:8765/api/health", False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then HelperAlive = True
    End If
    Err.Clear
    On Error GoTo 0
End Function