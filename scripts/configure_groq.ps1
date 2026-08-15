$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    & npm.cmd run build:electron
    if ($LASTEXITCODE -ne 0) { throw "build:electron failed with exit code $LASTEXITCODE" }

    $secureKey = Read-Host 'Groq API key（输入不会回显）' -AsSecureString
    $secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr)
        if ([string]::IsNullOrWhiteSpace($plainKey)) { throw 'Groq API key 不能为空。' }
        $electron = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
        $plainKey | & $electron (Join-Path $repoRoot 'scripts\model_cli.js') configure-groq
        if ($LASTEXITCODE -ne 0) { throw "Groq 配置失败，exit code $LASTEXITCODE" }
    }
    finally {
        if ($secretPtr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr)
        }
        $plainKey = $null
    }
}
finally {
    Pop-Location
}
