[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [ValidateSet('Plan','Create')][string]$Mode = 'Plan',
  [string]$IsoPath,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedIsoSha256
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = Join-Path $repo 'output/storage-recovery-vm-20261101/HyperV'
$pinPath = Join-Path $repo 'output/storage-recovery-vm-20261101/release-vm-pin.json'
$name = 'HoneyBee-StorageRecovery-20261101'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$blockers = [Collections.Generic.List[string]]::new()
$isoDigest = $null
$resolvedIso = $null
if (-not $IsoPath) { $blockers.Add('official-windows-11-x64-iso-required') }
else {
  $resolvedIso = [IO.Path]::GetFullPath($IsoPath)
  if (-not (Test-Path -LiteralPath $resolvedIso -PathType Leaf)) { $blockers.Add('iso-not-found') }
  else {
    $iso = Get-Item -LiteralPath $resolvedIso -Force
    if ($iso.Extension -ne '.iso' -or ($iso.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'An ordinary ISO file is required' }
    $isoDigest = (Get-FileHash -LiteralPath $resolvedIso -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $ExpectedIsoSha256) { $blockers.Add('microsoft-published-iso-sha256-required') }
    elseif ($isoDigest -ne $ExpectedIsoSha256.ToLowerInvariant()) { throw 'ISO differs from the supplied Microsoft SHA-256' }
  }
}
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { $blockers.Add('hyper-v-powershell-unavailable') }
if (Test-Path -LiteralPath $root) { $blockers.Add('new-vm-directory-already-exists') }
if (Test-Path -LiteralPath $pinPath) { $blockers.Add('vm-pin-already-exists') }
$ancestor = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($root))
while ($ancestor) {
  if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked VM path refused' }
  $ancestor = $ancestor.Parent
}
$volume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
if ($volume.AvailableFreeSpace -lt 60GB) { $blockers.Add('at-least-60-gib-host-headroom-required') }
if ($isAdmin -and (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
  if (Get-VM -Name $name -ErrorAction SilentlyContinue) { $blockers.Add('vm-name-already-exists') }
}
$plan = [ordered]@{
  schemaVersion=1; purpose='isolated hb12 preserving-recovery qualification'; vmName=$name; vmRoot=$root;
  pinPath=$pinPath; generation=2; memoryBytes=4GB; processors=2; diskBytes=64GB;
  secureBoot=$true; virtualTpm=$true; automaticCheckpoints=$false; network='disconnected';
  iso=$resolvedIso; isoSha256=$isoDigest; administrator=$isAdmin; blockers=@($blockers);
  hostFreeBytes=$volume.AvailableFreeSpace; startsVm=$false; installsWindows=$false;
  changesExistingService=$false; publicationAllowed=$false
}
if ($Mode -eq 'Plan' -or $WhatIfPreference) { $plan | ConvertTo-Json -Depth 5; return }
if ($blockers.Count) { throw ('VM preparation blocked: ' + ($blockers -join ', ')) }
if (-not $isAdmin) { throw 'Run this exact script in an administrator PowerShell. No VM was created.' }
if (-not $PSCmdlet.ShouldProcess($root, "Create the NEW isolated Hyper-V VM $name (leave it off)")) { return }
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$vm = New-VM -Name $name -Generation 2 -MemoryStartupBytes 4GB -NewVHDPath (Join-Path $root 'system.vhdx') -NewVHDSizeBytes 64GB -Path $root
Set-VM -VM $vm -ProcessorCount 2 -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -SnapshotFileLocation $root -SmartPagingFilePath $root
Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
Enable-VMTPM -VM $vm
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
$dvd = Add-VMDvdDrive -VM $vm -Path $resolvedIso -Passthru
Set-VMFirmware -VM $vm -FirstBootDevice $dvd
$pin = [ordered]@{schemaVersion=1;vmId=$vm.Id.ToString();vmName=$name;vmRoot=$root;computerName='HB-RECOVERY38';isoSha256=$isoDigest;stage='WindowsSetupRequired';createdAt=[DateTime]::UtcNow.ToString('o')}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($pin | ConvertTo-Json) + "`n")
$file = [IO.File]::Open($pinPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
$pin | ConvertTo-Json
