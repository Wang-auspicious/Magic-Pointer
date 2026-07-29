[CmdletBinding()]
param(
  [string]$Installer,
  [int]$InstallTimeoutSeconds = 420,
  [int]$StartupTimeoutSeconds = 20,
  [int]$UninstallTimeoutSeconds = 180,
  [int]$CleanupTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$productName = 'Magic Pointer'
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Magic Pointer'
$installedExe = Join-Path $installRoot 'Magic Pointer.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Magic Pointer.exe'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Magic Pointer.lnk'
$startShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Magic Pointer.lnk'
$smokeRoot = Join-Path $env:LOCALAPPDATA 'Magic Pointer\install-smoke'
$runtimeDir = Join-Path $smokeRoot ([guid]::NewGuid().ToString('N'))
$previousRuntimeDir = $env:MAGIC_POINTER_USER_DATA_DIR
$installationOwned = $false
$appProcess = $null
$result = [ordered]@{
  status = 'failed'
  installer = $null
  installedExe = $installedExe
  shortcuts = @()
  startup = $null
  cleanup = $null
  error = $null
}
$exitCode = 0

function Get-MagicPointerUninstallEntries {
  $entries = @()
  foreach ($root in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $entries += @(
      Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -eq $productName }
    )
  }
  return @($entries)
}

function Wait-ScopedProcess([Diagnostics.Process]$Process, [int]$TimeoutSeconds, [string]$Label) {
  Wait-Process -Id $Process.Id -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
  if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "${Label}_timeout"
  }
  $Process.Refresh()
  if ($Process.ExitCode -ne 0) {
    throw "${Label}_exit_$($Process.ExitCode)"
  }
}

function Get-ProcessTree([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $pending = @($RootPid)
  $tree = @()
  while ($pending.Count -gt 0) {
    $parent = $pending[0]
    $pending = @($pending | Select-Object -Skip 1)
    $children = @($all | Where-Object { $_.ParentProcessId -eq $parent })
    $tree += $children
    if ($children.Count -gt 0) { $pending += @($children.ProcessId) }
  }
  return @($tree | Sort-Object ProcessId -Descending)
}

function Stop-InstalledProcessTree([Diagnostics.Process]$Process) {
  $root = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
  if (-not $root) { return }
  if ([IO.Path]::GetFullPath($root.Path) -ne [IO.Path]::GetFullPath($installedExe)) {
    throw 'installed_process_path_changed'
  }
  $children = @(Get-ProcessTree $Process.Id)
  foreach ($child in $children) {
    Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(8)
  do {
    $remaining = @(
      @($Process.Id) + @($children.ProcessId) |
        ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    )
    if ($remaining.Count -eq 0) { return }
    foreach ($item in $remaining) {
      Stop-Process -Id $item.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)
  throw 'installed_process_cleanup_timeout'
}

function Read-Shortcut([string]$ShortcutPath) {
  if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    throw "shortcut_missing:$ShortcutPath"
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ne [IO.Path]::GetFullPath($installedExe)) {
    throw "shortcut_target_invalid:$ShortcutPath"
  }
  return [ordered]@{
    path = $ShortcutPath
    target = $shortcut.TargetPath
    workingDirectory = $shortcut.WorkingDirectory
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($Installer)) {
    $Installer = Join-Path $PSScriptRoot '..\release\Magic-Pointer-1.0.0-setup.exe'
  }
  $resolvedInstaller = (Resolve-Path -LiteralPath $Installer).Path
  $result.installer = $resolvedInstaller

  $existing = @(Get-MagicPointerUninstallEntries)
  $preexisting = $existing.Count -gt 0 `
    -or (Test-Path -LiteralPath $installedExe) `
    -or (Test-Path -LiteralPath $desktopShortcut) `
    -or (Test-Path -LiteralPath $startShortcut)
  if ($preexisting) {
    throw 'existing_installation_detected'
  }

  $installationOwned = $true
  $installProcess = Start-Process -FilePath $resolvedInstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
  Wait-ScopedProcess $installProcess $InstallTimeoutSeconds 'installer'

  $installDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 300
    $installed = (Test-Path -LiteralPath $installedExe) -and (Test-Path -LiteralPath $uninstaller)
  } while (-not $installed -and (Get-Date) -lt $installDeadline)
  if (-not $installed) { throw 'installed_files_missing' }
  if (@(Get-MagicPointerUninstallEntries).Count -ne 1) { throw 'uninstall_registry_invalid' }

  $result.shortcuts = @(
    Read-Shortcut $desktopShortcut
    Read-Shortcut $startShortcut
  )

  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $env:MAGIC_POINTER_USER_DATA_DIR = $runtimeDir
  $appProcess = Start-Process -FilePath $installedExe -ArgumentList '--background' -WindowStyle Hidden -PassThru
  $logPath = Join-Path $runtimeDir 'electron.log'
  $startupDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 300
    $running = Get-Process -Id $appProcess.Id -ErrorAction SilentlyContinue
  } while ($running -and -not (Test-Path -LiteralPath $logPath) -and (Get-Date) -lt $startupDeadline)
  if (-not $running) { throw 'installed_app_exited_during_startup' }
  if (-not (Test-Path -LiteralPath $logPath)) { throw 'installed_app_log_missing' }
  if ([IO.Path]::GetFullPath($running.Path) -ne [IO.Path]::GetFullPath($installedExe)) {
    throw 'installed_app_path_invalid'
  }
  $logText = Get-Content -LiteralPath $logPath -Raw
  $capsuleVisibleAtStartup = $logText -match 'stage renderer state=(targeting|frozen|capsule)'
  if ($capsuleVisibleAtStartup) { throw 'capsule_visible_at_startup' }
  $result.startup = [ordered]@{
    processId = $appProcess.Id
    executable = $running.Path
    logPath = $logPath
    logBytes = (Get-Item -LiteralPath $logPath).Length
    background = $true
    capsuleVisibleAtStartup = $false
  }
  $result.status = 'passed'
}
catch {
  $result.error = $_.Exception.Message
  $exitCode = 1
}
finally {
  $cleanupErrors = @()
  if ($appProcess) {
    try { Stop-InstalledProcessTree $appProcess } catch { $cleanupErrors += $_.Exception.Message }
  }
  if ($installationOwned -and (Test-Path -LiteralPath $uninstaller)) {
    try {
      $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/currentuser /S' -WindowStyle Hidden -PassThru
      Wait-ScopedProcess $uninstallProcess $UninstallTimeoutSeconds 'uninstaller'
      $uninstallDeadline = (Get-Date).AddSeconds($CleanupTimeoutSeconds)
      do {
        Start-Sleep -Milliseconds 300
        $removed = -not (Test-Path -LiteralPath $installedExe) `
          -and -not (Test-Path -LiteralPath $desktopShortcut) `
          -and -not (Test-Path -LiteralPath $startShortcut) `
          -and @(Get-MagicPointerUninstallEntries).Count -eq 0
      } while (-not $removed -and (Get-Date) -lt $uninstallDeadline)
      if (-not $removed) { throw 'uninstall_cleanup_incomplete' }
    } catch {
      $cleanupErrors += $_.Exception.Message
    }
  }
  if (Test-Path -LiteralPath $runtimeDir) {
    try {
      $resolvedRuntime = [IO.Path]::GetFullPath($runtimeDir)
      $resolvedSmokeRoot = [IO.Path]::GetFullPath($smokeRoot)
      if (-not $resolvedRuntime.StartsWith(
        $resolvedSmokeRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
      )) {
        throw 'install_smoke_cleanup_scope_invalid'
      }
      Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction Stop
    } catch {
      $cleanupErrors += $_.Exception.Message
    }
  }
  if ($null -eq $previousRuntimeDir) {
    Remove-Item Env:MAGIC_POINTER_USER_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:MAGIC_POINTER_USER_DATA_DIR = $previousRuntimeDir
  }
  $result.cleanup = [ordered]@{
    uninstalled = $installationOwned -and -not (Test-Path -LiteralPath $installedExe)
    smokeDataRemoved = -not (Test-Path -LiteralPath $runtimeDir)
    errors = $cleanupErrors
  }
  if ($cleanupErrors.Count -gt 0) {
    $result.status = 'failed'
    if (-not $result.error) { $result.error = 'installer_cleanup_failed' }
    $exitCode = 1
  }
}

$result | ConvertTo-Json -Depth 5 -Compress
if ($exitCode -ne 0) { exit $exitCode }
