$ErrorActionPreference='Stop'
try {
    $root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $pin=Get-Content -Raw -LiteralPath (Join-Path $root 'qualification.json') | ConvertFrom-Json
    if ($env:COMPUTERNAME -ne $pin.computerName) { throw 'Wrong QA computer' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $pin.userSid) { throw 'Run as the original installing user' }
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run without administrator elevation' }
    if ((Get-PSDrive -Name C).Free -lt 8GB) { throw 'At least 8 GiB free disk space required' }
    $installation=Join-Path $env:LOCALAPPDATA 'HoneyBee'
    if ($pin.desktopLifecycle) { $installation=Join-Path $root 'source' }
    $node=Join-Path $installation ('versions\'+$pin.version+'\runtime\node.exe')
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.nodeSha256) { throw 'Private Node digest mismatch' }
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $env:HONEYBEE_QA_BOOT_ID=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    & $node (Join-Path $PSScriptRoot 'guest-two-version.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Qualification did not pass; retain the evidence' }
    Write-Host 'Two-version qualification PASSED' -ForegroundColor Green
} catch { Write-Host $_ -ForegroundColor Red }
Read-Host 'Leave the VM running. Tell Codex the result. Press Enter to close'
