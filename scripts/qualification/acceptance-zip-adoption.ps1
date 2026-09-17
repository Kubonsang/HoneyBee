$ErrorActionPreference='Stop'
$machine=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($machine.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Use the temporary HoneyBee-Acceptance-beta32 VM.'}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as the original user WITHOUT elevation.'}
$root=Join-Path $env:LOCALAPPDATA 'HoneyBee'
$running=@(Get-Process HoneyBee -ErrorAction SilentlyContinue)
if($running.Count){throw 'Close the HoneyBee main window, then run this command again. No test started.'}
$pointer=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($pointer.activeVersion -ne '0.1.0-beta.32'){throw 'Expected beta.32.'}
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Evidence-adoption')){throw 'Prior adoption attempt exists. Keep it; no automatic replay.'}
Write-Host 'Testing compatible ZIP-style project adoption. Original VM is unchanged. Complete the Setup window when it opens.'
& (Join-Path $root 'versions\0.1.0-beta.32\runtime\node.exe') (Join-Path $PSScriptRoot 'acceptance-zip-adoption.mjs')
if($LASTEXITCODE -ne 0){throw 'Adoption did not pass. Retain Evidence-adoption and the fixture; do not rerun.'}
