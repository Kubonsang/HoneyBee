$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'native-fault-controller.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw ($parseErrors|Out-String)}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Evidence'},$true)
if(-not $definition){throw 'Evidence writer missing'}
# Load only the writer function, never the privileged controller entry point.
. ([scriptblock]::Create($definition.Extent.Text))
$case=Join-Path (Get-Location).Path ('output\native-evidence-tests\case-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($case)
Write-Evidence 'native-ready.json' @{schemaVersion=1;configSha256='bound'}
$file=Join-Path $case 'native-ready.json'
$value=Get-Content -Raw -LiteralPath $file|ConvertFrom-Json
if($value.configSha256 -ne 'bound'){throw 'Published JSON invalid'}
if(@(Get-ChildItem -LiteralPath $case -Force).Count -ne 1){throw 'Publication left an unexpected temporary file'}
$before=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
$refused=$false
try { Write-Evidence 'native-ready.json' @{configSha256='overwrite'} } catch { $refused=$true }
if(-not $refused -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $before){throw 'Existing evidence overwritten'}
Write-Host 'PASS: closed JSON publication and overwrite refusal; no service or VM operations.'
