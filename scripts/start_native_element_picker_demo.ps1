param(
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'data\runtime'
$sourcePath = Join-Path $PSScriptRoot 'native_element_picker_demo.cs'
$outputPath = Join-Path $runtimeDir 'native-element-picker-demo.exe'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -eq $outputPath } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if ($Stop) {
    Write-Output 'Magic Pointer native element picker stopped.'
    exit 0
}

$frameworkDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$wpfDir = Join-Path $frameworkDir 'WPF'
$compiler = Join-Path $frameworkDir 'csc.exe'

& $compiler /nologo /target:winexe /optimize+ "/out:$outputPath" `
    "/reference:$wpfDir\UIAutomationClient.dll" `
    "/reference:$wpfDir\UIAutomationTypes.dll" `
    "/reference:$wpfDir\WindowsBase.dll" `
    "/reference:$frameworkDir\System.Windows.Forms.dll" `
    "/reference:$frameworkDir\System.Drawing.dll" `
    $sourcePath
if ($LASTEXITCODE -ne 0) {
    throw "C# compiler exited with code $LASTEXITCODE"
}

$process = Start-Process -FilePath $outputPath -WindowStyle Hidden -PassThru
Write-Output "Magic Pointer native element picker started (PID $($process.Id))."
Write-Output 'Ctrl+Alt+F9 toggles highlighting; Ctrl+Alt+Shift+F9 exits.'
