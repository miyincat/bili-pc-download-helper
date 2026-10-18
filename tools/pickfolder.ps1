# pickfolder.ps1 - Show a native Windows folder picker, print chosen path to stdout.
#
# Called by server.js via:  powershell.exe -NoProfile -STA -File pickfolder.ps1 "<description>" "<title>"
#
# IMPORTANT: keep this file ASCII-only (no BOM needed, safe to edit).
# Chinese text is passed in as arguments from Node, which handles UTF-16 correctly.
#
# Why an invisible TopMost owner form: a dialog with no owner can end up behind the
# Bilibili client window and look like "nothing happened".

param(
    [string]$Description = 'Select a folder',
    [string]$Title = 'Bilibili Downloader'
)

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so Chinese paths survive the trip back to Node
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

try {
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $owner = New-Object System.Windows.Forms.Form
    $owner.Text = $Title
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = 'None'
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Opacity = 0
    $owner.Show()
    $owner.Activate()

    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = $Description
    $dlg.ShowNewFolderButton = $true

    # Do NOT set RootFolder: it conflicts with SelectedPath and can make
    # ShowDialog return OK with an empty SelectedPath.
    $videos = [Environment]::GetFolderPath('MyVideos')
    if ($videos -and (Test-Path $videos)) { $dlg.SelectedPath = $videos }

    $result = $dlg.ShowDialog($owner)

    $picked = $dlg.SelectedPath
    # If the user pressed OK without any real selection, fall back to Videos
    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and -not $picked) { $picked = $videos }

    [Console]::Error.WriteLine('RESULT=' + $result + ' PATH=' + $picked)

    if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $picked) {
        [Console]::Out.WriteLine($picked)
        [Console]::Out.Flush()
    }
}
catch {
    exit 1
}
finally {
    try { if ($owner) { $owner.Close(); $owner.Dispose() } } catch {}
}
