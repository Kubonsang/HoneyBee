param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Baseline', 'Cancelled', 'Installed')]
    [string]$Phase,
    [Parameter(Mandatory=$true)]
    [string]$EvidenceDirectory,
    [Parameter(Mandatory=$true)]
    [string]$ExpectedComputerName,
    [Parameter(Mandatory=$true)]
    [string]$SetupPath,
    [string]$InstallationRoot = (Join-Path $env:LOCALAPPDATA 'HoneyBee')
)
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne $ExpectedComputerName) { throw 'Computer identity differs from the intended test VM' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Collect evidence as the original unelevated installer user, not the administrator'
}
$evidenceRoot = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$baselinePath = Join-Path $evidenceRoot 'Baseline.json'
$receiptPath = Join-Path $env:ProgramData 'UnityWorkspaceStorage/install-receipt.json'
$service = Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'"
$receipt = if (Test-Path -LiteralPath $receiptPath) { Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json } else { $null }
$healthPath = Join-Path $InstallationRoot '.setup-pending/health.json'
$health = if (Test-Path -LiteralPath $healthPath) { Get-Content -Raw -LiteralPath $healthPath | ConvertFrom-Json } else { $null }
$checks = [ordered]@{}
$report = [ordered]@{
    schemaVersion = 1
    phase = $Phase
    timestamp = [DateTime]::UtcNow.ToString('o')
    computerName = $env:COMPUTERNAME
    initiatingSid = $identity.User.Value
    setupSha256 = (Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash
    os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber)
    service = ($service | Select-Object Name,State,StartMode,StartName,PathName)
    receipt = $receipt
    health = $health
    checks = $checks
}
if ($Phase -eq 'Baseline') {
    $checks.noUserInstallRoot = -not (Test-Path -LiteralPath $InstallationRoot)
    $checks.noService = $null -eq $service
    $checks.noReceipt = $null -eq $receipt
    $checks.noApplication = -not (Test-Path -LiteralPath (Join-Path $InstallationRoot 'current.json'))
    $checks.noPreviousSetup = -not (Test-Path -LiteralPath (Join-Path $InstallationRoot '.setup-pending'))
} else {
    $baseline = Get-Content -Raw -LiteralPath $baselinePath | ConvertFrom-Json
    $checks.cleanBaseline = $baseline.passed -eq $true
    $checks.sameSetup = $baseline.setupSha256 -eq $report.setupSha256
    $checks.sameComputer = $baseline.computerName -eq $env:COMPUTERNAME
    $checks.sameInitiatingUser = $baseline.initiatingSid -eq $identity.User.Value
    $checks.applicationPublished = Test-Path -LiteralPath (Join-Path $InstallationRoot '.setup-pending/published.json')
    $checks.healthRecorded = $null -ne $health
    if ($Phase -eq 'Cancelled') {
        $checks.noService = $null -eq $service
        $checks.noReceipt = $null -eq $receipt
        $checks.notReady = $null -ne $health -and $health.ready -eq $false
        $checks.cancellationReported = $null -ne $health -and $health.reason -match 'elevation-cancelled|installation was cancelled'
        $checks.needsAttention = $null -ne $health -and $health.serviceAction -eq 'needs-attention'
    } else {
        $checks.running = $null -ne $service -and $service.State -eq 'Running'
        $checks.originalSid = $null -ne $receipt -and $receipt.userSid -eq $baseline.initiatingSid
        $checks.ready = $null -ne $health -and $health.ready -eq $true
        $checks.localSystem = $null -ne $service -and $service.StartName -eq 'LocalSystem'
        $checks.binaryMatchesReceipt = $null -ne $receipt -and (Test-Path -LiteralPath $receipt.executable) -and ((Get-FileHash -LiteralPath $receipt.executable -Algorithm SHA256).Hash -eq $receipt.executableSha256)
        if ($null -ne $receipt) {
            $report.storeAcl = (Get-Acl -LiteralPath $receipt.storeRoot).Sddl
            $report.workspaceAcl = (Get-Acl -LiteralPath $receipt.workspaceRoot).Sddl
        }
    }
    $activation = Get-Content -Raw -LiteralPath (Join-Path $InstallationRoot 'current.json') | ConvertFrom-Json
    if ($activation.activeVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid activation version' }
    $hostPath = Join-Path $InstallationRoot "versions/$($activation.activeVersion)/tools/honeybee-workspace-storage-host.exe"
    $report.diagnose = (& $hostPath diagnose | Out-String | ConvertFrom-Json)
    $checks.diagnoseSucceeded = $LASTEXITCODE -eq 0
    $report.cliVersion = (& (Join-Path $InstallationRoot 'bin/honeybee.exe') --version | Out-String).Trim()
    $checks.cliLaunches = $LASTEXITCODE -eq 0
}
$report.passed = -not ($checks.Values -contains $false)
# Exclusive evidence publication: never overwrite another run or a baseline.
$outputPath = Join-Path $evidenceRoot ($Phase + '.json')
$stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 16))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
} finally { $stream.Dispose() }
$report | ConvertTo-Json -Depth 16
if (-not $report.passed) { exit 1 }
