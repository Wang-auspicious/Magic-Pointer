[CmdletBinding()]
param(
  [string]$BuildPython = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LockPath = Join-Path $ProjectRoot 'requirements.lock.txt'
$BuildRoot = Join-Path $ProjectRoot 'build'
$RuntimePath = Join-Path $BuildRoot 'python-runtime'
$WheelhousePath = Join-Path $BuildRoot 'python-wheelhouse'
$ExcludedDirectories = @('site-packages', '__pycache__', 'test', 'tests', 'idlelib', 'tkinter')

function Invoke-BuildPython([string[]]$Arguments) {
  & $script:BuildPython @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Build Python command failed ($LASTEXITCODE): $($Arguments -join ' ')"
  }
}

function Invoke-CapturedBuildPython([string[]]$Arguments) {
  # Windows PowerShell 5 converts native stderr into ErrorRecord objects and,
  # under ErrorActionPreference=Stop, throws before callers can inspect the
  # intended non-zero exit code. Capture it under Continue and restore the
  # product-wide strict preference immediately afterwards.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $script:BuildPython @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = @($output | ForEach-Object { $_.ToString() })
  }
}

function Get-BuildPythonLastLine([string[]]$Arguments) {
  $captured = Invoke-CapturedBuildPython -Arguments $Arguments
  if ($captured.ExitCode -ne 0) {
    throw "Build Python command failed ($($captured.ExitCode)): $($Arguments -join ' ')`n$($captured.Output -join [Environment]::NewLine)"
  }
  return ($captured.Output | Select-Object -Last 1).ToString().Trim()
}

function Copy-FilteredTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
    $target = Join-Path $Destination $entry.Name
    if ($entry.PSIsContainer) {
      if ($script:ExcludedDirectories -contains $entry.Name.ToLowerInvariant()) { continue }
      Copy-FilteredTree -Source $entry.FullName -Destination $target
    } else {
      Copy-Item -LiteralPath $entry.FullName -Destination $target -Force
    }
  }
}

function Test-RuntimeImports([string]$PythonPath) {
  $probe = @'
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
print("magic_pointer_runtime_imports_ok")
'@
  $encodedProbe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
  $previousBuildPython = $script:BuildPython
  try {
    $script:BuildPython = $PythonPath
    $captured = Invoke-CapturedBuildPython -Arguments @(
      '-I', '-X', 'utf8', '-c',
      'import base64,sys;exec(base64.b64decode(sys.argv[1]))',
      $encodedProbe
    )
  } finally {
    $script:BuildPython = $previousBuildPython
  }
  return $captured.ExitCode -eq 0 -and $captured.Output -contains 'magic_pointer_runtime_imports_ok'
}

function Test-Wheelhouse([string]$Candidate, [string]$LockFile) {
  if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) { return $false }
  $validator = @'
import hashlib
import pathlib
import re
import sys
import tarfile
import zipfile

root = pathlib.Path(sys.argv[2]).resolve()
lock = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
allowed = set(re.findall(r"--hash=sha256:([0-9a-f]{64})", lock, re.I))
archives = sorted(path for path in root.iterdir() if path.is_file())
if not allowed or not archives:
    raise SystemExit(2)
for archive in archives:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest not in allowed:
        raise SystemExit(f"unlocked archive: {archive.name}")
    lower = archive.name.casefold()
    if lower.endswith((".whl", ".zip")):
        with zipfile.ZipFile(archive) as package:
            if package.testzip() is not None:
                raise SystemExit(f"damaged zip: {archive.name}")
    elif lower.endswith((".tar.gz", ".tgz")):
        with tarfile.open(archive, "r:gz") as package:
            for member in package:
                if not member.name:
                    raise SystemExit(f"damaged tar: {archive.name}")
    else:
        raise SystemExit(f"unsupported archive: {archive.name}")
print("magic_pointer_wheelhouse_ok")
'@
  $encodedValidator = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($validator))
  $captured = Invoke-CapturedBuildPython -Arguments @(
    '-I', '-X', 'utf8', '-c',
    'import base64,sys;exec(base64.b64decode(sys.argv[1]))',
    $encodedValidator, $Candidate, $LockFile
  )
  $valid = $captured.ExitCode -eq 0 -and $captured.Output -contains 'magic_pointer_wheelhouse_ok'
  if (-not $valid -and $captured.Output.Count -gt 0) {
    Write-Warning ("Wheelhouse validation failed: " + ($captured.Output -join [Environment]::NewLine))
  }
  return $valid
}

function Test-RuntimeCache([string]$Candidate, [string]$PythonVersion, [string]$RequirementsSha256) {
  $manifestPath = Join-Path $Candidate 'manifest.json'
  $candidatePython = Join-Path $Candidate 'python.exe'
  if (-not (Test-Path -LiteralPath $candidatePython)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'Lib\site-packages'))) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'Lib\encodings\__init__.py'))) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'DLLs'))) { return $false }
  if (Test-Path -LiteralPath (Join-Path $Candidate 'pyvenv.cfg')) { return $false }
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { return $false }
  $manifestMatches = $manifest.schemaVersion -eq 1 -and
    $manifest.pythonVersion -eq $PythonVersion -and
    $manifest.requirementsSha256 -eq $RequirementsSha256
  return $manifestMatches -and (Test-RuntimeImports -PythonPath $candidatePython)
}

if ([string]::IsNullOrWhiteSpace($BuildPython)) {
  $BuildPython = if ([string]::IsNullOrWhiteSpace($env:MAGIC_POINTER_BUILD_PYTHON)) { 'python' } else { $env:MAGIC_POINTER_BUILD_PYTHON }
}
if (-not (Test-Path -LiteralPath $LockPath)) { throw "requirements.lock.txt missing: $LockPath" }

$PythonVersion = Get-BuildPythonLastLine @('-c', 'import sys; print(sys.version)')
$BasePrefix = Get-BuildPythonLastLine @('-c', 'import sys; print(sys.base_prefix)')
if (-not (Test-Path -LiteralPath $BasePrefix)) { throw "Build Python base prefix missing: $BasePrefix" }
$RequirementsSha256 = (Get-FileHash -LiteralPath $LockPath -Algorithm SHA256).Hash.ToLowerInvariant()

if (-not $Force -and (Test-RuntimeCache -Candidate $RuntimePath -PythonVersion $PythonVersion -RequirementsSha256 $RequirementsSha256)) {
  Write-Output "Python runtime cache valid: $RuntimePath"
  exit 0
}

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$nonce = "$PID-$([guid]::NewGuid().ToString('N'))"
$shortNonce = "$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
# Keep this path deliberately short. Some binary wheels contain deeply nested
# license metadata and still encounter the Win32 legacy path ceiling during
# pip's cross-volume target copy.
$StagePath = Join-Path $BuildRoot "pr-stage-$shortNonce"
$BackupPath = Join-Path $BuildRoot "python-runtime.previous-$nonce"
$WheelhouseStagePath = Join-Path $BuildRoot ('python-wheelhouse.staging-' + $nonce)
$WheelhouseBackupPath = Join-Path $BuildRoot "python-wheelhouse.previous-$nonce"
$oldPythonNoUserSite = $env:PYTHONNOUSERSITE
$oldPipNoVersionCheck = $env:PIP_DISABLE_PIP_VERSION_CHECK
$oldPipNoInput = $env:PIP_NO_INPUT

try {
  if ($Force -or -not (Test-Wheelhouse -Candidate $WheelhousePath -LockFile $LockPath)) {
    New-Item -ItemType Directory -Path $WheelhouseStagePath -Force | Out-Null
    Invoke-BuildPython @(
      '-m', 'pip', 'download',
      '--dest', $WheelhouseStagePath,
      '--require-hashes',
      '--only-binary', ':all:',
      # These two pinned pure-Python projects publish source archives only.
      '--no-binary', 'openai-whisper,antlr4-python3-runtime',
      '--disable-pip-version-check',
      '--no-input',
      '--progress-bar', 'off',
      '--timeout', '180',
      '--retries', '10',
      '-r', $LockPath
    ) | Write-Output
    if (-not (Test-Wheelhouse -Candidate $WheelhouseStagePath -LockFile $LockPath)) {
      throw 'Downloaded Python wheelhouse failed archive or hash validation.'
    }
    $hadWheelhouse = Test-Path -LiteralPath $WheelhousePath
    if ($hadWheelhouse) {
      Move-Item -LiteralPath $WheelhousePath -Destination $WheelhouseBackupPath -ErrorAction Stop
    }
    try {
      Move-Item -LiteralPath $WheelhouseStagePath -Destination $WheelhousePath -ErrorAction Stop
    } catch {
      if ($hadWheelhouse -and -not (Test-Path -LiteralPath $WheelhousePath) -and (Test-Path -LiteralPath $WheelhouseBackupPath)) {
        Move-Item -LiteralPath $WheelhouseBackupPath -Destination $WheelhousePath -ErrorAction SilentlyContinue
      }
      throw
    }
    if (Test-Path -LiteralPath $WheelhouseBackupPath) {
      Remove-Item -LiteralPath $WheelhouseBackupPath -Recurse -Force -ErrorAction Stop
    }
  }

  New-Item -ItemType Directory -Path $StagePath -Force | Out-Null
  $rootFiles = Get-ChildItem -LiteralPath $BasePrefix -File | Where-Object {
    $_.Name -match '^(python(?:w)?\.exe|python3.*\.dll|python\d*\.dll|vcruntime.*\.dll|msvcp.*\.dll|api-ms-win-crt-.*\.dll)$'
  }
  foreach ($file in $rootFiles) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $StagePath $file.Name) -Force }
  if (-not (Test-Path -LiteralPath (Join-Path $StagePath 'python.exe'))) { throw 'Base Python runtime did not contain python.exe.' }
  foreach ($directoryName in @('DLLs', 'Lib')) {
    $sourceDirectory = Join-Path $BasePrefix $directoryName
    if (-not (Test-Path -LiteralPath $sourceDirectory)) { throw "Base Python runtime missing $directoryName." }
    Copy-FilteredTree -Source $sourceDirectory -Destination (Join-Path $StagePath $directoryName)
  }
  if (Test-Path -LiteralPath (Join-Path $StagePath 'pyvenv.cfg')) { throw 'Staged runtime must not contain pyvenv.cfg.' }

  $sitePackages = Join-Path $StagePath 'Lib\site-packages'
  New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
  $env:PYTHONNOUSERSITE = '1'
  $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
  $env:PIP_NO_INPUT = '1'
  Invoke-BuildPython @(
    '-m', 'pip', 'install',
    '--target', $sitePackages,
    '--ignore-installed',
    '--no-compile',
    '--no-index',
    '--find-links', $WheelhousePath,
    '--require-hashes',
    '--no-build-isolation',
    '--disable-pip-version-check',
    '--no-input',
    '--progress-bar', 'off',
    '--timeout', '180',
    '--retries', '10',
    '--upgrade',
    '-r', $LockPath
  ) | Write-Output

  $stagePython = Join-Path $StagePath 'python.exe'
  $validation = 'import pathlib, sys; runtime = pathlib.Path(sys.argv[2]).resolve(); assert pathlib.Path(sys.executable).resolve() == runtime / "python.exe"; assert not (runtime / "pyvenv.cfg").exists(); print(sys.version)'
  $encodedValidation = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($validation))
  & $stagePython -I -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' $encodedValidation $StagePath | Write-Output
  if ($LASTEXITCODE -ne 0) { throw "Staged Python validation failed ($LASTEXITCODE)." }
  if (-not (Test-RuntimeImports -PythonPath $stagePython)) {
    throw 'Staged Python dependency imports failed.'
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    pythonVersion = $PythonVersion
    requirementsSha256 = $RequirementsSha256
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $StagePath 'manifest.json'),
    ($manifest | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false))
  )

  $hadPrevious = Test-Path -LiteralPath $RuntimePath
  if ($hadPrevious) { Move-Item -LiteralPath $RuntimePath -Destination $BackupPath -ErrorAction Stop }
  try {
    Move-Item -LiteralPath $StagePath -Destination $RuntimePath -ErrorAction Stop
  } catch {
    if ($hadPrevious -and -not (Test-Path -LiteralPath $RuntimePath) -and (Test-Path -LiteralPath $BackupPath)) {
      Move-Item -LiteralPath $BackupPath -Destination $RuntimePath -ErrorAction SilentlyContinue
    }
    throw
  }
  if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction Stop }
  Write-Output "Python runtime prepared: $RuntimePath"
}
finally {
  if (Test-Path -LiteralPath $StagePath) { Remove-Item -LiteralPath $StagePath -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $WheelhouseStagePath) { Remove-Item -LiteralPath $WheelhouseStagePath -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $WheelhouseBackupPath) {
    if (-not (Test-Path -LiteralPath $WheelhousePath)) {
      Move-Item -LiteralPath $WheelhouseBackupPath -Destination $WheelhousePath -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $WheelhouseBackupPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -eq $oldPythonNoUserSite) { Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue } else { $env:PYTHONNOUSERSITE = $oldPythonNoUserSite }
  if ($null -eq $oldPipNoVersionCheck) { Remove-Item Env:PIP_DISABLE_PIP_VERSION_CHECK -ErrorAction SilentlyContinue } else { $env:PIP_DISABLE_PIP_VERSION_CHECK = $oldPipNoVersionCheck }
  if ($null -eq $oldPipNoInput) { Remove-Item Env:PIP_NO_INPUT -ErrorAction SilentlyContinue } else { $env:PIP_NO_INPUT = $oldPipNoInput }
}
