[CmdletBinding(SupportsShouldProcess=$true)]
param([ValidateSet('Plan','Prepare','Create')][string]$Mode='Plan')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$assets=Join-Path $repo 'output/storage-recovery-gallery-20261101'
$root=Join-Path $repo 'output/storage-recovery-vm-20261101/HyperV'
$pinPath=Join-Path $repo 'output/storage-recovery-vm-20261101/release-vm-pin.json'
$archive=Join-Path $assets 'WinDev2407Eval.HyperV.zip'
$image=Join-Path $assets 'WinDev2407Eval.vhdx'
$prepared=Join-Path $assets 'preparation.json'
$name='HoneyBee-StorageRecovery-20261101'
$archiveHash='b546c32894785dbaac07543d913bde9d6598972f76a440d6b5c00b2e73739684'
$archiveBytes=23299441890L
$imageBytes=44832915456L
$galleryProfileId='storage-recovery-gallery-20261101'
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Assert-PlainPath([string]$target) {
  $current=Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  if(-not $current){$current=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($target))}
  while($current){
    if($current.Exists -and ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked gallery/VM paths are refused'}
    $current=if($current -is [IO.FileInfo]){$current.Directory}else{$current.Parent}
  }
}
foreach($target in @($archive,$image,$root,$prepared,$pinPath)){Assert-PlainPath $target}
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
if($Mode -eq 'Plan' -or $WhatIfPreference){
  [ordered]@{schemaVersion=1;profile=$galleryProfileId;vmName=$name;vmRoot=$root;archive=$archive;archiveBytes=$archiveBytes;
    downloadedBytes=$(if(Test-Path -LiteralPath $archive){(Get-Item -LiteralPath $archive).Length}else{0});
    archiveSha256=$archiveHash;imageBytes=$imageBytes;vmBudgetBytes=64GB;pauseBytes=60GB;hostPauseFreeBytes=22GB;
    hostFreeBytes=$drive.AvailableFreeSpace;administrator=$isAdmin;imagePrepared=(Test-Path -LiteralPath $prepared);
    evaluationStatus='expired-observed-2026-11-01';blockers=@('pinned-gallery-evaluation-expired-use-current-official-iso');
    startsVm=$false;acceptsLicense=$false;changesExistingService=$false;publicationAllowed=$false}|ConvertTo-Json
  return
}
throw 'Pinned WinDev2407Eval evaluation was observed expired (0xC004F009, grace 0). Retain existing evidence; use a current official ISO instead. No extraction or VM creation performed.'
