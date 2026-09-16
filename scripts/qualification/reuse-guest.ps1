param([switch]$Execute)
$ErrorActionPreference='Stop'
$qa='C:\HoneyBeeQA'
$backup=Join-Path $qa 'Preserved-final-20260914'
$installation='C:\Users\bonsang\AppData\Local\HoneyBee'
$roaming='C:\Users\bonsang\AppData\Roaming\HoneyBee'
$names=@('desktop-update-20260913-104604','interruption-20260913-105901','setup-reboot-20260913-132834','setup-recovery-20260913-131723','startup-reboot-20260913-123412','startup-recovery-20260913-122739')
$stage='Preflight'
$createdBackup=$false
function Plain-Path([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Reparse path refused: '+$cursor) }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
function Plain-Files([string]$Root) {
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($Root)
    $result=[Collections.Generic.List[object]]::new()
    while ($pending.Count) {
        $directory=$pending.Pop();Plain-Path $directory
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            Plain-Path $item.FullName
            if ($item.PSIsContainer) {$pending.Push($item.FullName)} else {$result.Add($item)}
        }
    }
    return $result.ToArray()
}
function Save-Record([string]$Name,$Value) {
    $stream=[IO.File]::Open((Join-Path $backup $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function No-RunningApp {
    $roots=@($installation)+@($names | ForEach-Object {Join-Path $qa $_})
    foreach ($process in @(Get-CimInstance Win32_Process)) {
        foreach ($root in $roots) {
            if (($process.ExecutablePath -and $process.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($process.CommandLine -and $process.CommandLine.IndexOf($root+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0)) { throw ('Close the old HoneyBee/QA process first: PID '+$process.ProcessId) }
        }
        if ($process.Name -eq 'HoneyBee.exe' -and -not $process.ExecutablePath) { throw 'A HoneyBee process cannot be inspected; close it first.' }
    }
}
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    if ($env:COMPUTERNAME -ne 'DESKTOP-9LT0JVV' -or $identity.User.Value -ne 'S-1-5-21-4199076252-3622841657-4011401391-1001' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as the original QA guest user without elevation.' }
    Plain-Path $qa;Plain-Path $backup;Plain-Path $installation;Plain-Path $roaming
    $proofPath=Join-Path $PSScriptRoot 'vm-preservation-verified.json'
    if ((Get-FileHash -LiteralPath $proofPath -Algorithm SHA256).Hash -ne '14D23DE3C4987096EE0994A879A040A2C6A1E0044CEB6A0516A822CF45AE8A48') { throw 'Host preservation proof differs.' }
    $proof=Get-Content -Raw -LiteralPath $proofPath | ConvertFrom-Json
    if (-not $proof.ok -or -not $proof.chainVerified -or $proof.checkpointId -ne 'b59b1f40-cd3b-412b-a301-1d7775179aca') { throw 'Verified preservation checkpoint required.' }
    # Bound to the pinned checkpoint's creation request, not the later verifier time.
    $protectedThrough=[DateTime]::Parse('2026-09-14T13:47:40.6808638Z').ToUniversalTime()
    $registry=Join-Path $installation 'workspace-core\workspace-registry-v2.json'
    Plain-Path $registry
    if (Test-Path -LiteralPath $registry) {
        $entries=Get-Content -Raw -LiteralPath $registry|ConvertFrom-Json
        if ($null -eq $entries.projects -or $null -eq $entries.workspaces -or @($entries.projects).Count -ne 0 -or @($entries.workspaces).Count -ne 0) { throw 'Registered data changed; no cleanup performed.' }
    }
    if (Test-Path -LiteralPath $backup) { throw 'Preservation directory already exists. Do not repeat cleanup; retain the result for review.' }
    No-RunningApp
    $items=[Collections.Generic.List[object]]::new()
    foreach ($name in $names) {
        $root=[IO.Path]::GetFullPath((Join-Path $qa $name))
        if ($root -ne ($qa+'\'+$name) -or (Resolve-Path -LiteralPath $root).ProviderPath -ne $root) { throw 'Unexpected cleanup root.' }
        foreach ($file in @(Plain-Files $root)) {
            if ($file.LastWriteTimeUtc -gt $protectedThrough) { throw ('QA file changed after checkpoint: '+$file.FullName) }
            # All bytes remain in the VM checkpoint. Also retain ordinary files,
            # logs and result records outside the removed package trees.
            $keep=$file.Extension.ToLowerInvariant() -notin @('.exe','.dll','.pak','.bin','.zip','.node','.asar')
            $items.Add([pscustomobject]@{path=$file.FullName;bytes=$file.Length;ticks=$file.LastWriteTimeUtc.Ticks;keep=$keep})
        }
    }
    $keepBytes=($items | Where-Object keep | Measure-Object bytes -Sum).Sum
    if ((Get-PSDrive C).Free -lt ($keepBytes+1GB)) { throw 'Not enough room to preserve non-package files before cleanup.' }
    $reclaim=($items | Where-Object {-not $_.keep} | Measure-Object bytes -Sum).Sum
    Write-Host ('Old QA files selected: '+$items.Count+'; expected net space recovery: '+[Math]::Round($reclaim/1GB,2)+' GiB')
    if (-not $Execute) { Write-Host 'Inspection only. Use -Execute for the approved preservation and cleanup.'; exit 0 }
    New-Item -ItemType Directory -Path $backup | Out-Null
    $createdBackup=$true
    Save-Record 'checkpoint.json' $proof
    Save-Record 'cleanup-plan.json' $items.ToArray()
    $stage='SavingEvidence'
    $copies=[Collections.Generic.List[object]]::new()
    $index=0
    foreach ($item in @($items | Where-Object keep)) {
        $relative=$item.path.Substring($qa.Length+1)
        $target=Join-Path (Join-Path $backup 'qa-records') $relative
        Plain-Path $target
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        $hash=(Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash
        Copy-Item -LiteralPath $item.path -Destination $target -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { throw ('Preserved copy mismatch: '+$relative) }
        $copies.Add([pscustomobject]@{path=$relative;sha256=$hash;bytes=$item.bytes})
        $index++
        if ($index % 250 -eq 0) { Write-Host ('Verified preserved files: '+$index) }
    }
    Save-Record 'preserved-files.json' $copies.ToArray()
    No-RunningApp
    $stage='RemovingVerifiedOldQAPackages'
    foreach ($name in $names) {
        $root=[IO.Path]::GetFullPath((Join-Path $qa $name))
        Plain-Path $root
        if ($root -ne ($qa+'\'+$name) -or (Resolve-Path -LiteralPath $root).ProviderPath -ne $root) { throw 'Deletion target changed.' }
        $expected=@($items | Where-Object {$_.path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)})
        $current=@(Plain-Files $root)
        if ($expected.Count -ne $current.Count) { throw 'QA tree changed after preservation.' }
        $byPath=@{};foreach($item in $expected){$byPath[$item.path]=$item}
        foreach($file in $current) {
            $previous=$byPath[$file.FullName]
            if ($null -eq $previous -or $previous.bytes -ne $file.Length -or $previous.ticks -ne $file.LastWriteTimeUtc.Ticks) { throw 'QA file changed after preservation.' }
        }
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
        Write-Host ('Removed preserved QA package tree: '+$name)
    }
    Save-Record 'qa-cleanup-completed.json' @{checkpointId=$proof.checkpointId;removed=$names;preservedFiles=$copies.Count;freeBytes=(Get-PSDrive C).Free}
    $stage='PreservingEmptyService'
    Write-Host 'QA records are saved. Approve the service-only administrator prompt to preserve the old service files and remove its empty registration.'
    $worker=Join-Path $PSScriptRoot 'reuse-guest-service.ps1'
    $process=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$worker+'"') -PassThru
    if (-not $process.WaitForExit(120000)) { throw 'Service operation is still running; retain evidence and do not retry.' }
    $service=Get-Content -Raw -LiteralPath (Join-Path $backup 'service-reset-result.json')|ConvertFrom-Json
    if (-not $service.ok) { throw ('Service reset stopped: '+$service.error) }
    No-RunningApp
    $stage='PreservingInstallation'
    # Fixed original and preservation paths only; both are checked for reparse ancestors.
    foreach ($pair in @(@{source=$installation;name='installation'},@{source=$roaming;name='desktop-user-data'})) {
        if (Test-Path -LiteralPath $pair.source) {
            $target=Join-Path $backup $pair.name
            Plain-Path $pair.source;Plain-Path $target
            if (Test-Path -LiteralPath $target) { throw 'Preserved installation target already exists.' }
            Move-Item -LiteralPath $pair.source -Destination $target
        }
    }
    $clean=(-not (Test-Path -LiteralPath $installation)) -and (-not (Test-Path -LiteralPath 'C:\ProgramData\UnityWorkspaceStorage')) -and ($null -eq (Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'"))
    $free=(Get-PSDrive C).Free
    $result=[ordered]@{schemaVersion=1;ok=($clean -and $free -ge 16GB);cleanBaseline=$clean;freeBytes=$free;preservedAt=$backup;checkpointId=$proof.checkpointId;readyForQualification=($clean -and $free -ge 16GB)}
    Save-Record 'reuse-result.json' $result
    $result | ConvertTo-Json
    if (-not $result.ok) { exit 1 }
} catch {
    $failure=[ordered]@{ok=$false;stage=$stage;error=$_.Exception.Message;preservedAt=$backup}
    if ($createdBackup) { Save-Record ('failure-'+[Guid]::NewGuid().ToString('N')+'.json') $failure }
    $failure|ConvertTo-Json
    Write-Host 'Stopped safely. Keep all evidence; do not rerun automatically.'
    exit 1
}
