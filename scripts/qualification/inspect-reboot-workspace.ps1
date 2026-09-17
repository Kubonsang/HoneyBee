$ErrorActionPreference='Stop'
$vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Use HoneyBee-Acceptance-beta32.'}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$batch='C:\HoneyBeeQA\acceptance-completion-20260916\app-recovery'
$errorsFound=[Collections.Generic.List[object]]::new()
function Read-Record([string]$File){
    try {
        if((Get-Item -LiteralPath $File).Length -gt 1MB){throw 'Record exceeds inspection bound'}
        Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {$errorsFound.Add(@{path=$File;error=$_.Exception.Message});return $null}
}
function Inspect-Path([string]$File){
    try {
        $entry=Get-Item -LiteralPath $File -Force
        @{path=$File;attributes=[string]$entry.Attributes;linkType=$entry.LinkType;target=@($entry.Target);accessible=(Test-Path -LiteralPath $File)}
    } catch {$errorsFound.Add(@{path=$File;error=$_.Exception.Message});return @{path=$File;accessible=$false}}
}
$registryPath=Join-Path $root 'workspace-core\workspace-registry-v2.json'
$registry=Read-Record $registryPath
$workspaces=@($registry.workspaces | Where-Object {$_.workspaceId -eq '99fa09db-e0ef-48b6-89d0-4078c1278d0f'})
if($workspaces.Count -ne 1){throw 'Expected adopted workspace not found uniquely.'}
$workspace=$workspaces[0]
$projects=@($registry.projects | Where-Object {$_.projectId -eq $workspace.projectId})
if($projects.Count -ne 1){throw 'Expected project not found uniquely.'}
$project=$projects[0]
if($workspace.leaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $workspace.consumerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'){throw 'Invalid storage identity.'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$store=Join-Path $env:ProgramData ('UnityWorkspaceStorage\'+$sid)
$lease=Read-Record (Join-Path $store ('leases\'+$workspace.leaseId+'.json'))
$retained=Read-Record (Join-Path $store ('retained\'+$workspace.consumerId+'.json'))
$library=Join-Path (Join-Path $workspace.workspacePath $project.unityRelativePath) 'Library'
$owner=Read-Record (Join-Path $workspace.storageWorkspacePath '.testplay-vhdx-workspace-owner.json')
# No broker requests, Launcher, Doctor, repair, or test replay. Git optional
# locks are disabled so status cannot refresh the index on disk.
$gitOutput=@(& git --no-optional-locks -C $workspace.workspacePath status --porcelain=v1 --untracked-files=all 2>&1 | ForEach-Object {"$_"})
$gitExit=$LASTEXITCODE
$result=@{
    schemaVersion=1;readOnlyInspection=$true;testsRun=0
    workspace=$workspace;library=(Inspect-Path $library);mount=(Inspect-Path $workspace.mountPath)
    lease=($lease | Select-Object schemaVersion,leaseId,runId,workspaceId,state,retained,mountPath,workspacePath,childPath,bootSessionId,fileIdentity)
    retainedIdentityMatches=($null -ne $retained -and $null -ne $lease -and $retained.leaseId -eq $lease.leaseId -and $retained.runId -eq $lease.runId -and $retained.childPath -eq $lease.childPath -and $retained.ownershipToken -eq $lease.ownershipToken)
    ownerIdentityMatches=($null -ne $owner -and $null -ne $lease -and $owner.leaseId -eq $lease.leaseId -and $owner.workspaceId -eq $workspace.storageWorkspaceId -and $owner.mountPath -eq $workspace.mountPath -and $owner.ownershipToken -eq $lease.ownershipToken)
    git=@{exitCode=$gitExit;status=$gitOutput};registrySha256=(Get-FileHash -LiteralPath $registryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    errors=@($errorsFound.ToArray())
}
$output=Join-Path $batch ('Workspace-connection-'+[guid]::NewGuid().ToString('N')+'.json')
$result.evidence=$output
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding UTF8
$result | ConvertTo-Json -Depth 12
