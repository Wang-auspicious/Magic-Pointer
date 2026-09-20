param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$InstalledRoot
)
$ErrorActionPreference = 'Stop'
$sourceBase = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$installedBase = [IO.Path]::GetFullPath($InstalledRoot).TrimEnd('\')
if ($sourceBase -eq $installedBase) { throw 'Source and installation must differ' }

# These directories contain only packaged code. User data and secrets are not
# mirrored, including any historical data directory under resources/app.
$ownedRuntimeDirectories = @('resources\app\app', 'resources\app\build', 'resources\app\scripts', 'resources\python-runtime')
foreach ($relative in $ownedRuntimeDirectories) {
    $sourceDirectory = [IO.Path]::GetFullPath((Join-Path $sourceBase $relative))
    $installedDirectory = [IO.Path]::GetFullPath((Join-Path $installedBase $relative))
    if (-not $sourceDirectory.StartsWith($sourceBase + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not $installedDirectory.StartsWith($installedBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime directory escaped its expected root'
    }
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { continue }
    & robocopy.exe $sourceDirectory $installedDirectory /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Runtime mirror failed for $relative ($LASTEXITCODE)" }
}
exit 0
