$ErrorActionPreference='Stop'
$vm=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters'
if($vm.VirtualMachineName -ne 'HoneyBee-Acceptance-beta32'){throw 'Wrong VM'}
& winget.exe settings --enable LocalManifestFiles
if($LASTEXITCODE -ne 0){throw 'WinGet local manifest setting failed'}
