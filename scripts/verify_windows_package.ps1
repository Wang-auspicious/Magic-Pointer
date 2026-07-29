[CmdletBinding()]
param(
  [string]$Executable,
  [int]$StartupTimeoutSeconds = 12
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$result = [ordered]@{ status = 'failed'; executable = $null; processId = $null; verifiedFiles = @(); packageSource = $null; bundledPython = $null; pythonImports = @(); fabricSmoke = $null; version = $null; icon = $null; userData = $null; cleanup = $null; error = $null }
$previousRuntimeDir = $env:MAGIC_POINTER_USER_DATA_DIR
$runtimeDir = $null
$process = $null
$exitCode = 0

function Get-ProcessTree([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $pending = @($RootPid)
  $tree = @()
  while ($pending.Count -gt 0) {
    $parent = $pending[0]
    $pending = @($pending | Select-Object -Skip 1)
    $children = @($all | Where-Object { $_.ParentProcessId -eq $parent })
    $tree += $children
    if ($children.Count -gt 0) {
      $pending += @($children.ProcessId)
    }
  }
  return @($tree | Sort-Object ProcessId -Descending)
}

function Invoke-CapturedNative([string]$FilePath, [string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @Arguments 2>&1)
    $nativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    ExitCode = $nativeExitCode
    Output = @($output | ForEach-Object { $_.ToString() })
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($Executable)) { $Executable = Join-Path $PSScriptRoot '..\release\win-unpacked\Magic Pointer.exe' }
  $resolvedExe = (Resolve-Path -LiteralPath $Executable).Path
  if ([IO.Path]::GetExtension($resolvedExe) -ne '.exe') { throw "Expected an .exe, got: $resolvedExe" }
  $result.executable = $resolvedExe
  $appRoot = Split-Path -Parent $resolvedExe
  $resourcesApp = Join-Path $appRoot 'resources\app'
  $pythonRuntime = Join-Path $appRoot 'resources\python-runtime'
  $bundledPython = Join-Path $pythonRuntime 'python.exe'
  $requiredFiles = @('electron\main.js', 'electron\renderer\dashboard.html', 'scripts\electron_bridge.py', 'scripts\local_voice_worker.py', 'assets\app\icon.ico', 'app\fabric\context_packet.py', 'data\preflight_manifest.v1.json')
  foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $resourcesApp $relativePath))) { throw "Packaged runtime file is missing: $relativePath" }
    $result.verifiedFiles += $relativePath
  }
  $forbiddenDevelopmentFiles = @(
    'scripts\capture_dashboard.js',
    'scripts\verify_stage_selection_visual.py',
    'scripts\verify_browser_selection_alignment.py',
    'scripts\prepare_python_runtime.ps1',
    'scripts\run-electron-builder.js'
  )
  foreach ($relativePath in $forbiddenDevelopmentFiles) {
    if (Test-Path -LiteralPath (Join-Path $resourcesApp $relativePath)) {
      throw "Development-only file leaked into package: $relativePath"
    }
  }
  $developmentWorkspaceNeedle = 'D:\Desktop\Magic Pointer'
  $sourceRoots = @(
    (Join-Path $resourcesApp 'electron'),
    (Join-Path $resourcesApp 'app'),
    (Join-Path $resourcesApp 'scripts')
  )
  $scannedSourceCount = 0
  foreach ($sourceRoot in $sourceRoots) {
    foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -ErrorAction Stop) {
      if ($sourceFile.Extension -notin @('.js', '.html', '.css', '.py', '.ps1', '.cs', '.vbs')) { continue }
      $scannedSourceCount += 1
      if ([IO.File]::ReadAllText($sourceFile.FullName).IndexOf($developmentWorkspaceNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Packaged source contains development workspace provenance: $($sourceFile.FullName)"
      }
    }
  }
  $result.packageSource = [ordered]@{
    allowlistClean = $true
    developmentWorkspaceProvenanceAbsent = $true
    scannedSourceFiles = $scannedSourceCount
  }
  foreach ($relativePath in @('python-runtime\python.exe', 'python-runtime\manifest.json', 'python-runtime\Lib\site-packages')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot "resources\$relativePath"))) { throw "Packaged Python runtime file is missing: $relativePath" }
    $result.verifiedFiles += $relativePath
  }
  $pythonManifest = Get-Content -LiteralPath (Join-Path $pythonRuntime 'manifest.json') -Raw | ConvertFrom-Json
  if ($pythonManifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($pythonManifest.pythonVersion) -or [string]::IsNullOrWhiteSpace($pythonManifest.requirementsSha256)) {
    throw 'Bundled Python runtime manifest is invalid.'
  }
  $importProbe = @'
import json
import pathlib
import sys
runtime = pathlib.Path(sys.argv[2]).resolve()
site_packages = runtime / "Lib" / "site-packages"
if not site_packages.is_dir():
    raise RuntimeError("bundled site-packages missing")
sys.path.insert(0, str(site_packages))
import PIL
import fitz
import openai
import pyperclip
import onnxruntime
import rapidocr
import sounddevice
import whisper
import torch
import opencc
print(json.dumps({"executable": str(pathlib.Path(sys.executable).resolve()), "imports": ["PIL", "fitz", "openai", "pyperclip", "onnxruntime", "rapidocr", "sounddevice", "whisper", "torch", "opencc"]}))
'@
  $encodedImportProbe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($importProbe))
  $importResult = Invoke-CapturedNative -FilePath $bundledPython -Arguments @(
    '-I', '-X', 'utf8', '-c',
    'import base64,sys;exec(base64.b64decode(sys.argv[1]))',
    $encodedImportProbe, $pythonRuntime
  )
  if ($importResult.ExitCode -ne 0) { throw "Bundled Python imports failed: $($importResult.Output -join [Environment]::NewLine)" }
  $importEvidence = ($importResult.Output | Select-Object -Last 1) | ConvertFrom-Json
  if ([IO.Path]::GetFullPath($importEvidence.executable) -ne [IO.Path]::GetFullPath($bundledPython)) { throw 'Dependency imports did not run with bundled python.exe.' }
  $result.bundledPython = [ordered]@{ path = $bundledPython; manifest = $pythonManifest }
  $result.pythonImports = @($importEvidence.imports)

  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($resolvedExe)
  $result.version = [ordered]@{ fileVersion = $versionInfo.FileVersion; productVersion = $versionInfo.ProductVersion; productName = $versionInfo.ProductName }
  $icon = [Drawing.Icon]::ExtractAssociatedIcon($resolvedExe)
  if ($null -eq $icon) { throw 'The packaged EXE has no readable associated icon resource.' }
  try { $result.icon = [ordered]@{ readable = $true; width = $icon.Width; height = $icon.Height } } finally { $icon.Dispose() }

  $runtimeDir = Join-Path (Join-Path $env:LOCALAPPDATA 'Magic Pointer\package-smoke') ([guid]::NewGuid().ToString('N'))
  $env:MAGIC_POINTER_USER_DATA_DIR = $runtimeDir
  $smokeScript = Join-Path $resourcesApp 'scripts\smoke_fabric.py'
  $smokeRunner = @'
import pathlib
import runpy
import sys
runtime = pathlib.Path(sys.argv[2]).resolve()
script = pathlib.Path(sys.argv[3]).resolve()
sys.path.insert(0, str(runtime / "Lib" / "site-packages"))
sys.argv = [str(script)]
runpy.run_path(str(script), run_name="__main__")
'@
  $encodedSmokeRunner = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($smokeRunner))
  $smokeResult = Invoke-CapturedNative -FilePath $bundledPython -Arguments @(
    '-I', '-X', 'utf8', '-c',
    'import base64,sys;exec(base64.b64decode(sys.argv[1]))',
    $encodedSmokeRunner, $pythonRuntime, $smokeScript
  )
  if ($smokeResult.ExitCode -ne 0) { throw "Bundled Fabric smoke failed: $($smokeResult.Output -join [Environment]::NewLine)" }
  $smokeText = $smokeResult.Output -join [Environment]::NewLine
  $smokeJsonStart = $smokeText.IndexOf('{')
  if ($smokeJsonStart -lt 0) { throw 'Bundled Fabric smoke did not emit JSON.' }
  $smokeJson = $smokeText.Substring($smokeJsonStart) | ConvertFrom-Json
  if ($smokeJson.ok -ne $true) { throw 'Bundled Fabric smoke did not report ok=true.' }
  $result.fabricSmoke = $smokeJson
  $process = Start-Process -FilePath $resolvedExe -PassThru
  $result.processId = $process.Id
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 400
    $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  } while (-not $running -and (Get-Date) -lt $deadline)
  if (-not $running) { throw 'Packaged application exited before startup verification completed.' }
  if ([IO.Path]::GetFullPath($running.Path) -ne [IO.Path]::GetFullPath($resolvedExe)) { throw "Launched PID does not resolve to requested EXE: $($running.Path)" }

  do {
    $logPath = Join-Path $runtimeDir 'electron.log'
    Start-Sleep -Milliseconds 400
  } while ((-not (Test-Path -LiteralPath $runtimeDir) -or -not (Test-Path -LiteralPath $logPath)) -and (Get-Date) -lt $deadline)
  if (-not (Test-Path -LiteralPath $runtimeDir)) { throw 'Packaged application did not create its isolated user-data directory.' }
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'Packaged application did not create electron.log in its isolated user-data directory.' }
  $chromiumProfileIsolated = @(
    Get-ProcessTree $process.Id | Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*--user-data-dir=*' -and
      $_.CommandLine.IndexOf($runtimeDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
  ).Count -gt 0
  if (-not $chromiumProfileIsolated) { throw 'Packaged Chromium child processes did not use the isolated smoke user-data directory.' }
  $result.userData = [ordered]@{
    path = $runtimeDir
    logPath = $logPath
    logBytes = (Get-Item -LiteralPath $logPath).Length
    chromiumProfileIsolated = $chromiumProfileIsolated
  }
  $result.status = 'passed'
}
catch {
  $result.error = $_.Exception.Message
  $exitCode = 1
}
finally {
  $cleanupErrors = @()
  if ($process) {
    try {
      $root = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
      if ($root -and [IO.Path]::GetFullPath($root.Path) -eq [IO.Path]::GetFullPath($result.executable)) {
        $children = @(Get-ProcessTree $process.Id)
        foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $trackedIds = @($process.Id) + @($children | ForEach-Object { $_.ProcessId })
        $shutdownDeadline = (Get-Date).AddSeconds(5)
        do {
          $remaining = @($trackedIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
          if ($remaining.Count -eq 0) { break }
          foreach ($item in $remaining) { Stop-Process -Id $item.Id -Force -ErrorAction SilentlyContinue }
          Start-Sleep -Milliseconds 150
        } while ((Get-Date) -lt $shutdownDeadline)
        if ($remaining.Count -gt 0) { throw "Timed out stopping packaged process tree: $($remaining.Id -join ',')" }
      } elseif ($root) { $cleanupErrors += 'Skipped process cleanup because the launched PID path no longer matched the requested EXE.' }
    } catch { $cleanupErrors += "Process cleanup: $($_.Exception.Message)" }
  }
  if ($runtimeDir) {
    try {
      $smokeRoot = Join-Path $env:LOCALAPPDATA 'Magic Pointer\package-smoke'
      if ([IO.Path]::GetFullPath($runtimeDir).StartsWith([IO.Path]::GetFullPath($smokeRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        $lastCleanupError = $null
        for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
          try {
            if (Test-Path -LiteralPath $runtimeDir) {
              Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction Stop
            }
            $lastCleanupError = $null
            break
          } catch {
            $lastCleanupError = $_.Exception.Message
            Start-Sleep -Milliseconds 250
          }
        }
        if ($lastCleanupError) { throw $lastCleanupError }
      } else { $cleanupErrors += 'Skipped runtime cleanup because the generated directory was outside package-smoke.' }
    } catch { $cleanupErrors += "Runtime cleanup: $($_.Exception.Message)" }
  }
  if ($null -eq $previousRuntimeDir) { Remove-Item Env:MAGIC_POINTER_USER_DATA_DIR -ErrorAction SilentlyContinue } else { $env:MAGIC_POINTER_USER_DATA_DIR = $previousRuntimeDir }
  $result.cleanup = [ordered]@{ scopedProcessId = if ($process) { $process.Id } else { $null }; smokeDataRemoved = ($cleanupErrors.Count -eq 0); errors = $cleanupErrors }
  if ($cleanupErrors.Count -gt 0) {
    $result.status = 'failed'
    if (-not $result.error) { $result.error = 'Package smoke cleanup failed.' }
    $exitCode = 1
  }
}

$result | ConvertTo-Json -Depth 5 -Compress
if ($exitCode -ne 0) { exit $exitCode }
