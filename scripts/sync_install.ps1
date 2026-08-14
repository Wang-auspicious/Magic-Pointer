# 本机同步更新：验证 -> 构建 -> 打包安装器 -> 静默安装 -> 重启应用。
# 用法：npm run sync（或直接 powershell -File scripts/sync_install.ps1）
# 之后用户从快捷方式/托盘照常使用，不需要终端。
param()

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "== typecheck =="
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }

Write-Host "== node tests =="
npx --no-install tsx scripts/run-node-tests.ts
if ($LASTEXITCODE -ne 0) { throw 'node tests failed' }

Write-Host "== python tests =="
python -m pytest tests/ -q --basetemp=data/runtime/pytest-tmp-verify
if ($LASTEXITCODE -ne 0) { throw 'python tests failed' }

Write-Host "== build installer =="
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw 'installer build failed' }

$installer = Get-ChildItem release -Filter "Magic-Pointer-*-x64.exe" |
    Where-Object { $_.Name -notlike '*__uninstaller*' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'installer not found in release/' }

# 本机同步用 win-unpacked 直接覆盖安装目录（比 NSIS 静默安装快且稳）。
# NSIS 安装器保留给最终用户（GitHub 发布）。
$installedDir = "$env:LOCALAPPDATA\Programs\Magic Pointer"
Write-Host "== sync install (win-unpacked -> $installedDir) =="
Get-Process "Magic Pointer" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Copy-Item "release\win-unpacked\*" -Destination $installedDir -Recurse -Force
Start-Sleep 1

$installedPackage = "$installedDir\resources\app\package.json"
if (Test-Path $installedPackage) {
    $installedVersion = (Get-Content $installedPackage | ConvertFrom-Json).version
    Write-Host "installed version: $installedVersion"
} else {
    Write-Host "installed: $($installer.Name) (version file not found at $installedPackage)"
}

# 本机 secrets（gitignored、不进安装包）：拷到用户数据目录，安装版模型 key 从那里读。
if (Test-Path "secrets") {
    $userSecrets = "$env:LOCALAPPDATA\Magic Pointer\secrets"
    New-Item -ItemType Directory -Path $userSecrets -Force | Out-Null
    Copy-Item "secrets\*.txt" -Destination $userSecrets -Force -ErrorAction SilentlyContinue
    Write-Host "secrets synced to $userSecrets"
}

Write-Host "== relaunch =="
Start-Process -FilePath "$env:LOCALAPPDATA\Programs\Magic Pointer\Magic Pointer.exe"
Write-Host "sync done"
