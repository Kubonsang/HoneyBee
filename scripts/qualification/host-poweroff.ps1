param([Parameter(Mandatory=$true)][string]$GuestCaseDirectory,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Nonce)
$ErrorActionPreference='Stop'
if ($GuestCaseDirectory -notmatch '^C:\\HoneyBeeQA\\[A-Za-z0-9_-]+\\Matrix\\poweroff-service-replaced-attempt-[0-9]{3}$') { throw 'Only the fixed guest power-off case is allowed' }
$vm=Get-VM -Id 'a4693938-ec51-4427-a453-1e44739d7db2'
if ($vm.Name -ne 'HoneyBee-Setup-QA-20260910') { throw 'QA VM identity differs' }
if ($vm.State -ne 'Running') { throw 'QA VM must be running at the held checkpoint' }
$integration=Get-VMIntegrationService -VM $vm | Where-Object { $_.Id.ToString().ToUpperInvariant().Contains('6C09BB55-D683-4DA0-8931-C9BF705F6480') -or $_.Name -eq 'Guest Service Interface' }
if (@($integration).Count -ne 1 -or -not $integration.Enabled) { throw 'Guest file copy must already be enabled' }
# Explicitly invoked by the QA operator only after the guest reports this nonce
# and checkpoint. No checkpoint restore or host shutdown is performed.
$record=[ordered]@{schemaVersion=1;vm=$vm.Name;vmId="$($vm.Id)";nonce=$Nonce;action='TurnOff';started=[DateTime]::UtcNow.ToString('o')}
Stop-VM -VM $vm -TurnOff -Confirm:$false
if ((Get-VM -Id $vm.Id).State -ne 'Off') { throw 'Forced power-off was not observed' }
$record.completed=[DateTime]::UtcNow.ToString('o')
$evidence=Join-Path $env:TEMP ('HoneyBee-poweroff-'+$Nonce+'.json')
$stream=[IO.File]::Open($evidence,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
try { $bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally {$stream.Dispose()}
Start-VM -VM $vm | Out-Null
Write-Host 'QA VM powered off and started. Waiting for guest file copy...'
$deadline=[DateTime]::UtcNow.AddMinutes(3)
do {
    try {
        Copy-VMFile -VM $vm -SourcePath $evidence -DestinationPath ($GuestCaseDirectory+'\host-poweroff.json') -FileSource Host
        Write-Host 'Power-off witness delivered. Sign in to the VM and rerun the integrated QA command.'
        exit 0
    } catch { if ([DateTime]::UtcNow -gt $deadline) { throw }; Start-Sleep -Seconds 2 }
} while ($true)
