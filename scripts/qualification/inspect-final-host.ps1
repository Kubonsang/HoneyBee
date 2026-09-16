param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$record = [ordered]@{
    schemaVersion = 1
    operation = 'ReadOnlyHostInspection'
    started = [DateTime]::UtcNow.ToString('o')
    ok = $false
    computerName = $env:COMPUTERNAME
}
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $record.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $record.elevated) { throw 'Run host inspection from administrator PowerShell.' }
    $vm = Get-VM -Id 'a4693938-ec51-4427-a453-1e44739d7db2'
    if ($vm.Name -ne 'HoneyBee-Setup-QA-20260910') { throw 'QA VM identity differs.' }
    $record.vm = $vm | Select-Object Name,Id,State,Path,Generation,CheckpointType
    $record.checkpoints = @(Get-VMSnapshot -VM $vm | Select-Object Name,Id,CreationTime,SnapshotType)
    $record.disks = @(Get-VMHardDiskDrive -VM $vm | Select-Object ControllerType,ControllerNumber,ControllerLocation,Path)
    $record.integration = @(Get-VMIntegrationService -VM $vm | Select-Object Name,Id,Enabled,PrimaryStatusDescription)
    $record.hostFreeBytes = (Get-PSDrive -Name C).Free
    $record.guestStateVerified = $false
    $record.cleanBaselineVerified = $false
    $record.ok = $true
} catch {
    $record.error = $_.Exception.Message
} finally {
    $record.completed = [DateTime]::UtcNow.ToString('o')
    $json = $record | ConvertTo-Json -Depth 8
    # The caller supplies an existing, dedicated evidence directory. Never replace evidence.
    $destination = Join-Path $OutputDirectory 'host-inspection.json'
    $stream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json + [Environment]::NewLine)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    Write-Host $json
    Write-Host ('Evidence: ' + $destination)
}
if (-not $record.ok) { exit 1 }
