param([Parameter(Mandatory=$true)][string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($WorkspaceRoot)
$evidence=Join-Path $root 'output\acceptance-completion-20260916'
$directory=Join-Path $evidence 'HyperV'
$record=Join-Path $evidence 'temporary-vm.json'
$name='HoneyBee-Acceptance-beta32'
trap {
    @{schemaVersion=1;ok=$false;error=$_.Exception.Message;sourceVmUnchanged=$true} | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $evidence 'temporary-vm-failed.json') -Encoding UTF8
    exit 1
}
$sourceId='a4693938-ec51-4427-a453-1e44739d7db2'
$checkpointId='02b6a046-98fd-45c6-910e-12dbce3d7469'
if(Test-Path -LiteralPath $record){throw 'Temporary VM record already exists; inspect it instead of recreating.'}
if(Get-VM -Name $name -ErrorAction SilentlyContinue){throw 'VM name already exists'}
if((Get-PSDrive C).Free -lt 22GB){throw '12 GiB host floor plus 10 GiB temporary budget required'}
$source=Get-VM -Id $sourceId
if($source.Name -ne 'HoneyBee-Setup-QA-20260910'){throw 'Source VM differs'}
$checkpoint=@(Get-VMSnapshot -VM $source | Where-Object {$_.Id -eq $checkpointId})
if($checkpoint.Count -ne 1){throw 'Reviewed clean checkpoint missing'}
$disks=@(Get-VMHardDiskDrive -VMSnapshot $checkpoint[0])
if($disks.Count -ne 1){throw 'Expected one checkpoint disk'}
$parent=[IO.Path]::GetFullPath($disks[0].Path)
if(@(Get-VM | Get-VMHardDiskDrive | Where-Object {$_.Path -eq $parent}).Count){throw 'Parent is attached as a writable VM disk'}
if(-not (Test-VHD -Path $parent)){throw 'Checkpoint disk chain is invalid'}
$switch=@(Get-VMSwitch | Where-Object {$_.Id -eq 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444'})
if($switch.Count -ne 1){throw 'Default Switch unavailable; no host network changes performed'}
if(Test-Path -LiteralPath $directory){
    if(@(Get-ChildItem -LiteralPath $directory -Force).Count){throw 'Output directory is not empty; retain it for review'}
} else {New-Item -ItemType Directory -Path $directory | Out-Null}
$disk=Join-Path $directory 'acceptance.vhdx'
. (Join-Path $PSScriptRoot 'create-checkpoint-child.ps1')
New-CheckpointChild -Destination $disk -Parent $parent
if(-not (Test-VHD -Path $disk)){throw 'New child chain validation failed'}
$vm=New-VM -Name $name -Generation 2 -MemoryStartupBytes 2GB -VHDPath $disk -Path $directory -SwitchName $switch[0].Name
Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown
Set-VMProcessor -VM $vm -Count 2
Set-VMMemory -VM $vm -DynamicMemoryEnabled $true -MinimumBytes 1GB -MaximumBytes 4GB
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
Enable-VMIntegrationService -VM $vm -Name (Get-VMIntegrationService -VM $vm | Where-Object {$_.Id.ToString().ToUpperInvariant().Contains('6C09BB55-D683-4DA0-8931-C9BF705F6480')}).Name
$result=[ordered]@{schemaVersion=1;name=$name;id=[string]$vm.Id;parentCheckpoint=$checkpointId;parentPath=$parent;disk=$disk;sourceVmUnchanged=$true;budgetBytes=10GB;hostFloorBytes=12GB;created=[DateTime]::UtcNow.ToString('o')}
$result | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding UTF8
Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $PSScriptRoot 'watch-acceptance-capacity.ps1')+'"'),'-Record',('"'+$record+'"')) | Out-Null
Start-VM -VM $vm | Out-Null
Write-Host "Temporary VM started: $name. Source VM and checkpoint unchanged."
