$ErrorActionPreference='Stop'
$backup='C:\HoneyBeeQA\Preserved-final-20260914'
$store='C:\ProgramData\UnityWorkspaceStorage'
$result=[ordered]@{schemaVersion=1;ok=$false;stage='Preflight'}
$recordDirectoryVerified=$false
function Plain-Path([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Reparse path refused: '+$cursor) }
        }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if ($env:COMPUTERNAME -ne 'DESKTOP-9LT0JVV' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001' -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Wrong guest/user or missing elevation.' }
    Plain-Path $backup
    Plain-Path $store
    if (-not (Test-Path -LiteralPath (Join-Path $backup 'qa-cleanup-completed.json'))) { throw 'QA preservation must complete first.' }
    $recordDirectoryVerified=$true
    $proof=Get-Content -Raw -LiteralPath (Join-Path $backup 'checkpoint.json')|ConvertFrom-Json
    if (-not $proof.ok -or -not $proof.chainVerified -or $proof.checkpointId -ne 'b59b1f40-cd3b-412b-a301-1d7775179aca') { throw 'Wrong preservation checkpoint.' }
    if (Test-Path -LiteralPath (Join-Path $backup 'storage')) { throw 'Preserved storage already exists; review previous attempt.' }
    $receiptPath=Join-Path $store 'install-receipt.json'
    $receipt=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    $executable=Join-Path $store 'broker\unity-workspace-storage-host.exe'
    Plain-Path $executable
    if ($receipt.serviceName -ne 'UnityWorkspaceStorage' -or $receipt.storeRoot -ne $store -or $receipt.executable -ne $executable -or $receipt.userSid -ne $identity.User.Value -or $receipt.workspaceRoot -ne 'C:\Users\bonsang\AppData\Local\HoneyBee\Workspaces') { throw 'Installed receipt identity differs.' }
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $receipt.executableSha256) { throw 'Service binary differs from receipt.' }
    Plain-Path $receipt.workspaceRoot
    if ((Test-Path -LiteralPath $receipt.workspaceRoot) -and @(Get-ChildItem -LiteralPath $receipt.workspaceRoot -Force).Count -gt 0) { throw 'Workspace directory is not empty; preserve without removing service.' }
    $registry='C:\Users\bonsang\AppData\Local\HoneyBee\workspace-core\workspace-registry-v2.json'
    Plain-Path $registry
    if (Test-Path -LiteralPath $registry) {
        $entries=Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
        if ($null -eq $entries.projects -or $null -eq $entries.workspaces -or @($entries.projects).Count -ne 0 -or @($entries.workspaces).Count -ne 0) { throw 'Registry is not explicitly empty.' }
    }
    $allowed=@('broker\unity-workspace-storage-host.exe','broker-config.json','install-receipt.json')
    # Inspect each directory before descending; never follow a junction.
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($store)
    $found=[Collections.Generic.List[string]]::new()
    while ($pending.Count) {
        $directory=$pending.Pop();Plain-Path $directory
        foreach ($file in @(Get-ChildItem -LiteralPath $directory -Force)) {
            Plain-Path $file.FullName
            if ($file.PSIsContainer) { $pending.Push($file.FullName) } else { $found.Add($file.FullName.Substring($store.Length+1)) }
        }
    }
    if ($found.Count -ne 3 -or @($found | Where-Object { $_ -notin $allowed }).Count) { throw 'Storage contains unexpected files; no reset performed.' }
    $services=@(Get-CimInstance Win32_Service -Filter "Name LIKE 'UnityWorkspaceStorage%'")
    if ($services.Count -ne 1) { throw 'Unexpected service/recovery registrations.' }
    $service=$services[0]
    if ($service.Name -ne 'UnityWorkspaceStorage' -or $service.StartName -ne 'LocalSystem' -or $service.StartMode -ne 'Auto' -or $service.PathName -ne ($executable+' broker-run --service-config '+$store+'\broker-config.json')) { throw 'Service configuration differs.' }
    $service | Select-Object Name,State,StartMode,StartName,PathName | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'original-service.json') -Encoding UTF8
    & "$env:SystemRoot\System32\reg.exe" export 'HKLM\SYSTEM\CurrentControlSet\Services\UnityWorkspaceStorage' (Join-Path $backup 'original-service.reg') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SCM configuration export failed.' }
    $result.stage='Stopping'
    if ($service.State -ne 'Stopped') {
        Stop-Service -Name UnityWorkspaceStorage -ErrorAction Stop
        $controller=Get-Service -Name UnityWorkspaceStorage
        try {$controller.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30))} finally {$controller.Dispose()}
    }
    $result.stage='RemovingEmptyQAService'
    & "$env:SystemRoot\System32\sc.exe" delete UnityWorkspaceStorage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SCM removal failed; preserved files remain.' }
    if (Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'") { throw 'Service deletion is pending; preserve files and review.' }
    $result.stage='PreservingStorage'
    Plain-Path $store;Plain-Path (Join-Path $backup 'storage')
    Move-Item -LiteralPath $store -Destination (Join-Path $backup 'storage')
    if ((Get-FileHash -LiteralPath (Join-Path $backup 'storage\broker\unity-workspace-storage-host.exe') -Algorithm SHA256).Hash -ne $receipt.executableSha256) { throw 'Preserved service binary verification failed.' }
    $result.ok=$true;$result.stage='EmptyServiceRemovedAndFilesPreserved'
} catch {$result.error=$_.Exception.Message}
$json=$result|ConvertTo-Json -Depth 5
if ($recordDirectoryVerified) {
    $stream=[IO.File]::Open((Join-Path $backup 'service-reset-result.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {$bytes=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
Write-Host $json
if (-not $result.ok) {exit 1}
