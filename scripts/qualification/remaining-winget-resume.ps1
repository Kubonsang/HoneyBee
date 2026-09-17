$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$evidence=Join-Path $bundle 'Public-Evidence'
$retry=Join-Path $evidence 'Winget-Interactive-Retry'
if(Test-Path -LiteralPath (Join-Path $retry 'completed.json')){Get-Content -LiteralPath (Join-Path $retry 'completed.json') -Raw;exit}
if(Test-Path -LiteralPath $retry){throw 'Prior WinGet retry exists; retain evidence without automatic replay'}
$inputs=Get-Content -LiteralPath (Join-Path $bundle 'inputs.json') -Raw -Encoding UTF8|ConvertFrom-Json
$originalExit=Get-Content -LiteralPath (Join-Path $evidence 'winget-exit.json') -Raw -Encoding UTF8|ConvertFrom-Json
$originalLog=Get-Content -LiteralPath (Join-Path $evidence 'winget-install.stdout.log') -Raw -Encoding UTF8
$failure=Get-Content -LiteralPath (Join-Path $evidence 'resume-failed-input-002.json') -Raw -Encoding UTF8|ConvertFrom-Json
$updated=Get-Content -LiteralPath (Join-Path $evidence 'download-retry.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($originalExit.exitCode -ne -1978335226 -or $failure.error -cne 'Actual public-URL WinGet installation failed' -or $originalLog -notmatch 'Successfully verified installer hash' -or $originalLog -notmatch 'Installer failed with exit code: 1'){throw 'Unreviewed installer failure'}
if($updated.activeVersion -ne '0.1.0-beta.35' -or -not $updated.preserved -or -not $updated.observed){throw 'Completed update evidence missing'}
if($inputs.candidate.setupSha256 -ne '643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04' -or $inputs.candidate.manifestSha256 -ne '5d895f4e603c423ea99e3387e61f2e2fa02dd54a7f9436a9be7b68e8179c7df4'){throw 'Candidate differs'}
$manifest=Join-Path $evidence 'Kubonsang.HoneyBee.yaml'
if((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputs.publicDelivery.wingetManifestSha256){throw 'WinGet manifest differs'}
$release=Invoke-RestMethod -Uri $inputs.publicDelivery.releaseApi -Headers @{'User-Agent'='HoneyBee-Qualification'}
$oldRelease=Get-Content -LiteralPath (Join-Path $evidence 'public-release.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($release.draft -or -not $release.prerelease -or $release.id -ne $oldRelease.id -or $release.tag_name -ne 'v0.1.0-beta.35'){throw 'Exact public release unavailable'}
$node=Join-Path $bundle 'runtime\node.exe'
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
& $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') after
if($LASTEXITCODE -ne 0){throw 'Existing updated installation or preserved data differs'}
Write-Host 'Only WinGet installation remains. Keep beta.35 installed; the app download and update are not repeated.'
Write-Host 'The earlier progress answer contained a version number, not an observation. This question records only what you actually saw.'
do {$seen=Read-Host 'Did you see the download progress bar advance earlier? Y=yes, N=not observed'}while($seen -notin @('Y','N'))
$progressObserved=$seen -ieq 'Y'
do {$closed=Read-Host 'Close HoneyBee normally, then type CLOSED (STOP to stop)';if($closed -ieq 'STOP'){throw 'Stopped before WinGet retry'}}while($closed -cne 'CLOSED')
if(@(Get-Process -Name HoneyBee -ErrorAction SilentlyContinue|Where-Object {$_.Path -like ($root+'\*')}).Count){throw 'HoneyBee is still running'}
New-Item -ItemType Directory -Path $retry|Out-Null
function Record([string]$Name,$Value){
 $file=Join-Path $retry ($Name+'.json');$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
try {
 Record 'reviewed' @{schemaVersion=1;priorExitCode=$originalExit.exitCode;priorInstallerArgs='/S';argsAttribution='User supplied WinGet diagnostic log';candidate=$inputs.candidate;progressObserved=$progressObserved;originalEvidencePreserved=$true}
 Write-Host 'Running WinGet with --interactive. Complete the Setup window, approve UAC if requested, and close Setup when finished.'
 $wingetPath=(Get-Command winget.exe -ErrorAction Stop).Source
 $installer=Start-Process -FilePath $wingetPath -WindowStyle Hidden -Wait -PassThru -ArgumentList @('install','--manifest',('"'+$manifest+'"'),'--force','--interactive','--accept-package-agreements','--accept-source-agreements') -RedirectStandardOutput (Join-Path $retry 'winget-install.stdout.log') -RedirectStandardError (Join-Path $retry 'winget-install.stderr.log')
 Record 'winget-exit' @{exitCode=$installer.ExitCode;interactive=$true}
 if($installer.ExitCode -ne 0){throw 'Interactive public-URL WinGet installation failed'}
 & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') after
 if($LASTEXITCODE -ne 0){throw 'WinGet changed preserved data or target identity'}
 $doctorText=(& (Join-Path $root 'bin\honeybee.exe') doctor --json|Out-String)
 if($LASTEXITCODE -ne 0){throw 'Final Doctor failed'}
 $doctor=$doctorText|ConvertFrom-Json
 if(-not $doctor.ready){throw 'Final Doctor not ready'}
 Record 'doctor' $doctor
 $result=@{schemaVersion=1;publicDownloadVerified=$true;downloadCancelRetryObserved=$true;downloadProgressObserved=$progressObserved;wingetLocalInstallPassed=$true;doctorReady=$true;preserved=$true;candidate=$inputs.candidate;acceptancePromoted=$false;releaseCompletionPendingHostReview=$true;evidence=$retry;originalEvidence=$evidence}
 Record 'completed' $result
 $result|ConvertTo-Json -Depth 10
}catch{Record 'failed' @{error=$_.Exception.Message;automaticReplay=$false;withdrawPublicReleaseRequired=$true};throw}
