$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$evidence=Join-Path $bundle 'Public-Evidence'
if(Test-Path -LiteralPath $evidence){throw 'Prior public-delivery attempt exists; inspect its evidence without automatic replay'}
$inputs=Get-Content -LiteralPath (Join-Path $bundle 'inputs.json') -Raw -Encoding UTF8|ConvertFrom-Json
$url=$inputs.publicDelivery.releaseApi
$release=Invoke-RestMethod -Uri $url -Headers @{'User-Agent'='HoneyBee-Qualification'}
if($release.draft -or -not $release.prerelease -or $release.tag_name -ne 'v0.1.0-beta.35'){throw 'Pinned public prerelease unavailable'}
New-Item -ItemType Directory -Path $evidence|Out-Null
function Record([string]$Name,$Value){
 $file=Join-Path $evidence ($Name+'.json');$stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$node=Join-Path $bundle 'runtime\node.exe'
try {
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
 Start-Process -FilePath (Join-Path $root 'HoneyBeeLauncher.exe')
 Write-Host 'In HoneyBee: open Update Check, click Check, and confirm the offered version.'
 if((Read-Host 'Type the exact offered version') -cne '0.1.0-beta.35'){throw 'Wrong update offer'}
 Write-Host 'Click Download. Observe actual progress, then CANCEL before completion.'
 $progress=Read-Host 'Enter the visible progress text or percentage observed before cancellation'
 if([string]::IsNullOrWhiteSpace($progress) -or $progress -match '^(YES|NO)$'){throw 'Actual progress observation required'}
 if((Read-Host 'Type CANCELLED only after the UI confirms cancellation') -cne 'CANCELLED'){throw 'Download cancellation not observed'}
 Record 'download-cancel' @{observed=$true;progress=$progress;version='0.1.0-beta.35'}
 Write-Host 'Retry the download. Wait for preparation, apply the update, and wait for the new app window.'
 if((Read-Host 'Type READY only after the updated app is usable') -cne 'READY'){throw 'Update retry/readiness not confirmed'}
 & $node (Join-Path $PSScriptRoot 'remaining-public-guard.mjs') after
 if($LASTEXITCODE -ne 0){throw 'Updated pointer or data preservation differs'}
 Record 'download-retry' @{observed=$true;activeVersion='0.1.0-beta.35';preserved=$true}
 Write-Host 'Close HoneyBee normally before the WinGet installation check.'
 if((Read-Host 'Type CLOSED after closing HoneyBee') -cne 'CLOSED'){throw 'App closure not confirmed'}
 if(@(Get-Process -Name HoneyBee -ErrorAction SilentlyContinue|Where-Object {$_.Path -like ($root+'\*')}).Count){throw 'HoneyBee is still running'}
 # Local manifest enablement is scoped to this disposable qualification VM.
 $enable=Join-Path $PSScriptRoot 'enable-remaining-winget.ps1'
 $helper=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$enable+'"'))
 if($helper.ExitCode -ne 0){throw 'Local WinGet manifest enablement failed'}
 $wingetPath=(Get-Command winget.exe -ErrorAction Stop).Source
 $winget=Start-Process -FilePath $wingetPath -WindowStyle Hidden -Wait -PassThru -ArgumentList @('install','--manifest',('"'+(Join-Path $evidence 'Kubonsang.HoneyBee.yaml')+'"'),'--force','--accept-package-agreements','--accept-source-agreements','--disable-interactivity') -RedirectStandardOutput (Join-Path $evidence 'winget-install.stdout.log') -RedirectStandardError (Join-Path $evidence 'winget-install.stderr.log')
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
} catch {Record 'failed' @{error=$_.Exception.Message;automaticReplay=$false;withdrawPublicReleaseRequired=$true};throw}
