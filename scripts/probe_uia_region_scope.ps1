param([string]$Probe = "$PSScriptRoot/../data/runtime/uia_selection_probe.exe")
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScopeProbeDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[void][ScopeProbeDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = New-Object System.Windows.Forms.Form
$foreign = New-Object System.Windows.Forms.Form
try {
    $target.Text = 'MP region scope target'
    $target.StartPosition = 'Manual'
    $target.Location = New-Object System.Drawing.Point(40, 80)
    $target.Size = New-Object System.Drawing.Size(300, 180)
    $foreign.Text = 'MP unrelated overlay'
    $foreign.StartPosition = 'Manual'
    $foreign.Location = New-Object System.Drawing.Point(450, 80)
    $foreign.Size = New-Object System.Drawing.Size(300, 180)
    $label = New-Object System.Windows.Forms.Button
    $label.Text = 'FOREIGN_SELECTION_MUST_NOT_LEAK'
    $label.Location = New-Object System.Drawing.Point(20, 45)
    $label.Size = New-Object System.Drawing.Size(250, 45)
    $foreign.Controls.Add($label)
    $target.Show()
    $foreign.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $box = $label.RectangleToScreen($label.ClientRectangle)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Resolve-Path -LiteralPath $Probe).Path
    $start.Arguments = "$($target.Handle.ToInt64()) --region $($box.X) $($box.Y) $($box.Width) $($box.Height)"
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $process = [System.Diagnostics.Process]::Start($start)
    while (-not $process.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
    $result = $process.StandardOutput.ReadToEnd() | ConvertFrom-Json
    $result | Select-Object ok, text, error | ConvertTo-Json -Compress
    if ($result.text) { throw 'Region probe read an unrelated window as the target.' }
    $start.Arguments = "$($foreign.Handle.ToInt64()) --region $($box.X) $($box.Y) $($box.Width) $($box.Height)"
    $process = [System.Diagnostics.Process]::Start($start)
    while (-not $process.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
    $positive = $process.StandardOutput.ReadToEnd() | ConvertFrom-Json
    $positive | Select-Object ok, text, error | ConvertTo-Json -Compress
    if ($positive.text -notmatch 'FOREIGN_SELECTION_MUST_NOT_LEAK') { throw 'The target window could not read its own button.' }
} finally {
    $foreign.Close(); $foreign.Dispose()
    $target.Close(); $target.Dispose()
}
