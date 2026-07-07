$matches = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'pythonw.exe' -or $_.Name -eq 'python.exe') -and
    ($_.CommandLine -like '*app.main*')
}
if (-not $matches) {
    Write-Host 'No Magic Pointer background process found.'
    exit 0
}
foreach ($p in $matches) {
    Write-Host "Stopping PID $($p.ProcessId): $($p.CommandLine)"
    Stop-Process -Id $p.ProcessId -Force
}
