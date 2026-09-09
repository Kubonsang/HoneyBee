param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Archive
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).ProviderPath
$ownedRoot=(Resolve-Path -LiteralPath $Root).ProviderPath
$tmpBase=Join-Path $repo 'tmp'
$archivePath=[IO.Path]::GetFullPath($Archive)
if ([IO.Path]::GetDirectoryName($ownedRoot) -ne $tmpBase) { throw 'Cleanup root must be a direct child of checkout/tmp' }
if ([IO.Path]::GetDirectoryName($archivePath) -ne (Join-Path $repo 'output')) { throw 'Archive must be directly under checkout/output' }
if (Test-Path -LiteralPath $archivePath) { throw 'Archive already exists' }
Set-Location -LiteralPath $repo
$campaign=Get-Content -LiteralPath (Join-Path $ownedRoot 'campaign.json') -Raw | ConvertFrom-Json
$evidence=Join-Path $repo ('output/'+[IO.Path]::GetFileName($ownedRoot)+'-evidence')
if ($campaign.protocol -ne 'footprint-v1' -or $campaign.evidence -ne $evidence) { throw 'Unexpected campaign identity' }
$status=Get-Content -LiteralPath (Join-Path $ownedRoot 'status.json') -Raw | ConvertFrom-Json
$confirmationPath=Join-Path $ownedRoot 'confirmation.json'
$confirmation=$null
if (Test-Path -LiteralPath $confirmationPath) { $confirmation=Get-Content -LiteralPath $confirmationPath -Raw | ConvertFrom-Json }
if (!$status.ok -and !$confirmation.ok) { throw 'Campaign is not successfully terminal' }
if ((Test-Path -LiteralPath (Join-Path $ownedRoot 'confirmation-started.json')) -and !$confirmation.ok) { throw 'Confirmation is incomplete' }
$diagnostic=Get-Content -LiteralPath (Join-Path $ownedRoot 'diagnostic.json') -Raw | ConvertFrom-Json
if (!$diagnostic.ok) { throw 'Diagnostic is incomplete' }
$editDiagnosticPath=Join-Path $ownedRoot 'edit-diagnostic.json'
if (Test-Path -LiteralPath (Join-Path $ownedRoot 'E-fp-base-91-sample.json')) {
    if (!(Test-Path -LiteralPath $editDiagnosticPath) -or !(Get-Content -LiteralPath $editDiagnosticPath -Raw | ConvertFrom-Json).ok) { throw 'Edit diagnostic is incomplete' }
}
foreach ($process in @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Unity.exe','testplay.exe') -or $_.Name -like 'honeybee-footprint-*.exe' })) {
    if (!$process.CommandLine) { throw 'Cannot verify process ownership' }
    if ($process.CommandLine.Replace('/','\').IndexOf($ownedRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Campaign process remains active' }
}
foreach ($ancestor in @($ownedRoot,$evidence,[IO.Path]::GetDirectoryName($archivePath))) {
    for ($at=$ancestor; $at; $at=[IO.Path]::GetDirectoryName($at)) {
        if ((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked cleanup/archive ancestor' }
    }
}
$registryPath=Join-Path $env:LOCALAPPDATA 'HoneyBee/workspace-core/workspace-registry-v2.json'
$registryHash=(Get-FileHash -LiteralPath $registryPath).Hash
$registry=Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
foreach ($protected in (@($registry.projects.storageCommand)+@($registry.projects.unityProjectPath)+@($registry.workspaces.workspacePath))) {
    if ($protected) {
        $absolute=[IO.Path]::GetFullPath($protected)
        if ($absolute -eq $ownedRoot -or $absolute.StartsWith($ownedRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Registered user path inside cleanup root' }
    }
}
foreach ($image in @(Get-ChildItem -LiteralPath $ownedRoot -Filter '*.vhdx')) {
    if ($image.Name -notmatch '^parent-fp-(8|16|32|64)\.vhdx$') { throw 'Unreclaimed child remains; preserve it' }
    if ((Get-DiskImage -ImagePath $image.FullName).Attached) { throw 'Campaign parent remains attached' }
    $capacity=[regex]::Match($image.Name,'\d+').Value
    $identity=Get-Content -LiteralPath (Join-Path $ownedRoot "parent-$capacity-identity.json") -Raw | ConvertFrom-Json
    if ((Get-FileHash -LiteralPath $image.FullName).Hash.ToLowerInvariant() -ne $identity.sha256) { throw 'Parent identity changed' }
}
$stack=[Collections.Generic.Stack[string]]::new()
$stack.Push($ownedRoot)
$files=0
$bytes=[long]0
while ($stack.Count) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($stack.Pop())) {
        $attributes=[IO.File]::GetAttributes($entry)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unexpected link: $entry" }
        if ($attributes -band [IO.FileAttributes]::Directory) { $stack.Push($entry) }
        else {
            if ([IO.Path]::GetExtension($entry) -in @('.vhd','.vhdx')) {
                if ([IO.Path]::GetDirectoryName($entry) -ne $ownedRoot -or [IO.Path]::GetFileName($entry) -notmatch '^parent-fp-(8|16|32|64)\.vhdx$') { throw 'Unexpected nested disk image' }
            }
            $files++; $bytes+=([IO.FileInfo]$entry).Length
        }
    }
}
$receipts=@(Get-ChildItem -LiteralPath $evidence -Filter '*.receipt.json')
foreach ($file in $receipts) {
    $receipt=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if (!$receipt.verified -or $receipt.root -ne $ownedRoot -or [IO.Path]::GetDirectoryName($receipt.archive) -ne $evidence) { throw 'Unexpected sample receipt' }
    if ((Get-FileHash -LiteralPath $receipt.archive).Hash.ToLowerInvariant() -ne $receipt.sha256) { throw 'Sample archive changed' }
}
& python scripts/benchmarks/vhdx/summarize_footprint.py $ownedRoot --output ([IO.Path]::ChangeExtension($archivePath,'.summary.json'))
if ($LASTEXITCODE -ne 0) { throw 'Independent summary validation failed' }
& python scripts/benchmarks/vhdx/archive_capacity.py $ownedRoot $archivePath
if ($LASTEXITCODE -ne 0) { throw 'Campaign archive failed' }
$receipt=Get-Content -LiteralPath ([IO.Path]::ChangeExtension($archivePath,'.receipt.json')) -Raw | ConvertFrom-Json
if (!$receipt.verified -or $receipt.root -ne $ownedRoot -or $receipt.archive -ne $archivePath -or $receipt.sample) { throw 'Invalid final receipt' }
if ((Get-FileHash -LiteralPath $archivePath).Hash.ToLowerInvariant() -ne $receipt.sha256) { throw 'Final archive changed' }
$before=(Get-PSDrive C).Free
Remove-Item -LiteralPath $ownedRoot -Recurse -Force
if (Test-Path -LiteralPath $ownedRoot) { throw 'Cleanup incomplete' }
if ((Get-FileHash -LiteralPath $registryPath).Hash -ne $registryHash) { throw 'Registry changed during cleanup' }
@{ok=$true;removed=$ownedRoot;logicalBytes=$bytes;files=$files;sampleArchivesVerified=$receipts.Count;beforeFreeBytes=$before;afterFreeBytes=(Get-PSDrive C).Free;registryPreserved=$true;archiveSHA256=$receipt.sha256;finishedAt=[DateTimeOffset]::Now.ToString('o')} | ConvertTo-Json | Set-Content ([IO.Path]::ChangeExtension($archivePath,'.cleanup.json'))
