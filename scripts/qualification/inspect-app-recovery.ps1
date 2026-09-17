$ErrorActionPreference='Stop'
$vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Use HoneyBee-Acceptance-beta32.'}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$batch='C:\HoneyBeeQA\acceptance-completion-20260916\app-recovery'
$output=Join-Path $batch ('Inspection-'+[guid]::NewGuid().ToString('N')+'.json')
$errorsFound=[Collections.Generic.List[object]]::new()
function Read-Record([string]$File){
    if(-not (Test-Path -LiteralPath $File)){return $null}
    try {
        if((Get-Item -LiteralPath $File).Length -gt 1MB){throw 'Record exceeds inspection bound'}
        return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {$errorsFound.Add(@{path=$File;error=$_.Exception.Message});return $null}
}
$cases=@(Get-ChildItem -LiteralPath (Join-Path $batch 'Matrix') -Directory | Sort-Object Name | ForEach-Object {
    $case=$_.FullName
    @{name=$_.Name;completed=(Read-Record (Join-Path $case 'completed.json'));failed=(Read-Record (Join-Path $case 'failed.json'));interrupted=(Read-Record (Join-Path $case 'interrupted.json'));workerResult=(Read-Record (Join-Path $case 'worker-result.json'));started=(Read-Record (Join-Path $case 'started.json'))}
})
$recovery=@()
$attempts=Join-Path $root 'update\recovery-attempts'
if(Test-Path -LiteralPath $attempts){$recovery=@(Get-ChildItem -LiteralPath $attempts -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 4 | ForEach-Object {
    @{name=$_.Name;modifiedUtc=$_.LastWriteTimeUtc.ToString('o');result=(Read-Record (Join-Path $_.FullName 'result.json'))}
})}
$activations=@()
$activationRoot=Join-Path $root 'update\activations'
if(Test-Path -LiteralPath $activationRoot){$activations=@(Get-ChildItem -LiteralPath $activationRoot -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 2 | ForEach-Object {
    @{name=$_.Name;records=@(Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.json' | Sort-Object Name | ForEach-Object {@{name=$_.Name;value=(Read-Record $_.FullName)}})}
})}
$service=Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'" | Select-Object Name,State,ProcessId
$result=@{schemaVersion=1;readOnlyInspection=$true;testsRun=0;current=(Read-Record (Join-Path $root 'current.json'));bootTime=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');cases=$cases;recovery=$recovery;activations=$activations;service=$service;errors=@($errorsFound.ToArray());evidence=$output}
$result | ConvertTo-Json -Depth 35 | Set-Content -LiteralPath $output -Encoding UTF8
@{schemaVersion=1;readOnlyInspection=$true;testsRun=0;current=$result.current;bootTime=$result.bootTime;completedCases=@($cases | Where-Object {$null -ne $_.completed} | ForEach-Object {@{name=$_.name;preserved=$_.completed.preserved;recovery=$_.completed.recovery}});unfinishedCases=@($cases | Where-Object {$null -eq $_.completed});latestRecovery=$recovery;service=$service;errors=$result.errors;evidence=$output} | ConvertTo-Json -Depth 25
Write-Host 'Inspection only. No Launcher, Doctor, recovery, service change, or test replay.'
