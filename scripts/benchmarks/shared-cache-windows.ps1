param(
  [Parameter(Mandatory=$true)][string]$TestPlay,
  [Parameter(Mandatory=$true)][string]$SourceProject,
  [Parameter(Mandatory=$true)][string]$Unity,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [int]$WarmRuns = 10,
  [switch]$ColdOnly,
  [switch]$ResumeWarm
)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputPath = [IO.Path]::GetFullPath($OutputRoot)
if (-not $outputPath.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Benchmark output must be inside this checkout' }
if (-not $ResumeWarm) {
  if (Test-Path -LiteralPath $outputPath) { throw 'Use a new benchmark output directory' }
  New-Item -ItemType Directory -Path $outputPath | Out-Null
  foreach ($mode in @('local','shared-content')) {
    $project = Join-Path $outputPath $mode
    New-Item -ItemType Directory -Path $project | Out-Null
    foreach ($folder in @('Assets','Packages','ProjectSettings')) {
      $source = Join-Path $SourceProject $folder
      $linked = @(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
      if ($linked.Count -ne 0) { throw "Benchmark source contains links: $folder" }
      Copy-Item -LiteralPath $source -Destination (Join-Path $project $folder) -Recurse
    }
    $config = @{ schema_version='1'; project_path='.'; unity_path=$Unity; result_dir='.testplay/results'; test_platform='edit_mode'; timeout=@{total_ms=600000}; workspace=@{cache_mode=$mode} }
    if ($mode -eq 'shared-content') { $config.workspace.cache_root = Join-Path $outputPath 'store' }
    $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $project 'testplay.json') -Encoding utf8NoBOM
  }
}
$records = [System.Collections.Generic.List[object]]::new()
if ($ResumeWarm) { foreach ($record in (Get-Content (Join-Path $outputPath 'measurements.json') -Raw | ConvertFrom-Json)) { $records.Add($record) } }
$startIndex = 0
if ($ResumeWarm) { $startIndex = 1 }
$lastIndex = $WarmRuns
if ($ColdOnly) { $lastIndex = 0 }
for ($iteration=$startIndex; $iteration -le $lastIndex; $iteration++) {
  $modes = @('local','shared-content')
  if ($iteration % 2 -eq 0) { $modes = @('shared-content','local') }
  foreach ($mode in $modes) {
    $project = Join-Path $outputPath $mode
    $stdout = Join-Path $outputPath "$mode-$iteration.json"
    $stderr = Join-Path $outputPath "$mode-$iteration.stderr.log"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $project
    try {
      & $TestPlay run --config (Join-Path $project 'testplay.json') --shadow --filter Combat.Tests.CombatSimulationTests 1> $stdout 2> $stderr
      $code = $LASTEXITCODE
    } finally { Pop-Location; $timer.Stop() }
    $result = Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json
    $record = [pscustomobject]@{ mode=$mode; iteration=$iteration; cold=($iteration -eq 0); wallMs=$timer.ElapsedMilliseconds; exitCode=$code; result=$result }
    $records.Add($record)
    $records | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $outputPath 'measurements.json') -Encoding utf8
    Write-Output "$mode iteration=$iteration exit=$code wallMs=$($timer.ElapsedMilliseconds)"
    if ($code -ne 0 -or $result.total -le 0) { throw "Native test failed: $mode iteration $iteration; inspect $stdout and $stderr" }
  }
}
