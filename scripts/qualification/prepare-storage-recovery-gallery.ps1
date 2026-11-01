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
    startsVm=$false;acceptsLicense=$false;changesExistingService=$false;publicationAllowed=$false}|ConvertTo-Json
  return
}
if($Mode -eq 'Prepare'){
  if(Test-Path -LiteralPath $prepared){
    $record=Get-Content -LiteralPath $prepared -Raw|ConvertFrom-Json
    if($record.archiveSha256 -ne $archiveHash -or $record.imageBytes -ne $imageBytes -or -not (Test-Path -LiteralPath $image)){throw 'Existing preparation differs; nothing overwritten'}
    if((Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.imageSha256){throw 'Prepared gallery image changed'}
    $record|ConvertTo-Json;return
  }
  if(-not(Test-Path -LiteralPath $archive -PathType Leaf) -or (Get-Item -LiteralPath $archive).Length -ne $archiveBytes){throw 'Complete Microsoft gallery archive required; download may still be running'}
  if($drive.AvailableFreeSpace -lt $imageBytes+23GB){throw 'Insufficient extraction headroom'}
  $partial=Join-Path $assets 'WinDev2407Eval.partial.vhdx'
  if((Test-Path -LiteralPath $image) -or (Test-Path -LiteralPath $partial)){throw 'Existing image/partial extraction retained; refusing overwrite'}
  Add-Type -AssemblyName System.IO.Compression
  $archiveFile=[IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{
    Write-Output 'Verifying the Microsoft archive SHA-256...'
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$digest=([BitConverter]::ToString($sha.ComputeHash($archiveFile))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    if($digest -ne $archiveHash){throw 'Microsoft archive SHA-256 differs'}
    $archiveFile.Position=0
    $zip=[IO.Compression.ZipArchive]::new($archiveFile,[IO.Compression.ZipArchiveMode]::Read,$true)
    try{
      if($zip.Entries.Count -ne 1 -or $zip.Entries[0].FullName -ne 'WinDev2407Eval.vhdx' -or $zip.Entries[0].Length -ne $imageBytes){throw 'Unexpected Microsoft archive inventory'}
      $source=$zip.Entries[0].Open()
      $output=[IO.File]::Open($partial,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      $imageSha=[Security.Cryptography.SHA256]::Create()
      try{
        $buffer=[byte[]]::new(8MB);$written=0L;$nextCheck=256MB;$lastReport=[DateTime]::UtcNow
        while(($count=$source.Read($buffer,0,$buffer.Length)) -gt 0){
          $written+=$count;if($written -gt $imageBytes){throw 'Extracted image exceeds pinned size'}
          $output.Write($buffer,0,$count);[void]$imageSha.TransformBlock($buffer,0,$count,$buffer,0)
          if($written -ge $nextCheck){$drive=[IO.DriveInfo]::new($drive.Name);if($drive.AvailableFreeSpace -le 22GB){throw 'Host reserve reached; partial image retained'};$nextCheck=$written+256MB}
          if(([DateTime]::UtcNow-$lastReport).TotalSeconds -ge 30){Write-Output "Extracted $written / $imageBytes bytes";$lastReport=[DateTime]::UtcNow}
        }
        if($written -ne $imageBytes){throw 'Incomplete image extraction'}
        [void]$imageSha.TransformFinalBlock([byte[]]::new(0),0,0)
        $imageHash=([BitConverter]::ToString($imageSha.Hash)).Replace('-','').ToLowerInvariant()
        $output.Flush($true)
      }finally{$imageSha.Dispose();$output.Dispose();$source.Dispose()}
    }finally{$zip.Dispose()}
  }finally{$archiveFile.Dispose()}
  Move-Item -LiteralPath $partial -Destination $image
  $record=[ordered]@{schemaVersion=1;profile=$galleryProfileId;archiveSha256=$archiveHash;imageSha256=$imageHash;imageBytes=$imageBytes;preparedAt=[DateTime]::UtcNow.ToString('o');publicationAllowed=$false}
  $json=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json)+"`n")
  $file=[IO.File]::Open($prepared,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$file.Write($json,0,$json.Length);$file.Flush($true)}finally{$file.Dispose()}
  $record|ConvertTo-Json;return
}
if(-not $isAdmin){throw 'Administrator Hyper-V session required. No host service was changed.'}
if($Mode -eq 'Create'){
  if(Test-Path -LiteralPath $root){throw 'VM directory already exists; refusing reuse'}
  if(Test-Path -LiteralPath $pinPath){throw 'VM pin already exists; refusing overwrite'}
  if(@(Get-VM -ErrorAction Stop|Where-Object Name -eq $name).Count){throw 'VM name already exists; refusing replacement'}
  $record=Get-Content -LiteralPath $prepared -Raw|ConvertFrom-Json
  if($record.profile -ne $galleryProfileId -or $record.archiveSha256 -ne $archiveHash -or $record.imageBytes -ne $imageBytes){throw 'Gallery preparation identity differs'}
  if((Get-Item -LiteralPath $image).Length -ne $imageBytes -or (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.imageSha256){throw 'Prepared disk changed'}
  $diskInfo=Get-VHD -Path $image
  if($diskInfo.ParentPath -or $diskInfo.VhdType -ne 'Dynamic' -or $diskInfo.Size -lt 64GB -or $diskInfo.Size -gt 256GB){throw 'Independent Microsoft dynamic disk required'}
  if($drive.AvailableFreeSpace -le 40GB){throw 'Host reserve is insufficient'}
  if(-not $PSCmdlet.ShouldProcess($root,"Create NEW gallery recovery VM $name and leave it off")){return}
  New-Item -ItemType Directory -Path $root -ErrorAction Stop|Out-Null
  $disk=Join-Path $root 'system.vhdx'
  Move-Item -LiteralPath $image -Destination $disk
  $vm=New-VM -Name $name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $disk -Path $root
  Set-VM -VM $vm -ProcessorCount 2 -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -SnapshotFileLocation $root -SmartPagingFilePath $root
  Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
  Enable-VMTPM -VM $vm
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
  $pin=[ordered]@{schemaVersion=1;profile=$galleryProfileId;vmId=$vm.Id.ToString();vmName=$name;vmRoot=$root;imageSha256=$record.imageSha256;galleryArchiveSha256=$archiveHash;diskBytes=$diskInfo.Size;vmBudgetBytes=64GB;pauseBytes=60GB;hostPauseFreeBytes=22GB;stage='EvaluationLicenseAndBootValidationRequired';createdAt=[DateTime]::UtcNow.ToString('o')}
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($pin|ConvertTo-Json)+"`n")
  $file=[IO.File]::Open($pinPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
  $pin|ConvertTo-Json;return
}
