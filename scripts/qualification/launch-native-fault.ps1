param([Parameter(Mandatory=$true)][string]$CaseDirectory,[Parameter(Mandatory=$true)][string]$ConfigSha256)
$ErrorActionPreference='Stop'
if ($CaseDirectory.Contains('"') -or $ConfigSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid QA arguments' }
$script=Join-Path $PSScriptRoot 'native-fault-controller.ps1'
# Only this QA observer elevates. The update owner and Desktop remain the user.
Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-CaseDirectory',('"'+$CaseDirectory+'"'),'-ConfigSha256',$ConfigSha256)
