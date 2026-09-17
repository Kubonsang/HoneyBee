$ErrorActionPreference='Stop'
$expectedHash='8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e'
$setup=Join-Path $PSScriptRoot 'HoneyBeeSetup.exe'
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$evidence=Join-Path $PSScriptRoot 'Evidence-install'
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as the original user WITHOUT elevation.'}
$machine=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($machine.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Only the temporary acceptance VM is admitted.'}
if((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne $expectedHash){throw 'Setup bytes differ'}
if(Test-Path -LiteralPath $evidence){
    foreach($name in @('failed.json','completed.json','uac-observation.json')){
        $prior=Join-Path $evidence $name
        if(Test-Path -LiteralPath $prior){Write-Host $name;Get-Content -LiteralPath $prior -Raw -Encoding UTF8 | Write-Host}
    }
    throw 'Prior install attempt exists. Retain it; no automatic replay.'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
function Record([string]$Name,$Value){
    $file=Join-Path $evidence ($Name+'.json')
    $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Service {Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'"}
function Run-Setup {
    $process=Start-Process -FilePath $setup -PassThru
    $process.WaitForExit()
    return $process.ExitCode
}
$stage='baseline'
try {
    Check (-not (Test-Path -LiteralPath $root)) 'Existing installation preserved; clean checkpoint required.'
    Check (-not (Test-Path -LiteralPath 'C:\ProgramData\UnityWorkspaceStorage')) 'Existing store preserved; clean checkpoint required.'
    Check ($null -eq (Service)) 'Existing service preserved.'
    Check ((Get-PSDrive C).Free -ge 16GB) 'Initial QA capacity below 16 GiB; no Setup started.'
    Record 'baseline' @{clean=$true;vm=$machine.VirtualMachineName;setupSha256=$expectedHash;userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}
    $stage='git-unavailable'
    Write-Host 'Step 1/3: Git unavailable in Setup PATH. Expect the Git requirement message; select No and close Setup.'
    $originalPath=$env:PATH
    try {
        $env:PATH="$env:SystemRoot\System32;$env:SystemRoot"
        Check ($null -eq (Get-Command git.exe -ErrorAction SilentlyContinue)) 'Git is still executable in the restricted PATH.'
        $exit=Run-Setup
    } finally {$env:PATH=$originalPath}
    Check ($exit -eq 3) "Missing Git exit code was $exit; expected 3."
    Check (-not (Test-Path -LiteralPath $root)) 'Missing Git unexpectedly published the installation.'
    Check ($null -eq (Service)) 'Missing Git unexpectedly installed a service.'
    Record 'git-unavailable' @{passed=$true;exitCode=$exit;method='process-only PATH isolation; existing Git installation unchanged'}
    Check ($null -ne (Get-Command git.exe -ErrorAction SilentlyContinue)) 'Restore/install Git before continuing; no service attempt started.'
    $stage='uac-cancel'
    Write-Host 'Step 2/3: Select NO on the service administrator prompt, then close the Setup attention message/window.'
    $exit=Run-Setup
    $cancelService=Service
    $healthPath=Join-Path $root '.setup-pending\health.json'
    $health=if(Test-Path -LiteralPath $healthPath){Get-Content -LiteralPath $healthPath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
    Record 'uac-observation' @{exitCode=$exit;service=($cancelService | Select-Object Name,State,StartMode,StartName,PathName);health=$health;receiptExists=(Test-Path -LiteralPath 'C:\ProgramData\UnityWorkspaceStorage\install-receipt.json')}
    Check ($exit -eq 2) "Cancelled service exit code was $exit; expected 2."
    Check ($null -eq $cancelService) 'Service exists after cancellation; see uac-observation.json for the actual Setup health reason.'
    Check ($health.ready -eq $false -and $health.serviceAction -eq 'needs-attention') 'Cancellation health record differs.'
    Check ($health.reason -match 'elevation-cancelled|installation was cancelled') 'Cancellation reason not confirmed.'
    Record 'uac-cancel' @{passed=$true;exitCode=$exit;health=$health}
    $stage='retry-install'
    Write-Host 'Step 3/3: Select YES on the service administrator prompt. Close Setup after completion; leave HoneyBee open.'
    $exit=Run-Setup
    Check ($exit -eq 0) "Retry exit code was $exit; expected 0."
    $doctorText=(& (Join-Path $root 'bin\honeybee.exe') doctor --json | Out-String)
    Check ($LASTEXITCODE -eq 0) 'Doctor failed after installation.'
    $doctor=$doctorText | ConvertFrom-Json
    Check ($doctor.ready -eq $true) 'Doctor is not ready.'
    $pointer=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Check ($pointer.activeVersion -eq '0.1.0-beta.32') 'Installed version differs.'
    $service=Service
    Check ($service.State -eq 'Running' -and $service.StartName -eq 'LocalSystem') 'Service is not running as LocalSystem.'
    $answer=Read-Host 'Is the real HoneyBee main window visible and usable? Type YES to confirm'
    Check ($answer -ceq 'YES') 'Desktop UI confirmation not supplied.'
    Record 'completed' @{schemaVersion=1;setupSha256=$expectedHash;freshSetupPassed=$true;gitUacPassed=$true;desktopObserved=$true;doctor=$doctor;publicationAllowed=$false}
    Write-Host "Fresh Setup / Git / UAC qualification PASSED. Evidence: $evidence"
} catch {
    Record 'failed' @{schemaVersion=1;stage=$stage;error=$_.Exception.Message;automaticReplay=$false}
    Write-Host "Stopped at ${stage}: $($_.Exception.Message)"
    Write-Host "Retain evidence: $evidence"
    exit 1
}
