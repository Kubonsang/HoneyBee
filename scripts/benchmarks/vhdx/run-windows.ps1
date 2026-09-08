param(
  [Parameter(Mandatory=$true)][string]$SourceProject,
  [Parameter(Mandatory=$true)][string]$Unity,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [ValidateRange(1,10)][int]$Runs = 3,
  [switch]$TraceWrites,
  [string]$BenchmarkBinary = ''
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$root = [IO.Path]::GetFullPath($OutputRoot)
$prefix = (Join-Path $repo 'tmp') + [IO.Path]::DirectorySeparatorChar
if (-not $root.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputRoot must be a new directory under checkout/tmp' }
if (Test-Path -LiteralPath $root) { throw 'OutputRoot already exists; choose a fresh path' }
if (Get-Process -Name Unity -ErrorAction SilentlyContinue) { throw 'Close Unity editors before capturing the source Library' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an elevated PowerShell terminal to attach disposable benchmark disks' }
$binary = Join-Path $repo 'output/honeybee-vhdx-bench.exe'
if ($BenchmarkBinary) { $binary = [IO.Path]::GetFullPath($BenchmarkBinary) }
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Build output/honeybee-vhdx-bench.exe first; see README.md' }
Push-Location -LiteralPath $repo
try {
  $arguments = @('--root', $root, '--source', [IO.Path]::GetFullPath($SourceProject), '--unity', [IO.Path]::GetFullPath($Unity), '--runs', [string]$Runs)
  if ($TraceWrites) { $arguments += '--trace-writes' }
  & $binary @arguments
  if ($LASTEXITCODE -ne 0) { throw "Benchmark failed with exit code $LASTEXITCODE; inspect status.json and Unity logs" }
} finally { Pop-Location }
