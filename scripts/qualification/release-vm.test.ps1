$ErrorActionPreference='Stop'
$caseRoot=Join-Path (Get-Location) ('output/release-vm-tests/'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($caseRoot)
$pinPath=Join-Path $caseRoot 'pin.json'
$guestPath=Join-Path $caseRoot 'guest.json'
$vmId=[guid]::NewGuid().ToString()
@{schemaVersion=1;vmId=$vmId;vmRoot=$caseRoot;computerName='HB-TIME-TEST'}|ConvertTo-Json|Set-Content -LiteralPath $pinPath
# Exercise the real admission command without opening Hyper-V or changing a VM.
function Get-VM {param($Id) [pscustomobject]@{AutomaticCheckpointsEnabled=$false;ConfigurationLocation=$caseRoot;SnapshotFileLocation=$caseRoot;SmartPagingFilePath=$caseRoot}}
function Get-VMSnapshot {param($VM)}
function Get-VMHardDiskDrive {param($VM) [pscustomobject]@{Path=(Join-Path $caseRoot 'system.vhdx')}}
function Get-VHD {param($Path) [pscustomobject]@{ParentPath=$null;VhdType='Dynamic';Size=64GB}}
function Get-VMDvdDrive {param($VM)}
function Get-Volume {param($FilePath) [pscustomobject]@{SizeRemaining=200GB}}
$stats=[pscustomobject]@{stops=0}
function Stop-VM {param([Parameter(ValueFromPipeline)]$VM,[switch]$Confirm) $stats.stops++}
function Suspend-VM {throw 'This admission test must never suspend a VM'}
$guard=Join-Path $PSScriptRoot 'release-vm.ps1'
$passed=0
foreach($offset in @(0,9,-7)){
  $instant=[DateTimeOffset]::UtcNow.AddSeconds(-10).ToOffset([TimeSpan]::FromHours($offset))
  @{computer='HB-TIME-TEST';filesystem='NTFS';guestFreeBytes=80GB;at=$instant.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $guestPath
  $result=(& $guard -PinPath $pinPath -Mode Admit -GuestCapacityPath $guestPath -ExpectedGrowthBytes 1GB)|ConvertFrom-Json
  if(-not $result.admitted -or $result.vmId -ne $vmId){throw "Fresh $offset observation was not admitted"}
  $passed++
}
foreach($minutes in @(-6,1)){
  @{computer='HB-TIME-TEST';filesystem='NTFS';guestFreeBytes=80GB;at=[DateTimeOffset]::UtcNow.AddMinutes($minutes).ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $guestPath
  $refused=$false
  try{& $guard -PinPath $pinPath -Mode Admit -GuestCapacityPath $guestPath -ExpectedGrowthBytes 1GB|Out-Null}catch{if($_.Exception.Message -eq 'Guest capacity observation is stale'){$refused=$true}else{throw}}
  if(-not $refused){throw 'Stale/future guest observation was admitted'}
  $passed++
}
if($stats.stops -ne 0){throw 'Admission must never stop a VM'}
$exports=Join-Path (Split-Path -Parent $caseRoot) ('export-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($exports)
$attachment=Join-Path $exports 'evidence.txt'
'synthetic evidence'|Set-Content -LiteralPath $attachment
$receiptPath=Join-Path $exports 'receipt.json'
foreach($minutes in @(0,-6,1)){
  @{lane='native';status='passed';pendingTransactions=0;environment=@{vmId=$vmId};completedAt=[DateTimeOffset]::UtcNow.AddMinutes($minutes).ToString('o');attachments=@(@{path='evidence.txt';sha256=(Get-FileHash -LiteralPath $attachment -Algorithm SHA256).Hash.ToLowerInvariant()})}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $receiptPath
  if($minutes -eq 0){
    & $guard -PinPath $pinPath -Mode Finish -ExportReceipt $receiptPath|Out-Null
    if($stats.stops -ne 1){throw 'Fresh completed native receipt was refused'}
  }else{
    $refused=$false
    try{& $guard -PinPath $pinPath -Mode Finish -ExportReceipt $receiptPath|Out-Null}catch{if($_.Exception.Message -eq 'Stale receipt; obtain a fresh transaction-status/export confirmation'){$refused=$true}else{throw}}
    if(-not $refused -or $stats.stops -ne 1){throw 'Stale/future export receipt was allowed to stop a VM'}
  }
  $passed++
}
[pscustomobject]@{passed=$passed;realVmMutations=0;powershell=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json
