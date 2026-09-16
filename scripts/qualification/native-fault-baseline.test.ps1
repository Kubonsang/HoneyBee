$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'native-fault-controller.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Controller parse failed' }
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-BoundQABaseline'},$true)
# Execute only the pure admission function; no elevation, native tools or service operations.
. ([scriptblock]::Create($function.Extent.Text))
function Invoke-Fixture([string]$Version,[string]$Change) {
    $installation='C:\Users\fixture\AppData\Local\HoneyBee'
    $hostHash='a'*64; $manifestHash='b'*64
    $config=@{installationRoot=$installation;sourceVersion=$Version;sourceHostSha256=$hostHash;manifestSha256=$manifestHash}
    $inputs=@{servicePair=@{source=@{version=$Version;host=@{sha256=$hostHash}}};updates=@(@{from=$Version;manifestSha256=$manifestHash})}
    $current=@{activeVersion=$Version}
    switch ($Change) {
        'root' {$config.installationRoot='C:\Other'}
        'version' {$config.sourceVersion='0.1.0-beta.11'}
        'current' {$current.activeVersion='0.1.0-beta.23'}
        'step' {$inputs.updates[0].from='0.1.0-beta.11'}
        'hash' {$config.sourceHostSha256='c'*64}
        'manifest' {$config.manifestSha256='d'*64}
        'path' {$config.sourceVersion='../0.1.0-beta.22'}
        'missing' {$inputs.servicePair.source=$null}
    }
    Assert-BoundQABaseline $installation $config $inputs $current
}
Invoke-Fixture '0.1.0-beta.11' ''
Invoke-Fixture '0.1.0-beta.22' ''
foreach ($change in @('root','version','current','step','hash','manifest','path','missing')) {
    $rejected=$false
    try { Invoke-Fixture '0.1.0-beta.22' $change } catch { $rejected=$true }
    if (-not $rejected) { throw ('Unsafe admission: '+$change) }
}
Write-Output 'PASS: 2 bound sources accepted; 8 mismatches rejected. No service operations.'
