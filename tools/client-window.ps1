param(
  [switch]$Fix
)

# Restore the bilibili client window when the app is running but has no visible window.
# Prints one of: VISIBLE <hwnd> <title> | HIDDEN <hwnd> <w>x<h> | FIXED <hwnd> <w>x<h> | NONE | NOMAIN
# With -Fix, a hidden window that looks like a real app window gets shown.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class BiliWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);

  public struct RECT { public int L, T, R, B; }

  public static string Work(uint[] pids, bool fix) {
    IntPtr visible = IntPtr.Zero;
    string visibleTitle = "";
    IntPtr hidden = IntPtr.Zero;
    int hiddenArea = 0;
    int hiddenW = 0;
    int hiddenH = 0;

    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;

      StringBuilder sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      RECT r;
      GetWindowRect(h, out r);
      int w = r.R - r.L;
      int ht = r.B - r.T;

      if (IsWindowVisible(h) && w > 200 && ht > 150) {
        if (visible == IntPtr.Zero) { visible = h; visibleTitle = sb.ToString(); }
        return true;
      }

      if (!IsWindowVisible(h) && w > 600 && ht > 400 && w * ht > hiddenArea) {
        hiddenArea = w * ht;
        hidden = h;
        hiddenW = w;
        hiddenH = ht;
      }
      return true;
    }, IntPtr.Zero);

    if (visible != IntPtr.Zero) return "VISIBLE|" + visible.ToInt64() + "|" + visibleTitle;
    if (hidden == IntPtr.Zero) return "NONE||";

    if (!fix) return "HIDDEN|" + hidden.ToInt64() + "|" + hiddenW + "x" + hiddenH;

    ShowWindow(hidden, 9);
    ShowWindow(hidden, 5);
    SetWindowPos(hidden, IntPtr.Zero, 80, 60, 0, 0, 0x0041);
    SetForegroundWindow(hidden);
    System.Threading.Thread.Sleep(500);

    return "FIXED|" + hidden.ToInt64() + "|" + hiddenW + "x" + hiddenH;
  }
}
'@ -Language CSharp

$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ($_.Path -like '*\bilibili\*')
}
if (-not $procs) { Write-Output 'NOMAIN||'; exit 0 }

$pids = @($procs | ForEach-Object { [uint32]$_.Id })
Write-Output ([BiliWin]::Work($pids, [bool]$Fix))
