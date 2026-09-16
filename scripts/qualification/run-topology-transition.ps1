param([switch]$Recover, [switch]$ResumePreparation, [switch]$Optical, [switch]$Quiesce, [switch]$Backup, [switch]$Compression, [switch]$Activity)
$ErrorActionPreference='Stop'
try {
    if ($Recover -and $ResumePreparation) { throw 'Select only one recovery action.' }
    if ($Optical -and $ResumePreparation) { throw 'The optical correction requires a new attempt, not preparation replay.' }
    if ($Quiesce -and ($Optical -or $ResumePreparation)) { throw 'Select only the new quiesce transition.' }
    if ($Backup -and ($Quiesce -or $Optical -or $ResumePreparation)) { throw "Select only the new backup transition." }
    if ($Compression -and ($Backup -or $Quiesce -or $Optical -or $ResumePreparation)) { throw "Select only the compression transition." }
    if ($Activity -and ($Compression -or $Backup -or $Quiesce -or $Optical -or $ResumePreparation)) { throw "Select only the activity transition." }
    $bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if ($env:COMPUTERNAME -ne 'DESKTOP-9LT0JVV' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001') { throw 'Run inside the original QA VM as bonsang.' }
    if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run without administrator elevation. Only the service prompt needs Yes.' }
    Write-Host 'Checking the reviewed transition runner...'
    $inventory=Get-Content -LiteralPath (Join-Path $bundle 'runner-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $inventory.files) {
        if ($item.path -notmatch '^[A-Za-z0-9._/-]+$' -or $item.path.StartsWith('/') -or $item.path.Split('/') -contains '..') { throw 'Unsafe runner inventory entry.' }
        if ((Get-FileHash -LiteralPath (Join-Path $bundle $item.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw ('Runner changed: '+$item.path) }
    }
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $qaArgs=@((Join-Path $PSScriptRoot 'guest-topology-transition.mjs'))
    if ($Activity) {
        if ($Recover) { $qaArgs+='--activity-recover' } else { $qaArgs+='--activity' }
    } elseif ($Compression) {
        if ($Recover) { $qaArgs+='--compression-recover' } else { $qaArgs+='--compression' }
    } elseif ($Backup) {
        if ($Recover) { $qaArgs+='--backup-recover' } else { $qaArgs+='--backup' }
    } elseif ($Quiesce) {
        if ($Recover) { $qaArgs+='--quiesce-recover' } else { $qaArgs+='--quiesce' }
    } elseif ($Optical) {
        if ($Recover) { $qaArgs+='--optical-recover' } else { $qaArgs+='--optical' }
    } elseif ($Recover) { $qaArgs+='--recover' }
    if ($ResumePreparation) { $qaArgs+='--resume-preparation' }
    & (Join-Path $bundle 'runtime/node.exe') @qaArgs
    if ($LASTEXITCODE -ne 0) { throw 'Transition stopped. Keep all files and send the result; do not rerun automatically.' }
    if ($Activity) { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology6\Execution.' -ForegroundColor Green }
    elseif ($Compression) { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology5\Execution.' -ForegroundColor Green }
    elseif ($Backup) { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology4\Execution.' -ForegroundColor Green }
    elseif ($Quiesce) { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology3\Execution.' -ForegroundColor Green }
    elseif ($Optical) { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology2\Execution.' -ForegroundColor Green }
    else { Write-Host 'QA baseline transition PASSED. Retain Transitions\topology1\Execution.' -ForegroundColor Green }
} catch {
    Write-Host $_ -ForegroundColor Red
    Read-Host 'Keep the VM running. Press Enter to close'
    exit 1
}
Read-Host 'Keep the VM running. Press Enter to close'
