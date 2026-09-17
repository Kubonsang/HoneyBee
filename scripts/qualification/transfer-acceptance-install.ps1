param([Parameter(Mandatory=$true)][string]$WorkspaceRoot)
$ErrorActionPreference='Stop'
$record=Join-Path $WorkspaceRoot 'output\acceptance-completion-20260916\temporary-vm.json'
$pin=Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
if($pin.name -ne 'HoneyBee-Acceptance-beta32'){throw 'Unexpected temporary VM'}
$vm=Get-VM -Id $pin.id
if($vm.Name -ne $pin.name -or $vm.State -ne 'Running'){throw 'Temporary VM is not running'}
$files=@(
    @{source=(Join-Path $WorkspaceRoot 'output\final-release-builds\build-FXg9Xs\distributions\distribution-vPVNDj\HoneyBeeSetup.exe');name='HoneyBeeSetup.exe'},
    @{source=(Join-Path $WorkspaceRoot 'scripts\qualification\acceptance-install-journey.ps1');name='acceptance-install-journey.ps1'}
)
if((Get-FileHash -LiteralPath $files[0].source -Algorithm SHA256).Hash -ne '8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e'){throw 'Setup changed'}
$destination='C:\HoneyBeeQA\acceptance-completion-20260916'
foreach($file in $files){
    Copy-VMFile -VM $vm -SourcePath $file.source -DestinationPath ($destination+'\'+$file.name) -FileSource Host -CreateFullPath
}
@{schemaVersion=1;stage='Delivered';vm=$vm.Name;vmId=$pin.id;destination=$destination;files=$files.Count} | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($record)) 'install-delivered.json') -Encoding UTF8
