$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidPath = Join-Path $ProjectDir 'data\runtime\electron.pid'
if (Test-Path $PidPath) {
    try {
        $TargetPid = [int](Get-Content -Path $PidPath -Raw).Trim()
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping Magic Pointer PID from pidfile $TargetPid"
            Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -Path $PidPath -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "Could not stop pidfile process: $($_.Exception.Message)"
    }
}
$matches = @()
try {
    $matches = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        ($_.Name -in @('pythonw.exe','python.exe','electron.exe','node.exe','cmd.exe')) -and
        (
            $_.CommandLine -like '*app.main*' -or
            $_.CommandLine -like '*electron/main.js*' -or
            $_.CommandLine -like '*electron\main.js*' -or
            $_.CommandLine -like '*npm.cmd run overlay*'
        )
    } | ForEach-Object { [PSCustomObject]@{ Id=$_.ProcessId; Label=$_.CommandLine } }
} catch {
    Write-Host "Command-line process query unavailable, using path fallback: $($_.Exception.Message)"
    $matches = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProcessName -in @('electron','node','python','pythonw','cmd')) -and
        ($_.Path -like "$ProjectDir*" -or $_.Path -like "*\node_modules\electron\*")
    } | ForEach-Object { [PSCustomObject]@{ Id=$_.Id; Label=$_.Path } }
}
if (-not $matches) {
    Write-Host 'No Magic Pointer background process found.'
    exit 0
}
foreach ($p in $matches) {
    Write-Host "Stopping PID $($p.Id): $($p.Label)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
