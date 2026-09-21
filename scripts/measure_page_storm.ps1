# Names whatever is driving the hard page faults.
#
# The launch and idle runs both showed storms of 50k-100k pages in per second
# with the disk pinned, and the idle run was the worse of the two. That points
# at ambient commit pressure rather than at Magic Pointer, so this attributes
# the faults per process instead of assuming.
param(
  [int]$Seconds = 120,
  [string]$Out = 'data/runtime/overlay-launch',
  # Off by default: the idle control is what makes the launch numbers mean
  # anything, so it has to be possible to run this with nothing launched.
  [switch]$Launch,
  # Same Electron binary, empty main process. Separates "Electron starting on
  # this machine" from "Magic Pointer starting".
  [switch]$Bare,
  [int]$LaunchDelaySeconds = 12
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$before = Get-CimInstance Win32_OperatingSystem
$commitLimitMb = [math]::Round($before.TotalVirtualMemorySize / 1024)
$commitUsedMb = [math]::Round(($before.TotalVirtualMemorySize - $before.FreeVirtualMemory) / 1024)

$work = $null
$rows = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# The first Get-Counter call needs a baseline and costs a few seconds. Hold
# the launch back until sampling is warm, or the spawn window is missed and
# the control proves nothing.
if ($Bare) {
  $work = Start-Job -ArgumentList $root, $LaunchDelaySeconds -ScriptBlock {
    param($root, $delay)
    Start-Sleep -Seconds $delay
    Set-Location $root
    & "$root\node_modules\.bin\electron.cmd" "$root\scripts\probe_bare_electron.cjs" --isolated
  } -Name overlaywork
} elseif ($Launch) {
  $work = Start-Job -ArgumentList $root, $LaunchDelaySeconds -ScriptBlock {
    param($root, $delay)
    Start-Sleep -Seconds $delay
    Set-Location $root
    & "$root\node_modules\.bin\electron.cmd" .
  } -Name overlaywork
}

$seenElectron = 0
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $total = Get-Counter -Counter @(
    '\Memory\Pages Input/sec',
    '\Memory\Available MBytes',
    '\PhysicalDisk(_Total)\% Disk Time'
  ) -ErrorAction SilentlyContinue
  $pagesIn = [math]::Round((($total.CounterSamples | Where-Object { $_.Path -like '*pages input/sec' }).CookedValue), 0)
  $freeMb = [math]::Round((($total.CounterSamples | Where-Object { $_.Path -like '*available mbytes' }).CookedValue), 0)
  $diskPct = [math]::Round((($total.CounterSamples | Where-Object { $_.Path -like '*% disk time' }).CookedValue), 0)
  $os = Get-CimInstance Win32_OperatingSystem
  $commitMb = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1024)

  # Per-process faults only matter when there is a storm to attribute; the
  # full instance walk is expensive, so it runs conditionally.
  # Faults name the victims: when one process commits a lot, everyone else's
  # pages get trimmed and faulted back in. Disk reads name whoever actually
  # pulled bytes off the volume, which is the one that started it.
  $culprits = @()
  $readers = @()
  if ($pagesIn -gt 5000) {
    $per = Get-Counter -Counter '\Process(*)\Page Faults/sec' -ErrorAction SilentlyContinue
    $culprits = @($per.CounterSamples |
      Where-Object { $_.CookedValue -gt 500 -and $_.InstanceName -notin @('_total', 'idle', 'memory') } |
      Sort-Object CookedValue -Descending | Select-Object -First 8 |
      ForEach-Object { "$($_.InstanceName)=$([math]::Round($_.CookedValue))" })

    $io = Get-Counter -Counter '\Process(*)\IO Read Bytes/sec' -ErrorAction SilentlyContinue
    $readers = @($io.CounterSamples |
      Where-Object { $_.CookedValue -gt 4MB -and $_.InstanceName -notin @('_total', 'idle', 'memory') } |
      Sort-Object CookedValue -Descending | Select-Object -First 6 |
      ForEach-Object { "$($_.InstanceName)=$([math]::Round($_.CookedValue/1MB,1))MB/s" })
  }

  # Count Electron processes so a storm can be tied to the launch rather than
  # to whatever else the machine was doing.
  $electronCount = @(Get-Process -Name electron -ErrorAction SilentlyContinue).Count
  if ($electronCount -gt $seenElectron) { $seenElectron = $electronCount }

  $rows.Add([pscustomobject]@{
    atMs          = [math]::Round($sw.Elapsed.TotalMilliseconds)
    pagesIn       = $pagesIn
    freeMb        = $freeMb
    commitMb      = $commitMb
    diskPct       = $diskPct
    electronProcs = $electronCount
    culprits      = ($culprits -join ' ')
    readers       = ($readers -join ' ')
  }) | Out-Null
  Start-Sleep -Milliseconds 700
}

if ($work) {
  Stop-Job $work -ErrorAction SilentlyContinue
  Remove-Job $work -Force -ErrorAction SilentlyContinue
}

$rows | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $Out 'page-storm.json')

$storms = @($rows | Where-Object { $_.pagesIn -gt 5000 })
Write-Host "commitLimitMb=$commitLimitMb commitUsedAtStartMb=$commitUsedMb samples=$($rows.Count) storms=$($storms.Count)"
Write-Host ("avgPagesIn={0} maxPagesIn={1} maxCommitMb={2} minFreeMb={3}" -f `
  [math]::Round(($rows | Measure-Object pagesIn -Average).Average), `
  ($rows | Measure-Object pagesIn -Maximum).Maximum, `
  ($rows | Measure-Object commitMb -Maximum).Maximum, `
  ($rows | Measure-Object freeMb -Minimum).Minimum)
Write-Host "--- storms ---"
foreach ($s in $storms) {
  Write-Host ("t+{0,6}ms pagesIn={1,7} commit={2,6}MB free={3,5}MB disk={4,4}% electron={5,2}" -f $s.atMs, $s.pagesIn, $s.commitMb, $s.freeMb, $s.diskPct, $s.electronProcs)
  Write-Host ("           faults: {0}" -f $s.culprits)
  Write-Host ("           reads : {0}" -f $s.readers)
}
Write-Host "--- all samples (page-in vs electron count) ---"
foreach ($s in $rows) {
  Write-Host ("t+{0,6}ms pagesIn={1,7} commit={2,6}MB free={3,5}MB electron={4,2}" -f $s.atMs, $s.pagesIn, $s.commitMb, $s.freeMb, $s.electronProcs)
}
