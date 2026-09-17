param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$vmId='a4693938-ec51-4427-a453-1e44739d7db2'
$result=[ordered]@{schemaVersion=1;inspectionOnly=$true;ok=$false;vmId=$vmId}
New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
try {
    $vm=Get-VM -Id $vmId
    if ($vm.Name -ne 'HoneyBee-Setup-QA-20260910') {throw 'Pinned VM name differs'}
    $result.vm=[ordered]@{name=$vm.Name;state=[string]$vm.State;generation=$vm.Generation}
    $result.hostFreeBytes=(Get-PSDrive C).Free
    $result.activeDisks=@(Get-VMHardDiskDrive -VM $vm | ForEach-Object {$_.Path})
    $result.snapshots=@(Get-VMSnapshot -VM $vm | ForEach-Object {
        $snapshot=$_
        $disks=@(Get-VMHardDiskDrive -VMSnapshot $snapshot | ForEach-Object {
            $disk=Get-VHD -Path $_.Path
            [ordered]@{path=$disk.Path;parentPath=$disk.ParentPath;type=[string]$disk.VhdType;size=$disk.Size;fileSize=$disk.FileSize}
        })
        [ordered]@{id=[string]$snapshot.Id;name=$snapshot.Name;created=$snapshot.CreationTime.ToUniversalTime().ToString('o');disks=$disks}
    })
    $result.ok=$true
} catch {$result.error=$_.Exception.Message}
$target=Join-Path $EvidenceRoot ('host-inspection-'+[guid]::NewGuid().ToString('N')+'.json')
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $target -Encoding UTF8
Write-Host "Inspection evidence: $target"
if(-not $result.ok){exit 1}
