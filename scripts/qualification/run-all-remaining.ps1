$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001'){throw 'Wrong VM or user'}
if(([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Use ordinary PowerShell'}
$inventory=Get-Content -LiteralPath (Join-Path $bundle 'runner-files.json') -Raw -Encoding UTF8|ConvertFrom-Json
foreach($file in $inventory.files){
 if($file.path -notmatch '^[A-Za-z0-9._/-]+$' -or $file.path.StartsWith('/') -or $file.path.Split('/') -contains '..'){throw 'Unsafe runner path'}
 if((Get-FileHash -LiteralPath (Join-Path $bundle $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw ('Runner changed: '+$file.path)}
}
if(Test-Path -LiteralPath (Join-Path $bundle 'Public-Evidence\completed.json')){Get-Content -LiteralPath (Join-Path $bundle 'Public-Evidence\completed.json') -Raw;exit}
if(-not (Test-Path -LiteralPath (Join-Path $bundle 'baseline-preservation.json'))){
 Write-Host 'Close HoneyBee normally. This batch preserves the empty fresh beta.35 installation and uses the existing instrumented service baseline.'
 if((Read-Host 'Type CLOSED when HoneyBee is closed') -cne 'CLOSED'){throw 'Close confirmation required'}
 $helper=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PSScriptRoot 'prepare-remaining-baseline.ps1')+'"'))
 if($helper.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $bundle 'baseline-preservation.json'))){throw 'Baseline preservation stopped; keep all evidence'}
}
if(-not (Test-Path -LiteralPath (Join-Path $bundle 'remaining-service-result.json'))){
 Write-Host 'Running the six remaining service cases. Approve service qualification UAC prompts. One Windows reboot is included; after sign-in run this same entry again.'
 Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
 Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
 if(Test-Path -LiteralPath (Join-Path $bundle 'Evidence')){
  $history=@(Get-ChildItem -LiteralPath (Join-Path $bundle 'Evidence') -Filter '*.json'|Sort-Object Name|ForEach-Object {Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8|ConvertFrom-Json})
  $failedBaseline=@($history|Where-Object {$_.phase -eq 'baseline-setup' -and $_.state -eq 'Failed'})
  $completedBaseline=@($history|Where-Object {$_.phase -eq 'baseline-setup' -and $_.state -eq 'Completed'})
  if($failedBaseline.Count -and -not $completedBaseline.Count){
   & (Join-Path $bundle 'runtime\node.exe') (Join-Path $PSScriptRoot 'complete-reviewed-baseline.mjs')
   if($LASTEXITCODE -ne 0){throw 'Reviewed baseline completion stopped; retain all evidence'}
  }
  $failedDataset=@($history|Where-Object {$_.phase -eq 'dataset' -and $_.state -eq 'Failed'})
  $completedDataset=@($history|Where-Object {$_.phase -eq 'dataset' -and $_.state -eq 'Completed'})
  if($failedDataset.Count -and -not $completedDataset.Count){
   & (Join-Path $bundle 'runtime\node.exe') (Join-Path $PSScriptRoot 'complete-reviewed-dataset.mjs')
   if($LASTEXITCODE -ne 0){throw 'Reviewed dataset continuation stopped; retain all evidence'}
  }
 }
 $resumeArgs=@()
 if($history -and $history[-1].phase -eq 'production-handoff' -and $history[-1].state -eq 'Failed' -and $history[-1].error -ceq 'Error: HoneyBee service update was cancelled'){
  Write-Host 'All six service cases stay completed. Reviewing cancelled production handoff only. Select YES at the service UAC prompt.'
  $resumeArgs=@('--retry-case','production-handoff')
 }
 if($history -and $history[-1].phase -eq 'kill-service-validated-matrix' -and $history[-1].state -eq 'Failed' -and ($history[-1].error -match 'The operation was canceled by the user' -or $history[-1].error -match 'honeybee\.exe doctor --json' -or $history[-1].error -match 'Expected values to be strictly deep-equal')){
  Write-Host 'Reviewing the recorded rollback and source identity before retrying test 4 only. Select YES at UAC. Tests 1-3 stay completed.'
  $resumeArgs=@('--retry-case','kill-service-validated')
 }
 & (Join-Path $bundle 'runtime\node.exe') (Join-Path $PSScriptRoot 'guest-integrated.mjs') @resumeArgs
 if($LASTEXITCODE -eq 10){
  $last=Get-ChildItem -LiteralPath (Join-Path $bundle 'Evidence') -Filter '*.json'|Sort-Object Name|Select-Object -Last 1
  $waiting=Get-Content -LiteralPath $last.FullName -Raw -Encoding UTF8|ConvertFrom-Json
  if($waiting.state -ne 'WaitingForRestart' -or $waiting.detail.identity.scenario.id -ne 'reboot-service-replaced'){throw 'Unexpected pending restart'}
  Write-Host 'Checkpoint recorded. Restarting in five seconds. After sign-in run the same entry to validate recovery and continue.'
  & "$env:SystemRoot\System32\shutdown.exe" /r /t 5
  if($LASTEXITCODE -ne 0){throw 'Windows restart request failed'}
  exit 10
 }
 if($LASTEXITCODE -ne 0){throw 'Remaining batch failed. Preserve evidence; no automatic retry.'}
}
$result=Get-Content -LiteralPath (Join-Path $bundle 'remaining-service-result.json') -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $result.remainingServiceBatchPassed){throw 'Service batch not complete'}
if(-not (Test-Path -LiteralPath (Join-Path $bundle 'public-delivery-ready.json'))){
 $result|ConvertTo-Json -Depth 12
 Write-Host 'Prepublication service batch complete. Send this JSON to the host reviewer. After the pinned prerelease is published for verification, run this SAME entry for public download and WinGet.'
 exit
}
$approval=Get-Content -LiteralPath (Join-Path $bundle 'public-delivery-ready.json') -Raw -Encoding UTF8|ConvertFrom-Json
$inputs=Get-Content -LiteralPath (Join-Path $bundle 'inputs.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($approval.setupSha256 -ne $inputs.candidate.setupSha256 -or $approval.manifestSha256 -ne $inputs.candidate.manifestSha256 -or -not $approval.publishedForVerification){throw 'Public delivery candidate differs'}
& (Join-Path $PSScriptRoot 'remaining-public-delivery.ps1')
