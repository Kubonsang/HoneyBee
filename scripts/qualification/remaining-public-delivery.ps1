$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$evidence=Join-Path $bundle 'Public-Evidence'
$resume=Test-Path -LiteralPath $evidence
$resumeName='reviewed-resume'
$resumeFailureName='resume-failed'
if($resume){
 $review=Get-Content -LiteralPath (Join-Path $bundle 'reviewed-public-resume.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $failed=Get-Content -LiteralPath (Join-Path $evidence 'failed.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($review.failure -cne 'Actual progress observation required' -or $failed.error -cne $review.failure -or -not $review.userConfirmedCancelRetry){throw 'Public continuation is not reviewed'}
 if(Test-Path -LiteralPath (Join-Path $evidence 'reviewed-resume.json')){
  $prior=Get-Content -LiteralPath (Join-Path $evidence 'resume-failed.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($prior.error -cne 'Wrong update offer'){throw 'Only the reviewed version-input typo can resume'}
  $previousReview=Get-Content -LiteralPath (Join-Path $evidence 'reviewed-resume.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($previousReview.setupSha256 -ne $review.setupSha256 -or $previousReview.manifestSha256 -ne $review.manifestSha256 -or -not $previousReview.userConfirmedCancelRetry){throw 'Prior review differs'}
  $resumeName='reviewed-resume-input-002'
  $resumeFailureName='resume-failed-input-002'
 }
 foreach($name in @($resumeName,'download-cancel','download-retry','completed',$resumeFailureName)){
  if(Test-Path -LiteralPath (Join-Path $evidence ($name+'.json'))){throw 'Prior continuation exists; retain evidence without automatic replay'}
 }
}
$inputs=Get-Content -LiteralPath (Join-Path $bundle 'inputs.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($resume -and ($review.setupSha256 -ne $inputs.candidate.setupSha256 -or $review.manifestSha256 -ne $inputs.candidate.manifestSha256)){throw 'Reviewed candidate differs'}
$url=$inputs.publicDelivery.releaseApi
$release=Invoke-RestMethod -Uri $url -Headers @{'User-Agent'='HoneyBee-Qualification'}
if($release.draft -or -not $release.prerelease -or $release.tag_name -ne 'v0.1.0-beta.35'){throw 'Pinned public prerelease unavailable'}
if(-not $resume){New-Item -ItemType Directory -Path $evidence|Out-Null}
function Record([string]$Name,$Value){
 $file=Join-Path $evidence ($Name+'.json');$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-ExactObservation([string]$Prompt,[string]$Expected){
 while($true){
  $answer=Read-Host ($Prompt+' (STOP to stop)')
  if($answer -ieq 'STOP'){throw 'Observation stopped by operator'}
  if($null -ne $answer -and $answer.Trim() -ceq $Expected){return}
  Write-Host ('No result recorded. Check HoneyBee, then enter exactly: '+$Expected+'. A typing mistake can be corrected here.')
 }
}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$node=Join-Path $bundle 'runtime\node.exe'
try {
 if($resume){
  $priorRelease=Get-Content -LiteralPath (Join-Path $evidence 'public-release.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($priorRelease.id -ne $release.id){throw 'Public release identity changed'}
  & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') resume
  if($LASTEXITCODE -ne 0){throw 'Original preservation baseline or source differs'}
  Record $resumeName $review
 } else {
 Record 'public-release' @{id=$release.id;tag=$release.tag_name;api=$url;anonymous=$true}
 foreach($name in @('release.json','release.sig.json','Kubonsang.HoneyBee.yaml')){
  $assets=@($release.assets|Where-Object name -eq $name)
  if($assets.Count -ne 1 -or $assets[0].size -gt 1MB){throw 'Public metadata asset differs'}
  $expected='https://github.com/Kubonsang/HoneyBee/releases/download/v0.1.0-beta.35/'+$name
  if($assets[0].browser_download_url -ne $expected){throw 'Unexpected public download URL'}
  Invoke-WebRequest -UseBasicParsing -Uri $expected -OutFile (Join-Path $evidence $name)
 }
 & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') before
 if($LASTEXITCODE -ne 0){throw 'Public authentication or source preservation failed'}
 }
 Start-Process -FilePath (Join-Path $root 'HoneyBeeLauncher.exe')
 Write-Host 'In HoneyBee: open Update Check, click Check, and confirm the offered version.'
 Read-ExactObservation 'Type the version actually offered in HoneyBee' '0.1.0-beta.35'
 if($resume){Write-Host 'Prior cancel and retry were confirmed in your report. Click Download and observe progress; let this download finish.'}
 else {Write-Host 'Click Download. Observe actual progress, then CANCEL before completion.'}
 Write-Host 'The UI may show a progress BAR without a number. Enter BAR if you actually saw it advance, or describe the progress you observed. Do not guess a percentage.'
 do {
  $progress=Read-Host 'Observed download progress (BAR or your description; STOP to stop)'
  if($progress -ceq 'STOP'){throw 'Progress observation stopped by operator'}
  $validProgress=-not [string]::IsNullOrWhiteSpace($progress) -and $progress -notmatch '^(YES|NO)$'
  if(-not $validProgress){Write-Host 'No observation recorded. Observe the download progress in HoneyBee, then answer here; STOP if it cannot be observed.'}
 } while(-not $validProgress)
 if($resume){Record 'download-cancel' @{observed=$true;attribution='User explicitly confirmed cancellation followed by retry in conversation';retryProgress=$progress;version='0.1.0-beta.35'}}
 else {
  Read-ExactObservation 'Type CANCELLED only after the UI confirms cancellation' 'CANCELLED'
  Record 'download-cancel' @{observed=$true;progress=$progress;version='0.1.0-beta.35'}
 }
 Write-Host 'Let the download and preparation finish. Click Apply Update in HoneyBee and wait for the new app window.'
 Read-ExactObservation 'Type READY only after applying the update and the new app is usable' 'READY'
 & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') after
 if($LASTEXITCODE -ne 0){throw 'Updated pointer or data preservation differs'}
 Record 'download-retry' @{observed=$true;activeVersion='0.1.0-beta.35';preserved=$true}
 Write-Host 'Close HoneyBee normally before the WinGet installation check.'
 Read-ExactObservation 'Type CLOSED after closing HoneyBee' 'CLOSED'
 if(@(Get-Process -Name HoneyBee -ErrorAction SilentlyContinue|Where-Object {$_.Path -like ($root+'\*')}).Count){throw 'HoneyBee is still running'}
 # Local manifest enablement is scoped to this disposable qualification VM.
 $enable=Join-Path $PSScriptRoot 'enable-remaining-winget.ps1'
 $helper=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$enable+'"'))
 if($helper.ExitCode -ne 0){throw 'Local WinGet manifest enablement failed'}
 $wingetPath=(Get-Command winget.exe -ErrorAction Stop).Source
 $winget=Start-Process -FilePath $wingetPath -WindowStyle Hidden -Wait -PassThru -ArgumentList @('install','--manifest',('"'+(Join-Path $evidence 'Kubonsang.HoneyBee.yaml')+'"'),'--force','--interactive','--accept-package-agreements','--accept-source-agreements') -RedirectStandardOutput (Join-Path $evidence 'winget-install.stdout.log') -RedirectStandardError (Join-Path $evidence 'winget-install.stderr.log')
 $wingetExit=$winget.ExitCode
 Record 'winget-exit' @{exitCode=$wingetExit}
 if($wingetExit -ne 0){throw 'Actual public-URL WinGet installation failed'}
 & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') after
 if($LASTEXITCODE -ne 0){throw 'WinGet installation changed preserved data or target identity'}
 $doctorText=(& (Join-Path $root 'bin\honeybee.exe') doctor --json|Out-String)
 if($LASTEXITCODE -ne 0){throw 'Final Doctor failed'}
 $doctor=$doctorText|ConvertFrom-Json
 if(-not $doctor.ready){throw 'Final Doctor not ready'}
 Record 'doctor' $doctor
 $result=@{schemaVersion=1;publicDownloadVerified=$true;downloadCancelRetryObserved=$true;wingetLocalInstallPassed=$true;doctorReady=$true;preserved=$true;candidate=$inputs.candidate;acceptancePromoted=$false;releaseCompletionPendingHostReview=$true;evidence=$evidence}
 Record 'completed' $result
 $result|ConvertTo-Json -Depth 10
} catch {$failureName=if($resume){$resumeFailureName}else{'failed'};Record $failureName @{error=$_.Exception.Message;automaticReplay=$false;withdrawPublicReleaseRequired=$true};throw}
