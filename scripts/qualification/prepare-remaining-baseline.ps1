$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$backup=Join-Path $bundle 'Preserved-fresh35'
$resultFile=Join-Path $bundle 'baseline-preservation.json'
function Plain([string]$Path){
 $cursor=[IO.Path]::GetFullPath($Path)
 while($cursor){if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Redirected preservation path'};$cursor=[IO.Path]::GetDirectoryName($cursor)}
}
function Record([string]$Path,$Value){
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
try {
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 if($identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001' -or -not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Expected original guest user with elevation'}
 $vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
 if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Wrong VM'}
 $install=Join-Path $env:LOCALAPPDATA 'HoneyBee'
 $store='C:\ProgramData\UnityWorkspaceStorage'
 foreach($p in @($install,$store,$backup,$bundle)){Plain $p}
 if(Test-Path -LiteralPath $backup){throw 'Prior baseline preservation exists; inspect without replay'}
 $proof=Get-Content -LiteralPath 'C:\HoneyBeeQA\fresh-beta35\Evidence-fresh35-uac\completed.json' -Raw -Encoding UTF8|ConvertFrom-Json
 if(-not $proof.freshSetupPassed -or -not $proof.gitUacPassed -or $proof.setupSha256 -ne '643a944173291018a9d2a357f7edf52874f874dfd644f01e9b1b60ace2c40c04'){throw 'Exact fresh Setup proof missing'}
 $pointer=Get-Content -LiteralPath (Join-Path $install 'current.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($pointer.activeVersion -ne '0.1.0-beta.35'){throw 'Unexpected installed application'}
 $apps=@(Get-Process -Name HoneyBee -ErrorAction SilentlyContinue|Where-Object {$_.Path -like ($install+'\*')})
 if($apps.Count){throw 'Close HoneyBee before baseline preservation'}
 $registry=Join-Path $install 'workspace-core\workspace-registry-v2.json'
 if(Test-Path -LiteralPath $registry){$r=Get-Content -LiteralPath $registry -Raw -Encoding UTF8|ConvertFrom-Json;if($r.schemaVersion -ne 2 -or $null -eq $r.projects -or $null -eq $r.workspaces -or @($r.projects).Count -or @($r.workspaces).Count){throw 'Fresh registry is not empty; preserve without service removal'}}
 $work=Join-Path $install 'Workspaces'
 if((Test-Path -LiteralPath $work) -and @(Get-ChildItem -LiteralPath $work -Force).Count){throw 'Workspace root is not empty'}
 $receipt=Get-Content -LiteralPath (Join-Path $store 'install-receipt.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $hostFile=Join-Path $store 'broker\unity-workspace-storage-host.exe'
 if($receipt.userSid -ne $identity.User.Value -or $receipt.executable -ne $hostFile -or $receipt.workspaceRoot -ne $work -or $receipt.storeRoot -ne $store -or $receipt.executableSha256 -ne '980ea6266af68d66cfcf49f74b6c168cbddd4cccebfc85dde33336d0a88e6a2b'){throw 'Unexpected installed service receipt'}
 if((Get-FileHash -LiteralPath $hostFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.executableSha256){throw 'Service executable differs'}
 $allowed=@('broker\unity-workspace-storage-host.exe','broker-config.json','install-receipt.json')
 $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($store)
 $found=[Collections.Generic.List[string]]::new()
 while($pending.Count){$dir=$pending.Pop();foreach($item in @(Get-ChildItem -LiteralPath $dir -Force)){Plain $item.FullName;if($item.PSIsContainer){$pending.Push($item.FullName)}else{$found.Add($item.FullName.Substring($store.Length+1))}}}
 if($found.Count -ne 3 -or @($found|Where-Object {$_ -notin $allowed}).Count){throw 'Storage has data or unexpected files; no reset'}
 $services=@(Get-CimInstance Win32_Service -Filter "Name LIKE 'UnityWorkspaceStorage%'")
 if($services.Count -ne 1){throw 'Unexpected service registrations'}
 $service=$services[0]
 if($service.Name -ne 'UnityWorkspaceStorage' -or $service.StartName -ne 'LocalSystem' -or $service.PathName -ne ($hostFile+' broker-run --service-config '+$store+'\broker-config.json')){throw 'Service configuration differs'}
 New-Item -ItemType Directory -Path $backup|Out-Null
 Record (Join-Path $backup 'before.json') @{service=($service|Select-Object Name,State,StartMode,StartName,PathName);receipt=$receipt;pointer=$pointer;scope='Empty fresh-install fixture only; original populated disk stays preserved'}
 & "$env:SystemRoot\System32\reg.exe" export 'HKLM\SYSTEM\CurrentControlSet\Services\UnityWorkspaceStorage' (Join-Path $backup 'service.reg')|Out-Null
 if($LASTEXITCODE -ne 0){throw 'SCM backup failed'}
 if($service.State -ne 'Stopped'){Stop-Service UnityWorkspaceStorage;$controller=Get-Service UnityWorkspaceStorage;try{$controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30))}finally{$controller.Dispose()}}
 & "$env:SystemRoot\System32\sc.exe" delete UnityWorkspaceStorage|Out-Null
 if($LASTEXITCODE -ne 0 -or (Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'")){throw 'Service removal incomplete; preserve records'}
 # Both absolute destinations are descendants of the already verified bundle.
 Move-Item -LiteralPath $store -Destination (Join-Path $backup 'storage')
 Move-Item -LiteralPath $install -Destination (Join-Path $backup 'installation')
 if((Get-FileHash -LiteralPath (Join-Path $backup 'storage\broker\unity-workspace-storage-host.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.executableSha256){throw 'Preserved service hash differs'}
 Record $resultFile @{schemaVersion=1;preserved=$true;emptyFreshFixture=$true;backup=$backup;filesDeleted=0;originalPopulatedDiskChanged=$false}
} catch {
 $failure=Join-Path $bundle ('baseline-preservation-failed-'+[guid]::NewGuid().ToString('N')+'.json')
 Record $failure @{error=$_.Exception.Message;automaticReplay=$false}
 throw
}
