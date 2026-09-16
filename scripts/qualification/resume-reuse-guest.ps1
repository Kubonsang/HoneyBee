$ErrorActionPreference='Stop'
$backup='C:\HoneyBeeQA\Preserved-final-20260914'
$installation='C:\Users\bonsang\AppData\Local\HoneyBee'
$roaming='C:\Users\bonsang\AppData\Roaming\HoneyBee'
$stage='ResumePreflight'
$lock=$null
function Plain-Path([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Reparse path refused: '+$cursor) }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
function Save-Record([string]$Name,$Value) {
    $stream=[IO.File]::Open((Join-Path $backup $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 8));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function No-RunningApp {
    foreach($process in @(Get-CimInstance Win32_Process)) {
        if ($process.Name -eq 'HoneyBee.exe' -or ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($installation+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($process.CommandLine -and $process.CommandLine.IndexOf($installation+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0)) { throw ('Close HoneyBee/CLI first: PID '+$process.ProcessId) }
    }
}
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if ($env:COMPUTERNAME -ne 'DESKTOP-9LT0JVV' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as the original unelevated QA guest user.' }
    Plain-Path $backup;Plain-Path $installation;Plain-Path $roaming
    $proofPath=Join-Path $PSScriptRoot 'vm-preservation-verified.json'
    if ((Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash -ne '14D23DE3C4987096EE0994A879A040A2C6A1E0044CEB6A0516A822CF45AE8A48') { throw 'Host preservation proof differs.' }
    $proof=Get-Content -Raw -LiteralPath $proofPath | ConvertFrom-Json
    $completed=Get-Content -Raw -LiteralPath (Join-Path $backup 'qa-cleanup-completed.json') | ConvertFrom-Json
    $names=@('desktop-update-20260913-104604','interruption-20260913-105901','setup-reboot-20260913-132834','setup-recovery-20260913-131723','startup-reboot-20260913-123412','startup-recovery-20260913-122739')
    if (-not $proof.ok -or -not $proof.chainVerified -or $completed.checkpointId -ne $proof.checkpointId -or @($completed.removed).Count -ne 6 -or @(Compare-Object $names @($completed.removed)).Count -ne 0) { throw 'Completed QA preservation/cleanup evidence differs.' }
    foreach($name in $names) { if(Test-Path -LiteralPath ('C:\HoneyBeeQA\'+$name)) {throw 'A cleaned QA tree exists again; review before resuming.'} }
    foreach($name in @('service-reset-result.json','original-service.json','original-service.reg','storage','installation','desktop-user-data','reuse-result.json')) {
        if (Test-Path -LiteralPath (Join-Path $backup $name)) { throw ('A service or app step already started: '+$name+'. Retain evidence for review.') }
    }
    $failures=@(Get-ChildItem -LiteralPath $backup -Filter 'failure-*.json' -File | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json })
    if (@($failures | Where-Object { $_.stage -eq 'PreservingEmptyService' }).Count -eq 0) { throw 'Expected service-elevation interruption evidence.' }
    $worker=Join-Path $PSScriptRoot 'reuse-guest-service.ps1'
    if ((Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash -ne '2CE9F58078DE793D8B1B0973E8113DAC8E5E031CF56A42F1AAE8ACD29BEDF680') { throw 'Service helper differs from reviewed bytes.' }
    No-RunningApp
    Plain-Path (Join-Path $backup 'reuse-resume.lock')
    $lock=[IO.File]::Open((Join-Path $backup 'reuse-resume.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    # Recheck after acquiring the lock; prior attempts may have advanced meanwhile.
    foreach($name in @('service-reset-result.json','original-service.json','original-service.reg')) {
        if(Test-Path -LiteralPath (Join-Path $backup $name)) {throw 'A service attempt already advanced.'}
    }
    $stage='PreservingEmptyService'
    Write-Host 'QA cleanup is already complete and will NOT run again. Select YES on the service administrator prompt.'
    $process=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$worker+'"') -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'Service operation is still running; do not launch another attempt.' }
    $service=Get-Content -Raw -LiteralPath (Join-Path $backup 'service-reset-result.json') | ConvertFrom-Json
    if (-not $service.ok) { throw ('Service step stopped: '+$service.error) }
    No-RunningApp
    $stage='PreservingInstallation'
    foreach($pair in @(@{source=$installation;name='installation'},@{source=$roaming;name='desktop-user-data'})) {
        if(Test-Path -LiteralPath $pair.source) {
            $target=Join-Path $backup $pair.name
            Plain-Path $pair.source;Plain-Path $target
            if([IO.Path]::GetFullPath($target) -ne ($backup+'\'+$pair.name) -or (Test-Path -LiteralPath $target)) {throw 'Preservation target differs or exists.'}
            Move-Item -LiteralPath $pair.source -Destination $target
        }
    }
    $clean=(-not(Test-Path -LiteralPath $installation)) -and (-not(Test-Path -LiteralPath 'C:\ProgramData\UnityWorkspaceStorage')) -and ($null -eq(Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'"))
    $free=(Get-PSDrive C).Free
    $result=[ordered]@{schemaVersion=1;ok=($clean -and $free -ge 16GB);cleanBaseline=$clean;freeBytes=$free;preservedAt=$backup;checkpointId=$proof.checkpointId;readyForQualification=($clean -and $free -ge 16GB);resumedAfterUacCancellation=$true}
    Save-Record 'reuse-result.json' $result
    $result | ConvertTo-Json
    if(-not $result.ok) {exit 1}
} catch {
    $failure=[ordered]@{ok=$false;stage=$stage;error=$_.Exception.Message;preservedAt=$backup}
    if($lock) {Save-Record ('resume-failure-'+[Guid]::NewGuid().ToString('N')+'.json') $failure}
    $failure | ConvertTo-Json
    Write-Host 'No QA cleanup was repeated. Keep the result for review.'
    exit 1
} finally {if($lock){$lock.Dispose()}}
