param(
  [Parameter(Mandatory=$true)][string]$SourceProject,
  [Parameter(Mandatory=$true)][string]$LegacyParent,
  [Parameter(Mandatory=$true)][string]$Unity,
  [Parameter(Mandatory=$true)][string]$TestPlay,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [ValidateRange(1,3)][int]$Runs = 3,
  [ValidateRange(1,5)][int]$Cycles = 5
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$binary = Join-Path $repo 'output/honeybee-vhdx-capacity.exe'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Disposable disk attachment requires elevation.' }
foreach ($inputPath in @($SourceProject,$LegacyParent,$Unity,$TestPlay,$binary)) {
  if (-not (Test-Path -LiteralPath $inputPath)) { throw "Missing input: $inputPath" }
}
if (Test-Path -LiteralPath (Join-Path $SourceProject 'Library')) { throw 'SourceProject must be a frozen authored-file export without a live Library.' }
Push-Location -LiteralPath $repo
try {
  & $binary --capacity --root $OutputRoot --source $SourceProject --legacy-parent $LegacyParent --unity $Unity --testplay $TestPlay --runs $Runs --cycles $Cycles
  if ($LASTEXITCODE -ne 0) { throw "Capacity campaign failed: $LASTEXITCODE; inspect status.json and per-sample logs." }
} finally { Pop-Location }
