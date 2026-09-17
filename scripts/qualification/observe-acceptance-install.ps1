$ErrorActionPreference='Stop'
$machine=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($machine.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Use the temporary HoneyBee-Acceptance-beta32 VM.'}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run in ordinary PowerShell as the original user, without elevation.'}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$prior=Join-Path $PSScriptRoot 'Evidence-install'
$evidence=Join-Path $PSScriptRoot ('Evidence-installed-observation-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$result=[ordered]@{schemaVersion=1;installationObserved=$false;uacCancellationPassed=$false;acceptancePromoted=$false;publicationAllowed=$false;evidence=$evidence}
try {
    $setup=Join-Path $PSScriptRoot 'HoneyBeeSetup.exe'
    $digest=(Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if($digest -ne '8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e'){throw 'Candidate Setup differs.'}
    $result.setupSha256=$digest
    $result.priorEvidence=@(Get-ChildItem -LiteralPath $prior -File | ForEach-Object {
        @{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash;modifiedUtc=$_.LastWriteTimeUtc.ToString('o')}
    })
    $result.pointer=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($result.pointer.activeVersion -ne '0.1.0-beta.32'){throw 'Expected installed beta.32.'}
    $healthPaths=@((Join-Path $root '.setup-pending\health.json'))
    $retryRoot=Join-Path $root 'update\setup-retries'
    if(Test-Path -LiteralPath $retryRoot){$healthPaths+=@(Get-ChildItem -LiteralPath $retryRoot -Filter health.json -File -Recurse | Select-Object -ExpandProperty FullName)}
    $result.setupHealth=@(foreach($path in $healthPaths){if(Test-Path -LiteralPath $path){
        @{path=$path;modifiedUtc=(Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o');value=(Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)}
    }})
    $result.service=Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'" | Select-Object Name,State,StartMode,StartName,PathName
    if($result.service.State -ne 'Running' -or $result.service.StartName -ne 'LocalSystem'){throw 'Expected running LocalSystem storage service.'}
    $doctorText=(& (Join-Path $root 'bin\honeybee.exe') doctor --json 2> (Join-Path $evidence 'doctor-stderr.txt') | Out-String)
    $result.doctorExitCode=$LASTEXITCODE
    $doctorText | Set-Content -LiteralPath (Join-Path $evidence 'doctor.json') -Encoding UTF8
    $result.doctor=$doctorText | ConvertFrom-Json
    if($result.doctorExitCode -ne 0 -or $result.doctor.ready -ne $true){throw 'Installed Doctor is not ready.'}
    Write-Host 'Open HoneyBee from the desktop shortcut if it is not already open.'
    $answer=Read-Host 'Is the actual HoneyBee main window visible and usable? Type YES to confirm'
    if($answer -cne 'YES'){throw 'Desktop confirmation not supplied.'}
    $result.desktopObserved=$true
    $result.installationObserved=$true
    $result.ok=$true
} catch {$result.ok=$false;$result.error=$_.Exception.Message}
$result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 20
Write-Host 'Prior evidence retained. No installer, cancellation test, or update was replayed. UAC cancellation remains unverified.'
if(-not $result.ok){exit 1}
