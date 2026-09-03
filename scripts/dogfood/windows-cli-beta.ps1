[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HoneyBee,
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,
    [Parameter(Mandatory = $true)]
    [string]$EvidencePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$HoneyBee = (Resolve-Path -LiteralPath $HoneyBee).Path
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
$StorageClient = Join-Path (Split-Path -Parent $HoneyBee) "dist\unity-workspace-storage.exe"
$Names = @("combat", "ui", "enemy-ai", "level")
$RunId = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")

function Invoke-HoneyBeeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )
    $output = & $HoneyBee @Arguments "--data-root" $DataRoot "--json" 2>&1
    $exitCode = $LASTEXITCODE
    $text = $output -join [Environment]::NewLine
    $payload = $null
    try {
        $payload = $text | ConvertFrom-Json
    }
    catch {
        if (-not $AllowFailure) {
            throw "HoneyBee returned non-JSON output: $text"
        }
    }
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "HoneyBee failed with exit code ${exitCode}: $text"
    }
    [pscustomobject]@{ ExitCode = $exitCode; Payload = $payload; Text = $text }
}

function Measure-HoneyBeeJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-HoneyBeeJson -Arguments $Arguments
    $watch.Stop()
    [pscustomobject]@{ Milliseconds = $watch.ElapsedMilliseconds; Result = $result }
}

function Get-StorageStatus {
    $requestId = "hb-dogfood-$RunId-$([Guid]::NewGuid().ToString('N'))"
    $output = & $StorageClient workspace status --schema 2 --request-id $requestId 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "workspace storage status failed: $($output -join [Environment]::NewLine)"
    }
    ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

if (-not (Test-Path -LiteralPath $StorageClient -PathType Leaf)) {
    throw "The packaged storage client is missing: $StorageClient"
}
foreach ($target in @($WorkspaceRoot, $DataRoot)) {
    if (Test-Path -LiteralPath $target) {
        $entries = @(Get-ChildItem -LiteralPath $target -Force)
        if ($entries.Count -ne 0) {
            throw "Dogfood requires an absent or empty dedicated path: $target"
        }
    }
}
$dirty = @(& git.exe -C $ProjectPath status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Dogfood requires a clean disposable clone of the real Unity project."
}

$doctor = Invoke-HoneyBeeJson -Arguments @("doctor")
if (-not $doctor.Payload.ready) {
    throw "Doctor did not pass. Resolve every blocking check before dogfood."
}
$baselineStorage = Get-StorageStatus
if (
    $baselineStorage.status.activeChildCount -ne 0 -or
    $baselineStorage.status.retainedChildCount -ne 0 -or
    $baselineStorage.status.pendingCount -ne 0
) {
    throw "Dogfood storage metrics require zero active, retained, and pending children at baseline."
}

$initialized = Invoke-HoneyBeeJson -Arguments @(
    "project", "init", $ProjectPath, "--workspace-root", $WorkspaceRoot
)
$project = $initialized.Payload.project
$cache = Measure-HoneyBeeJson -Arguments @("cache", "prepare", "--project", $project.projectId)
$storageAfterCache = Get-StorageStatus

$created = @()
$initialHeads = @{}
$createTimings = @()
$allocatedAfterCreate = @()
$previousChildAllocated = [int64]$storageAfterCache.status.activeChildAllocatedBytes +
    [int64]$storageAfterCache.status.retainedChildAllocatedBytes
foreach ($name in $Names) {
    $branch = "honeybee-beta/$name-$RunId"
    $measurement = Measure-HoneyBeeJson -Arguments @(
        "workspace", "create", $name, "--branch", $branch, "--project", $project.projectId
    )
    $workspace = $measurement.Result.Payload.workspace
    $created += $workspace
    $initialHeads[$workspace.workspaceId] = $workspace.git.head
    $createTimings += $measurement.Milliseconds
    $storage = Get-StorageStatus
    $currentChildAllocated = [int64]$storage.status.activeChildAllocatedBytes +
        [int64]$storage.status.retainedChildAllocatedBytes
    $allocatedAfterCreate += [pscustomobject]@{
        Name = $name
        TotalChildAllocatedBytes = $currentChildAllocated
        ReadyChildAllocatedBytes = $currentChildAllocated - $previousChildAllocated
    }
    $previousChildAllocated = $currentChildAllocated
}
$storageAfterCreate = Get-StorageStatus

$worktreeList = & git.exe -C $project.repositoryRoot worktree list --porcelain
if ($LASTEXITCODE -ne 0) {
    throw "git worktree list failed."
}
foreach ($workspace in $created) {
    if (($worktreeList -join [Environment]::NewLine) -notmatch [regex]::Escape($workspace.workspacePath)) {
        throw "Git did not report Workspace $($workspace.name)."
    }
    $resolved = Invoke-HoneyBeeJson -Arguments @(
        "workspace", "path", $workspace.workspaceId, "--project", $project.projectId
    )
    if ($resolved.Payload.workspacePath -ne $workspace.workspacePath) {
        throw "workspace path returned a different path for $($workspace.name)."
    }
}
$libraryTargets = @{}
foreach ($workspace in $created) {
    $library = Join-Path (Join-Path $workspace.workspacePath $project.unityRelativePath) "Library"
    $entry = Get-Item -LiteralPath $library -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Workspace Library is not a reparse point: $library"
    }
    $target = [string]$entry.Target
    if ([string]::IsNullOrWhiteSpace($target)) {
        throw "Workspace Library junction has no target: $library"
    }
    if ($libraryTargets.ContainsValue($target)) {
        throw "Two Workspace Library junctions share the same target: $target"
    }
    $libraryTargets[$workspace.workspaceId] = $target
}

$repairWorkspace = $created[1]
$repairLibrary = Join-Path (Join-Path $repairWorkspace.workspacePath $project.unityRelativePath) "Library"
Remove-Item -LiteralPath $repairLibrary
$repairBefore = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "status", $repairWorkspace.workspaceId, "--project", $project.projectId
)
if ($repairBefore.Payload.workspace.state -ne "repair-required") {
    throw "A missing owned Library junction did not require repair."
}
$repaired = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "repair", $repairWorkspace.workspaceId, "--project", $project.projectId
)
if ($repaired.Payload.workspace.state -ne "ready") {
    throw "Workspace repair did not restore the missing Library junction."
}

Write-Host ""
Write-Host "Open at least two of these Unity projects simultaneously:"
foreach ($workspace in $created) {
    Write-Host "  $($workspace.name): $(Join-Path $workspace.workspacePath $project.unityRelativePath)"
}
Write-Host ""
Write-Host "Wait for import/compile, make isolated authored changes in all four Workspaces, and commit them."
$confirmation = Read-Host "Type CONTINUE only after both Editors and all commits are complete"
if ($confirmation -ne "CONTINUE") {
    throw "Dogfood paused without cleanup. HoneyBee Workspaces and branches were preserved."
}

$afterUnityStorage = Get-StorageStatus
foreach ($workspace in $created) {
    $status = Invoke-HoneyBeeJson -Arguments @(
        "workspace", "status", $workspace.workspaceId, "--project", $project.projectId
    )
    if ($status.Payload.workspace.state -ne "ready" -or $status.Payload.workspace.git.dirty) {
        throw "Workspace $($workspace.name) is not clean and ready after the operator phase."
    }
    if (
        $status.Payload.workspace.git.branch -ne $workspace.branch -or
        $status.Payload.workspace.git.head -eq $initialHeads[$workspace.workspaceId]
    ) {
        throw "Workspace $($workspace.name) does not contain the expected isolated branch commit."
    }
}

$probeWorkspace = $created[0]
$probePath = Join-Path $probeWorkspace.workspacePath ".honeybee-dirty-probe"
Set-Content -LiteralPath $probePath -Value "dirty protection probe" -Encoding utf8
$dirtyRemove = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "remove", $probeWorkspace.workspaceId, "--project", $project.projectId
) -AllowFailure
if ($dirtyRemove.ExitCode -eq 0 -or $dirtyRemove.Payload.code -ne "workspace.dirty") {
    throw "Dirty Workspace removal was not rejected with workspace.dirty."
}
Remove-Item -LiteralPath $probePath

$branchHeads = @{}
$removeTimings = @()
foreach ($workspace in $created) {
    $branchHeads[$workspace.branch] = (
        & git.exe -C $project.repositoryRoot rev-parse "refs/heads/$($workspace.branch)"
    ).Trim()
    $measurement = Measure-HoneyBeeJson -Arguments @(
        "workspace", "remove", $workspace.workspaceId, "--project", $project.projectId
    )
    $removeTimings += $measurement.Milliseconds
}
$repeat = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "remove", $created[0].workspaceId, "--project", $project.projectId
)
foreach ($branch in $branchHeads.Keys) {
    $observed = (& git.exe -C $project.repositoryRoot rev-parse "refs/heads/$branch").Trim()
    if ($observed -ne $branchHeads[$branch]) {
        throw "Branch $branch was deleted or moved during Workspace removal."
    }
}

$finalDoctor = Invoke-HoneyBeeJson -Arguments @("doctor")
$finalStorage = Get-StorageStatus
if (
    $finalStorage.status.activeChildCount -ne 0 -or
    $finalStorage.status.retainedChildCount -ne 0 -or
    $finalStorage.status.pendingCount -ne 0 -or
    $finalStorage.status.manualRecoveryRequired
) {
    throw "Workspace removal left storage children, pending state, or manual recovery behind."
}

$attachBranch = $created[0].branch
$attached = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "attach", "attach-probe", "--branch", $attachBranch, "--project", $project.projectId
)
if ($attached.Payload.workspace.state -ne "ready") {
    throw "Existing branch attach did not produce a ready Workspace."
}
$attachedRemoval = Invoke-HoneyBeeJson -Arguments @(
    "workspace", "remove", $attached.Payload.workspace.workspaceId, "--project", $project.projectId
)
$afterAttachRemovalStorage = Get-StorageStatus
if (
    $afterAttachRemovalStorage.status.activeChildCount -ne 0 -or
    $afterAttachRemovalStorage.status.retainedChildCount -ne 0 -or
    $afterAttachRemovalStorage.status.pendingCount -ne 0
) {
    throw "Attach/remove probe left storage children or pending state behind."
}
$sortedCreate = @($createTimings | Sort-Object)
$sortedRemove = @($removeTimings | Sort-Object)
$evidence = [ordered]@{
    schemaVersion = 1
    runId = $RunId
    honeybeeVersion = (& $HoneyBee --version).Trim()
    projectId = $project.projectId
    cachePrepareMilliseconds = $cache.Milliseconds
    workspaceCreateMilliseconds = $createTimings
    workspaceCreateMedianMilliseconds = ($sortedCreate[1] + $sortedCreate[2]) / 2
    workspaceRemoveMilliseconds = $removeTimings
    workspaceRemoveMedianMilliseconds = ($sortedRemove[1] + $sortedRemove[2]) / 2
    allocatedAfterCreate = $allocatedAfterCreate
    fourWorkspaceAdditionalAllocatedBytes =
        [int64]$storageAfterCreate.status.capacity.allocatedBytes -
        [int64]$storageAfterCache.status.capacity.allocatedBytes
    fourWorkspaceAdditionalAllocatedBytesAfterUnity =
        [int64]$afterUnityStorage.status.capacity.allocatedBytes -
        [int64]$storageAfterCache.status.capacity.allocatedBytes
    childAllocatedBytesAfterUnity =
        [int64]$afterUnityStorage.status.activeChildAllocatedBytes +
        [int64]$afterUnityStorage.status.retainedChildAllocatedBytes
    allocatedBytesFinal = [int64]$afterAttachRemovalStorage.status.capacity.allocatedBytes
    libraryTargets = $libraryTargets
    branchHeads = $branchHeads
    repeatedRemoveSucceeded = $repeat.ExitCode -eq 0
    finalDoctorReady = [bool]$finalDoctor.Payload.ready
    attachSucceeded = $attached.Payload.workspace.state -eq "ready"
    attachRemoveSucceeded = $attachedRemoval.ExitCode -eq 0
}
$parent = Split-Path -Parent $EvidencePath
if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding utf8
Write-Host "Dogfood evidence: $EvidencePath"
Write-Host "Branches were preserved and were not deleted by this harness."
