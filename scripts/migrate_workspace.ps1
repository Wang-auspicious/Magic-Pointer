param(
    [Parameter(Mandatory=$true)][string]$InstalledRoot,
    [Parameter(Mandatory=$true)][string]$UserDataDir
)
$ErrorActionPreference = 'Stop'

$oldState = Join-Path $InstalledRoot 'resources\app\data\runtime\workspace.txt'
$newState = Join-Path $UserDataDir 'workspace.txt'
if ((Test-Path -LiteralPath $newState -PathType Leaf) -or
    -not (Test-Path -LiteralPath $oldState -PathType Leaf)) { return }

$selected = (Get-Content -LiteralPath $oldState -Raw -Encoding UTF8).Trim()
if (-not $selected -or -not (Test-Path -LiteralPath $selected -PathType Container)) { return }
New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
Copy-Item -LiteralPath $oldState -Destination $newState
