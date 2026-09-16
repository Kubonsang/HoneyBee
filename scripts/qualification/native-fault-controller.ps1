param([Parameter(Mandatory=$true)][string]$CaseDirectory,[Parameter(Mandatory=$true)][string]$ConfigSha256)
$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$case=[IO.Path]::GetFullPath($CaseDirectory)
$allowed=Join-Path $bundle 'Matrix'
if (-not $case.StartsWith($allowed+'\',[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Parent $case) -ne $allowed) { throw 'Case is outside the fixed QA matrix' }
for ($cursor=$case; $cursor; $cursor=Split-Path -Parent $cursor) {
    if ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected QA path refused' }
}
function Write-Evidence([string]$Name,$Value) {
    $destination=Join-Path $case $Name
    $temporary=Join-Path $case ('.'+$Name+'.'+[guid]::NewGuid().ToString('N')+'.tmp')
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 16)); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    # Publish only closed, complete bytes. Move refuses an existing evidence file.
    [IO.File]::Move($temporary,$destination)
}
function Assert-BoundQABaseline($Installation,$Config,$Inputs,$Current) {
    $source=$Inputs.servicePair.source
    $step=@($Inputs.updates)[0]
    if ($Installation -ne $Config.installationRoot -or
        $Config.sourceVersion -notmatch '^0\.1\.0-beta\.[1-9][0-9]*$' -or
        $Config.sourceVersion -ne $source.version -or
        $Config.sourceVersion -ne $step.from -or
        $Config.sourceVersion -ne $Current.activeVersion -or
        $Config.sourceHostSha256 -notmatch '^[a-f0-9]{64}$' -or
        $Config.sourceHostSha256 -ne $source.host.sha256 -or
        $Config.manifestSha256 -ne $step.manifestSha256) {
        throw 'Not the bound QA baseline installation'
    }
}
try {
    $pin=Get-Content -Raw -LiteralPath (Join-Path $bundle 'guest.json')|ConvertFrom-Json
    if ($env:COMPUTERNAME -ne $pin.computerName) { throw 'Wrong QA computer' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'QA fault controller requires elevation' }
    $configPath=Join-Path $case 'worker.json'
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ConfigSha256) { throw 'QA configuration changed' }
    $config=Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath|ConvertFrom-Json
    if ($config.schemaVersion -ne 1 -or -not $config.qualificationOnly -or $config.nonce -notmatch '^[a-f0-9]{64}$' -or $config.manifestSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid QA identity' }
    $profile=(Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$pin.userSid)).ProfileImagePath
    $installation=Join-Path $profile 'AppData\Local\HoneyBee'
    $inputs=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $bundle 'inputs.json')|ConvertFrom-Json
    $current=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installation 'current.json')|ConvertFrom-Json
    Assert-BoundQABaseline $installation $config $inputs $current
    $hostFile=Join-Path $installation ('versions\'+$config.sourceVersion+'\tools\honeybee-workspace-storage-host.exe')
    if ((Get-FileHash -LiteralPath $hostFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.sourceHostSha256) { throw 'QA host changed' }
    $capabilities=& $hostFile qualification-capabilities | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $capabilities.protectedCheckpoints -ne 1 -or -not $capabilities.qualificationOnly) { throw 'Instrumented QA baseline required' }
    $states=@{'service-backup-verified'='BackupVerified';'service-stopped'='Stopped';'service-replaced'='Replaced';'service-validated'='ReadyForAppCommit';'service-health-failure'='ReadyForAppCommit'}
    if (-not $states.ContainsKey($config.point)) { throw 'Unsupported fixed service checkpoint' }
    if ($config.action -notin @('kill','reboot','poweroff','fail')) { throw 'Unsupported fixed action' }
    $mode=if ($config.action -eq 'fail') {'fail'} else {'halt'}
    if ($config.previousNonce) {
        if ($config.previousNonce -notmatch '^[a-f0-9]{64}$') { throw 'Invalid previous QA nonce' }
        $disarmed=& $hostFile qualification-disarm $config.previousNonce | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or -not $disarmed.disarmed) { throw 'Previous QA arm could not be retired' }
    }
    $arm=& $hostFile qualification-arm $config.nonce $config.manifestSha256 $states[$config.point] $mode | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Native checkpoint admission failed' }
    Write-Evidence 'native-ready.json' @{schemaVersion=1;configSha256=$ConfigSha256;arm=$arm}
    $deadline=[DateTime]::UtcNow.AddMinutes(20)
    do {
        $cancelPath=Join-Path $case 'controller-cancel.json'
        if (Test-Path -LiteralPath $cancelPath) {
            $cancel=Get-Content -Raw -LiteralPath $cancelPath|ConvertFrom-Json
            if ($cancel.configSha256 -ne $ConfigSha256) { throw 'Cancellation identity differs' }
            & $hostFile qualification-disarm $config.nonce | Out-Null
            throw 'QA worker stopped before checkpoint; retain this attempt'
        }
        $reached=& $hostFile qualification-status $config.nonce | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Native checkpoint query failed' }
        if ($reached.reached) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $reached.reached) { throw 'Native checkpoint timeout' }
    if ($reached.state -ne $states[$config.point] -or $reached.manifestSha256 -ne $config.manifestSha256) { throw 'Native checkpoint identity differs' }
    if ($config.action -eq 'kill') {
        $interruption=& $hostFile qualification-interrupt $config.nonce | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or -not $interruption.interrupted) { throw 'Bound process interruption failed' }
    }
    Write-Evidence 'reached.json' @{schemaVersion=1;configSha256=$ConfigSha256;point=$config.point;reached=$true;native=$reached;action=$config.action}
} catch { Write-Evidence 'native-error.json' @{schemaVersion=1;error="$($_)"}; exit 1 }
