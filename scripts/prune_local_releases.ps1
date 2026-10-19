# Keep the installer copied by a successful sync and remove old local build output.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$KeepInstaller
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'release')).ProviderPath.TrimEnd('\')
$releasePrefix = $releaseRoot + '\'
$keptInstaller = Get-Item -LiteralPath $KeepInstaller
if ($keptInstaller.PSIsContainer -or $keptInstaller.Name -notlike 'Magic-Pointer-*.exe' -or
    -not $keptInstaller.DirectoryName.Equals($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'KeepInstaller must be a Magic-Pointer-*.exe directly inside this project release directory.'
}
$keepNames = @($keptInstaller.Name, ($keptInstaller.Name + '.blockmap'))
$targets = @(Get-ChildItem -LiteralPath $releaseRoot -Force | Where-Object {
    if ($_.PSIsContainer) {
        $_.Name -match '^(sync-|audit-|win-unpacked$|win-unpacked-stale-)'
    } else {
        $_.Name -match '^Magic-Pointer-.+\.exe(?:\.blockmap)?$' -and $_.Name -notin $keepNames
    }
})

[long]$candidateBytes = 0
[long]$freedBytes = 0
$removedCount = 0
foreach ($target in $targets) {
    $resolved = (Resolve-Path -LiteralPath $target.FullName).ProviderPath
    if (-not $resolved.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to remove a target outside the release directory: $resolved"
    }
    [long]$bytes = if ($target.PSIsContainer) {
        (Get-ChildItem -LiteralPath $resolved -File -Recurse -Force |
            Measure-Object -Property Length -Sum).Sum
    } else { $target.Length }
    $candidateBytes += $bytes
    if ($PSCmdlet.ShouldProcess($resolved, 'Remove old local build output')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
        $freedBytes += $bytes
        $removedCount++
    }
}

Write-Host ("Released {0:N0} bytes ({1:N2} GB); kept {2}" -f $freedBytes, ($freedBytes / 1GB), $keptInstaller.Name)
[PSCustomObject]@{
    ReleaseRoot = $releaseRoot
    KeptInstaller = $keptInstaller.FullName
    RemovedCount = $removedCount
    CandidateBytes = $candidateBytes
    FreedBytes = $freedBytes
    FreedGB = [Math]::Round($freedBytes / 1GB, 3)
}
