$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($env:COMPUTERNAME -ne 'DESKTOP-9LT0JVV' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001') { throw 'Use the original QA guest user.' }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run without elevation.' }
$files = [Collections.Generic.List[object]]::new()
$skipped = [Collections.Generic.List[object]]::new()
function Inventory-Tree([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push([IO.Path]::GetFullPath($Root))
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        try {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $skipped.Add([pscustomobject]@{path=$current;reason='ReparsePoint-not-followed'})
                continue
            }
            if ($item.PSIsContainer) {
                foreach ($child in @(Get-ChildItem -LiteralPath $current -Force)) { $pending.Push($child.FullName) }
            } else {
                $files.Add([pscustomobject]@{path=$item.FullName;bytes=$item.Length;modifiedUtc=$item.LastWriteTimeUtc.ToString('o')})
            }
        } catch { $skipped.Add([pscustomobject]@{path=$current;reason=$_.Exception.Message}) }
    }
}
$installation = Join-Path $env:LOCALAPPDATA 'HoneyBee'
$store = Join-Path $env:ProgramData 'UnityWorkspaceStorage'
$roots = @('C:\HoneyBeeQA', $installation, $store, (Join-Path $env:APPDATA 'HoneyBee'))
$groups = [Collections.Generic.List[object]]::new()
foreach ($root in $roots) {
    Write-Host ('Reading file sizes: ' + $root)
    $start = $files.Count
    Inventory-Tree $root
    $items = @($files | Select-Object -Skip $start)
    $groups.Add([pscustomobject]@{root=$root;files=$items.Count;bytes=($items | Measure-Object bytes -Sum).Sum})
}
$registryPath = Join-Path $installation 'workspace-core\workspace-registry-v2.json'
$registry = $null
$registryError = $null
try {
    if (Test-Path -LiteralPath $registryPath) {
        if ((Get-Item -LiteralPath $registryPath).Length -gt 8MB) { throw 'Registry exceeds inspection size bound.' }
        $registry = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
    }
} catch { $registryError=$_.Exception.Message }
$qaGroups = @($files | Where-Object { $_.path.StartsWith('C:\HoneyBeeQA\',[StringComparison]::OrdinalIgnoreCase) } | Group-Object { $_.path.Substring('C:\HoneyBeeQA\'.Length).Split('\')[0] } | ForEach-Object {
    [pscustomobject]@{name=$_.Name;bytes=($_.Group | Measure-Object bytes -Sum).Sum;files=$_.Count}
} | Sort-Object bytes -Descending)
$report = [ordered]@{
    schemaVersion=1;inspectionOnly=$true;computerName=$env:COMPUTERNAME;userSid=$identity.User.Value
    timestamp=[DateTime]::UtcNow.ToString('o');freeBytes=(Get-PSDrive -Name C).Free
    registryPath=$registryPath;registryError=$registryError;registry=$registry
    roots=$groups.ToArray();qaDirectories=$qaGroups;skipped=$skipped.ToArray();files=$files.ToArray()
    deletionAuthorizedByReport=$false;backupVerified=$false
}
$destination = Join-Path $PSScriptRoot ('reuse-inventory-' + [Guid]::NewGuid().ToString('N') + '.json')
$stream = [IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
try { $bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
[ordered]@{
    inspectionOnly=$true;freeBytes=$report.freeBytes;registryError=$registryError
    projects=@($registry.projects | Where-Object { $null -ne $_ } | Select-Object projectId,label,repositoryRoot,unityProjectPath,workspaceRoot)
    workspaces=@($registry.workspaces | Where-Object { $null -ne $_ } | Select-Object workspaceId,workspacePath,state,branch)
    roots=$groups.ToArray();qaDirectories=@($qaGroups | Select-Object -First 20)
    skippedCount=$skipped.Count;evidence=$destination;backupVerified=$false
} | ConvertTo-Json -Depth 8
Write-Host 'Inventory only. No files or services were removed. Keep this report.'
