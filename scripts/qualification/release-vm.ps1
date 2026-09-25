param(
  [Parameter(Mandatory=$true)][string]$PinPath,
  [ValidateSet('Inspect','Admit','Watch','Finish')][string]$Mode='Inspect',
  [string]$ExportReceipt,
  [string]$GuestCapacityPath,
  [long]$ExpectedGrowthBytes=0
)
$ErrorActionPreference='Stop'
$pin=Get-Content -LiteralPath $PinPath -Raw | ConvertFrom-Json
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$root=[IO.Path]::GetFullPath($pin.vmRoot)
$allowed=Join-Path $repo 'output'
if(-not $root.StartsWith($allowed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'VM root must be an explicit child of repository output'}
if($pin.schemaVersion -ne 1 -or -not $pin.vmId){throw 'Pinned VM identity required'}
if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked VM root refused'}
$vm=Get-VM -Id ([Guid]$pin.vmId)
if($vm.AutomaticCheckpointsEnabled -or @(Get-VMSnapshot -VM $vm).Count){throw 'Checkpoints are prohibited'}
$disks=@(Get-VMHardDiskDrive -VM $vm)
if($disks.Count -ne 1){throw 'Exactly one independent OS disk required'}
$diskPath=[IO.Path]::GetFullPath($disks[0].Path)
if(-not $diskPath.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'VM disk escaped budget root'}
$disk=Get-VHD -Path $diskPath
if($disk.ParentPath -or $disk.VhdType -ne 'Dynamic' -or $disk.Size -ne 64GB){throw 'Expected standalone dynamic 64 GiB disk'}
foreach($location in @($vm.ConfigurationLocation,$vm.SnapshotFileLocation,$vm.SmartPagingFilePath)){
  $resolvedLocation=[IO.Path]::GetFullPath($location).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if($resolvedLocation -ne $root -and -not $resolvedLocation.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'VM configuration/runtime files escaped budget root'}
}
if(@(Get-VMDvdDrive -VM $vm | Where-Object {$_.Path}).Count){throw 'Detach install media before recurring QA'}
function Get-BudgetSnapshot {
  $items=@(Get-ChildItem -LiteralPath $root -Recurse -Force)
  if(@($items | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'VM budget root contains a link'}
  $bytes=($items | Where-Object {-not $_.PSIsContainer} | Measure-Object -Property Length -Sum).Sum
  $volume=Get-Volume -FilePath $root
  [ordered]@{schemaVersion=1;vmId=$pin.vmId;vmBytes=[long]$bytes;hostFreeBytes=[long]$volume.SizeRemaining;at=[DateTime]::UtcNow.ToString('o');budgetBytes=40GB;pauseBytes=38GB;hostFloorBytes=20GB;hostPauseFreeBytes=22GB}
}
if($Mode -eq 'Admit'){
  if(-not $GuestCapacityPath -or $ExpectedGrowthBytes -lt 0){throw 'Fresh guest capacity and nonnegative peak growth required'}
  $guest=Get-Content -LiteralPath $GuestCapacityPath -Raw | ConvertFrom-Json
  if(-not $pin.computerName -or $guest.computer -ne $pin.computerName -or $guest.filesystem -ne 'NTFS'){throw 'Guest identity/filesystem mismatch'}
  $age=([DateTime]::UtcNow-[DateTime]::Parse($guest.at).ToUniversalTime()).TotalMinutes
  if($age -gt 5 -or $age -lt 0){throw 'Guest capacity observation is stale'}
  $snapshot=Get-BudgetSnapshot
  if($snapshot.vmBytes+$ExpectedGrowthBytes -ge 38GB -or $snapshot.hostFreeBytes-$ExpectedGrowthBytes -le 22GB -or $guest.guestFreeBytes-$ExpectedGrowthBytes -lt 22GB){throw 'Insufficient peak headroom; no expansion or safety-floor reduction allowed'}
  $snapshot.expectedGrowthBytes=$ExpectedGrowthBytes
  $snapshot.guestFreeBytes=$guest.guestFreeBytes
  $snapshot.admitted=$true
  $snapshot | ConvertTo-Json
  exit
}
if($Mode -eq 'Finish'){
  if(-not $ExportReceipt){throw 'Verified native export receipt required before shutdown'}
  $receipt=Get-Content -LiteralPath $ExportReceipt -Raw | ConvertFrom-Json
  if($receipt.lane -ne 'native' -or $receipt.status -ne 'passed' -or $receipt.pendingTransactions -ne 0 -or $receipt.environment.vmId -ne $pin.vmId){throw 'Only a successful terminal run of this VM may finish'}
  $age=([DateTime]::UtcNow-[DateTime]::Parse($receipt.completedAt).ToUniversalTime()).TotalMinutes
  if($age -gt 5 -or $age -lt 0){throw 'Stale receipt; obtain a fresh transaction-status/export confirmation'}
  if(@($receipt.attachments).Count -eq 0){throw 'Export inventory missing'}
  $base=Split-Path -Parent ([IO.Path]::GetFullPath($ExportReceipt))
  foreach($entry in $receipt.attachments){
    $file=if([IO.Path]::IsPathRooted($entry.path)){$entry.path}else{Join-Path $base $entry.path}
    $resolved=[IO.Path]::GetFullPath($file)
    if($resolved.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence must be exported outside VM budget directory'}
    if((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Export digest mismatch'}
  }
  # Graceful guest shutdown only. Never force power off an uncertain transaction.
  $vm | Stop-VM -Confirm:$false
  Write-Output 'Verified evidence retained; graceful shutdown requested. No files deleted.'
  exit
}
do {
  try {
    $snapshot=Get-BudgetSnapshot
    if($Mode -eq 'Watch'){
      $snapshot | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'release-budget-status.json') -Encoding UTF8
      if($snapshot.vmBytes -ge 38GB -or $snapshot.hostFreeBytes -le 22GB){
        $vm | Suspend-VM -Confirm:$false
        throw 'Capacity guard paused VM; no automatic resume or expansion'
      }
    }else{$snapshot | ConvertTo-Json; break}
  }catch{
    if($Mode -eq 'Watch'){
      if((Get-VM -Id ([Guid]$pin.vmId)).State -eq 'Running'){$vm | Suspend-VM -Confirm:$false}
    }
    throw
  }
  Start-Sleep -Seconds 5
}while($Mode -eq 'Watch')
