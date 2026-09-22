# Measures what `npm run overlay` actually does to the machine.
#
#   powershell -File scripts/measure_overlay_launch.ps1 -Phase build
#   powershell -File scripts/measure_overlay_launch.ps1 -Phase launch
param(
  [string]$Phase = 'build',
  [string]$Out = 'data/runtime/overlay-launch',
  [int]$MaxSeconds = 120
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$totalMb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)

$counters = @(
  '\Processor(_Total)\% Processor Time',
  '\Memory\Available MBytes',
  '\Memory\Pages Input/sec',
  '\Memory\Page Faults/sec',
  '\Paging File(_Total)\% Usage',
  '\PhysicalDisk(_Total)\% Disk Time',
  '\PhysicalDisk(_Total)\Avg. Disk Queue Length'
)

# The measured command goes in a job so the sampling loop stays in this
# runspace, where the samples are actually readable.
if ($Phase -eq 'build') {
  $script = 'Set-Location $args[0]; & npm run build:electron'
} elseif ($Phase -eq 'idle') {
  # Control: how much paging the machine does with nothing asked of it. If
  # this is already in the thousands, the trigger is ambient memory pressure,
  # not the launch itself.
  $script = 'Start-Sleep -Seconds 90'
} else {
  $script = 'Set-Location $args[0]; & "$($args[0])\node_modules\.bin\electron.cmd" .'
}
$work = Start-Job -ArgumentList $root -ScriptBlock ([scriptblock]::Create($script)) -Name overlaywork

$prev = @{}
$samples = New-Object System.Collections.Generic.List[object]
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$tick = 0

while ($work.State -eq 'Running' -and $sw.Elapsed.TotalSeconds -lt $MaxSeconds) {
  Start-Sleep -Milliseconds 400
  $tick++

  # Process CPU deltas and cold starts. The first tick has no baseline, so
  # every process would look new; skip it.
  $procs = @(Get-Process -ErrorAction SilentlyContinue)
  $top = @()
  $new = @()
  $current = @{}
  foreach ($p in $procs) {
    $id = $p.Id
    $cpu = [double]$p.CPU
    $current[$id] = $cpu
    if ($prev.ContainsKey($id)) {
      $delta = $cpu - $prev[$id]
      if ($delta -gt 0.1) {
        $top += [pscustomobject]@{ name = $p.ProcessName; pid = $id; cpuS = [math]::Round($delta, 2) }
      }
    } elseif ($tick -gt 1 -and $p.WorkingSet64 -gt 20MB) {
      $new += "$($p.ProcessName):$([math]::Round($p.WorkingSet64 / 1MB))MB"
    }
  }
  $prev = $current

  $sample = Get-Counter -Counter $counters -ErrorAction SilentlyContinue
  $v = @{}
  foreach ($s in $sample.CounterSamples) { $v[$s.Path] = $s.CookedValue }
  $cpu = [math]::Round($v['\\' + $env:COMPUTERNAME.ToLower() + '\processor(_total)\% processor time'], 1)
  if (-not $cpu) {
    $cpu = [math]::Round(($sample.CounterSamples | Where-Object { $_.Path -like '*% processor time' }).CookedValue, 1)
  }

  $samples.Add([pscustomobject]@{
    atMs      = [math]::Round($sw.Elapsed.TotalMilliseconds)
    cpuPct    = $cpu
    freeMb    = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*available mbytes' }).CookedValue), 0)
    pagesIn   = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*pages input/sec' }).CookedValue), 0)
    pfPerSec  = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*page faults/sec' }).CookedValue), 0)
    pageFile  = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*% usage' }).CookedValue), 1)
    diskPct   = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*% disk time' }).CookedValue), 1)
    diskQueue = [math]::Round((($sample.CounterSamples | Where-Object { $_.Path -like '*avg. disk queue length' }).CookedValue), 2)
    procs     = $procs.Count
    top       = ($top | Sort-Object cpuS -Descending | Select-Object -First 6)
    spawned   = ($new -join ',')
  }) | Out-Null
}

$workOutput = @(Receive-Job $work -ErrorAction SilentlyContinue)
$workState = $work.State
Stop-Job $work -ErrorAction SilentlyContinue
Remove-Job $work -Force -ErrorAction SilentlyContinue
$sw.Stop()

$mins = @{}
foreach ($field in 'freeMb', 'cpuPct', 'pagesIn', 'diskPct', 'diskQueue') {
  $mins[$field] = [math]::Round(($samples | Measure-Object -Property $field -Minimum).Minimum, 1)
}
$maxs = @{}
foreach ($field in 'cpuPct', 'pagesIn', 'pfPerSec', 'pageFile', 'diskPct', 'diskQueue') {
  $maxs[$field] = [math]::Round(($samples | Measure-Object -Property $field -Maximum).Maximum, 1)
}
$avgs = @{}
foreach ($field in 'cpuPct', 'pagesIn', 'diskPct') {
  $avgs[$field] = [math]::Round(($samples | Measure-Object -Property $field -Average).Average, 1)
}

$report = [pscustomobject]@{
  phase        = $Phase
  wallMs       = $sw.ElapsedMilliseconds
  workState    = $workState
  logicalCores = $cores
  totalRamMb   = $totalMb
  sampleCount  = $samples.Count
  min          = $mins
  max          = $maxs
  avg          = $avgs
  worst        = @($samples | Sort-Object pagesIn -Descending | Select-Object -First 8)
  coldStarts   = @($samples | Where-Object { $_.spawned })
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $Out "$Phase.json")
$samples | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $Out "$Phase-samples.json")

Write-Host ""
Write-Host "phase=$Phase wallMs=$($sw.ElapsedMilliseconds) state=$workState cores=$cores ramMb=$totalMb samples=$($samples.Count)"
Write-Host ("avgCpu={0}% avgPagesIn={1} avgDiskPct={2}%" -f $avgs['cpuPct'], $avgs['pagesIn'], $avgs['diskPct'])
Write-Host ("maxCpu={0}% maxPagesIn={1} maxDiskPct={2}% maxDiskQueue={3} minFreeMb={4}" -f $maxs['cpuPct'], $maxs['pagesIn'], $maxs['diskPct'], $maxs['diskQueue'], $mins['freeMb'])
Write-Host "--- worst samples by pages input ---"
foreach ($s in ($samples | Sort-Object pagesIn -Descending | Select-Object -First 8)) {
  $line = ($s.top | ForEach-Object { "$($_.name)=$($_.cpuS)s" }) -join ' '
  Write-Host ("t+{0,6}ms cpu={1,3}% free={2,5}MB pagesIn={3,7} disk={4,5}% q={5,4} procs={6,4}  {7}" -f $s.atMs, $s.cpuPct, $s.freeMb, $s.pagesIn, $s.diskPct, $s.diskQueue, $s.procs, $line)
}
Write-Host "--- cold starts ---"
foreach ($s in ($samples | Where-Object { $_.spawned })) {
  Write-Host ("t+{0,6}ms {1}" -f $s.atMs, $s.spawned)
}
Write-Host "--- measured command output (tail) ---"
$workOutput | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
