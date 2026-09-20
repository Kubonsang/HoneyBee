param([string]$Distribution='Ubuntu-24.04', [ValidateSet('portable','contract')][string]$Suite='portable')
$ErrorActionPreference='Stop'
# Compatibility wrapper: the same Node runner also runs directly on Linux CI.
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\\..'))
$evidence=Join-Path $repo ('output\\verification-docker-'+[Guid]::NewGuid().ToString('N'))
& node (Join-Path $PSScriptRoot 'run.mjs') $evidence $Suite $Distribution
if($LASTEXITCODE -ne 0){throw ('Docker verification failed; evidence retained at '+$evidence)}
Write-Output ('Evidence: '+$evidence)
