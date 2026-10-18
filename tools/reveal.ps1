# reveal.ps1 - Open a folder (optionally selecting a file) and bring it to the FRONT.
#
# Why this exists: launching explorer.exe from a background process creates the window
# but it stays BEHIND the currently focused window (Windows foreground-lock rules),
# so the user thinks "nothing happened".
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File reveal.ps1 -Path "C:\some\folder"
#   powershell -NoProfile -ExecutionPolicy Bypass -File reveal.ps1 -Path "C:\some\file.mp4" -Select
#
# Keep this file ASCII-only so PowerShell never mis-reads it as ANSI.

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Select
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class RevealWin
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    public static IntPtr FindByTitle(string part)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            StringBuilder c = new StringBuilder(256);
            GetClassName(h, c, 256);
            if (c.ToString() != "CabinetWClass") return true;
            if (!IsWindowVisible(h)) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowText(h, t, 512);
            if (t.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool BringToFront(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;

        // SW_RESTORE = 9, in case it was minimized
        ShowWindow(h, 9);

        // Pressing and releasing ALT temporarily lifts the foreground lock,
        // which lets a background process call SetForegroundWindow successfully.
        keybd_event(0x12, 0, 0, IntPtr.Zero);
        keybd_event(0x12, 0, 2, IntPtr.Zero);

        bool ok = SetForegroundWindow(h);

        if (!ok)
        {
            // Fallback: make it topmost then immediately not-topmost.
            // SWP_NOSIZE | SWP_NOMOVE = 0x0001 | 0x0002
            SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_TOPMOST
            SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_NOTOPMOST
            ok = SetForegroundWindow(h);
        }
        return ok;
    }
}
'@ -Language CSharp

# Work out which folder window we should end up looking at
if ($Select) {
    $folder = Split-Path -Parent $Path
} else {
    $folder = $Path
}
$title = Split-Path -Leaf $folder

# 1) Open it
if ($Select) {
    Start-Process -FilePath explorer.exe -ArgumentList ('/select,"' + $Path + '"') | Out-Null
} else {
    Start-Process -FilePath $Path | Out-Null
}

# 2) Wait for the window to appear, then force it to the front (max 4 seconds)
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 100
    $h = [RevealWin]::FindByTitle($title)
    if ($h -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 250
        [void][RevealWin]::BringToFront($h)
        Write-Output 'FOCUSED'
        exit 0
    }
}

Write-Output 'OPENED_BUT_NOT_FOUND'
exit 0
