param([Parameter(Mandatory=$true)][string]$Record)
$ErrorActionPreference='Stop'
$pin=Get-Content -LiteralPath $Record -Raw -Encoding UTF8 | ConvertFrom-Json
if($pin.name -ne 'HoneyBee-Acceptance-beta32' -or $pin.hostFloorBytes -ne 12GB){throw 'Unexpected capacity policy'}
if($pin.budgetBytes -ne 10GB -and -not ($pin.budgetBytes -eq 14GB -and $pin.capacityApproval -eq 'user-approved-14GiB-20260917') -and -not ($pin.budgetBytes -eq 18GB -and $pin.capacityApproval -eq 'user-approved-18GiB-20260917') -and -not ($pin.budgetBytes -eq 22GB -and $pin.capacityApproval -eq 'user-approved-22GiB-20260917') -and -not ($pin.budgetBytes -eq 26GB -and $pin.capacityApproval -eq 'user-approved-26GiB-20260917') -and -not ($pin.budgetBytes -eq 32GB -and $pin.capacityApproval -eq 'user-approved-32GiB-remaining-six-20260917')){throw 'Unexpected capacity budget'}
$directory=[IO.Path]::GetDirectoryName($pin.disk)
$deadline=[DateTime]::UtcNow.AddDays(2)
do {
    $vm=Get-VM -Id $pin.id
    if($vm.Name -ne $pin.name){throw 'VM identity changed'}
    $files=@(Get-ChildItem -LiteralPath $directory -Recurse -File)
    $bytes=($files | Measure-Object Length -Sum).Sum
    $free=(Get-PSDrive C).Free
    if($bytes -ge $pin.budgetBytes -or $free -lt $pin.hostFloorBytes){
        if($vm.State -eq 'Running'){Suspend-VM -VM $vm}
        @{schemaVersion=1;paused=$true;vmId=$pin.id;temporaryBytes=$bytes;hostFreeBytes=$free;reason='Capacity budget reached; no files removed'} |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($Record)) 'capacity-stop.json') -Encoding UTF8
        exit 1
    }
    Start-Sleep -Seconds 5
} while([DateTime]::UtcNow -lt $deadline)
if($vm.State -eq 'Running'){Suspend-VM -VM $vm}
@{schemaVersion=1;reason='Capacity monitor deadline reached';vmId=$pin.id} |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($Record)) 'capacity-stop.json') -Encoding UTF8
