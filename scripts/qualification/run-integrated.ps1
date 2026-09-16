param([string]$RetryCase, [switch]$ResumeMissingBeeDataset, [string]$OnlyCase, [switch]$ResumeFocusedBaseline)
$ErrorActionPreference = 'Stop'
try {
    if (@(@($RetryCase, $ResumeMissingBeeDataset.IsPresent, $OnlyCase) | Where-Object { $_ }).Count -gt 1) { throw 'Select only one reviewed recovery action' }
    if ($ResumeFocusedBaseline -and ($OnlyCase -ne 'poweroff-service-replaced' -or $RetryCase -or $ResumeMissingBeeDataset)) { throw 'Reviewed baseline resume is only for the focused power-off case' }
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $pin = Get-Content -Raw -LiteralPath (Join-Path $root 'guest.json') | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($env:COMPUTERNAME -ne $pin.computerName -or $identity.User.Value -ne $pin.userSid) { throw 'Wrong QA computer or user; nothing was installed' }
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as the original user without administrator elevation' }
    Write-Host 'Checking integrated runner files...'
    $inventory = Get-Content -Raw -LiteralPath (Join-Path $root 'runner-files.json') | ConvertFrom-Json
    foreach ($file in $inventory.files) {
        if ($file.path -notmatch '^[A-Za-z0-9._/-]+$' -or $file.path.Split('/') -contains '..' -or $file.path.StartsWith('/')) { throw 'Invalid runner inventory path' }
        $target = Join-Path $root $file.path
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Runner file changed: ' + $file.path) }
    }
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $qaArguments=@((Join-Path $PSScriptRoot 'guest-integrated.mjs'))
    if ($RetryCase) { $qaArguments+=@('--retry-case',$RetryCase) }
    if ($OnlyCase) { $qaMode=if($ResumeFocusedBaseline) {'--resume-focused-baseline'} else {'--only-case'}; $qaArguments+=@($qaMode,$OnlyCase) }
    if ($ResumeMissingBeeDataset) { $qaArguments+='--resume-missing-bee-dataset' }
    & (Join-Path $root 'runtime/node.exe') @qaArguments
    if ($LASTEXITCODE -eq 10) {
        $evidenceName=if ($OnlyCase) { 'Evidence-focused-'+$OnlyCase } else { 'Evidence' }
        $last=Get-ChildItem -LiteralPath (Join-Path $root $evidenceName) -Filter '*.json' | Sort-Object Name | Select-Object -Last 1
        $pending=Get-Content -Raw -LiteralPath $last.FullName|ConvertFrom-Json
        if ($pending.state -ne 'WaitingForRestart') { throw 'Restart evidence is missing' }
        if ($pending.detail.identity.scenario.action -eq 'reboot') {
            Write-Host 'Checkpoint evidence saved. Restarting this QA guest in five seconds; sign in and rerun the same command to continue.' -ForegroundColor Yellow
            & "$env:SystemRoot\System32\shutdown.exe" /r /t 5
            if ($LASTEXITCODE -ne 0) { throw 'Guest restart request failed' }
            exit 10
        }
        if ($pending.detail.identity.scenario.action -eq 'poweroff') {
            $caseDirectory=$pending.detail.caseRoot
            $worker=Get-Content -LiteralPath (Join-Path $caseDirectory 'worker.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($worker.nonce -notmatch '^[a-f0-9]{64}$') { throw 'Power-off nonce missing' }
            Write-Host 'Within five minutes, run this command in ADMINISTRATOR PowerShell ON THE HOST:' -ForegroundColor Yellow
            Write-Host ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\Documents\HoneyBee\scripts\qualification\host-poweroff.ps1" -GuestCaseDirectory "'+$caseDirectory+'" -Nonce "'+$worker.nonce+'"')
            Write-Host 'The command turns off only the pinned QA VM, starts it again, and delivers the required witness. Then sign in and rerun the same focused guest command.'
            Read-Host 'Keep this checkpoint window open until the host command turns the VM off'
            exit 10
        }
        Write-Host 'Checkpoint is held for up to five minutes. Restart Windows inside this VM, or use the supplied host power-off script for the poweroff case, then rerun this same command.' -ForegroundColor Yellow
        Read-Host 'Read the pending case above. Press Enter to close'
        exit 10
    }
    if ($LASTEXITCODE -ne 0) { throw 'Integrated flow stopped. Keep the bundle, Evidence, and installed recovery records. Do not rerun automatically.' }
    if ($OnlyCase) { Write-Host ('Focused case PASSED: '+$OnlyCase+'. The full qualification remains incomplete.') -ForegroundColor Green }
    else { Write-Host 'Integrated service/app sequence completed. This does not mark all 16 acceptance gates passed.' -ForegroundColor Green }
} catch {
    Write-Host $_ -ForegroundColor Red
    Read-Host 'Keep the VM running. Press Enter to close'
    exit 1
}
Read-Host 'Keep the VM running. Press Enter to close'
