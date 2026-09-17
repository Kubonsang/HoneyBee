$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001'){throw 'Wrong user'}
$vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Wrong VM'}
$log=Join-Path $bundle ('lossless-space-'+[guid]::NewGuid().ToString('N')+'.jsonl')
function Record($v){$v|ConvertTo-Json -Compress|Add-Content -LiteralPath $log -Encoding UTF8}
function Plain([string]$p){while($p){if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'};$p=[IO.Path]::GetDirectoryName($p)}}
$install=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$roots=@((Join-Path $bundle 'Preserved-fresh35\installation'),(Join-Path $install 'versions\0.1.0-beta.31'),(Join-Path $install 'recovery'),(Join-Path $bundle 'runtime'))
$before=(Get-PSDrive C).Free
Record @{stage='started';freeBytes=$before;filesDeleted=0;targetFreeBytes=24.5GB}
foreach($root in $roots){
 Plain $root
 foreach($file in @(Get-ChildItem -LiteralPath $root -File -Recurse|Where-Object {$_.Length -ge 1MB -and $_.Extension -in @('.exe','.dll','.asar','.bin','.pak') -and -not ($_.Attributes -band [IO.FileAttributes]::Compressed)})){
  if((Get-PSDrive C).Free -ge 24.5GB){break}
  Plain $file.FullName
  if(-not $file.FullName.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'File escaped reviewed root'}
  $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  & "$env:SystemRoot\System32\compact.exe" /C /I /Q /A $file.FullName|Out-Null
  $code=$LASTEXITCODE
  if((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne $hash){throw 'File bytes changed'}
  Record @{stage='verified';path=$file.FullName;sha256=$hash;compactExitCode=$code}
 }
 if((Get-PSDrive C).Free -ge 24.5GB){break}
}
$after=(Get-PSDrive C).Free
Record @{stage='completed';freeBytes=$after;reclaimedBytes=($after-$before);filesDeleted=0}
@{losslessCompressionComplete=$true;freeGiB=$after/1GB;reclaimedGiB=($after-$before)/1GB;filesDeleted=0;evidence=$log}|ConvertTo-Json
