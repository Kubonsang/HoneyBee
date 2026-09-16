param(
    [Parameter(Mandatory = $true)][string]$Artifact,
    [string]$PublisherThumbprint,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [ValidateSet('signed', 'unsigned-beta')][string]$ReleaseMode = 'signed'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Artifact)
if ($version.ProductName -ne 'HoneyBee' -or $version.ProductVersion -ne $ExpectedVersion) { throw 'Setup product/version differs from release manifest.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Artifact
if ($ReleaseMode -eq 'unsigned-beta') {
    if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+-beta\.\d+$' -or $PublisherThumbprint) { throw 'Unsigned beta requires a beta version and no certificate claim.' }
    if ($signature.Status -ne 'NotSigned') { throw 'Unsigned beta requires an unsigned artifact, not an invalid or unexpected signature.' }
    @{ schemaVersion = 1; valid = $true; authenticode = 'not-signed'; publisherThumbprint = $null } | ConvertTo-Json -Compress
    exit 0
}
if ($PublisherThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Expected publisher certificate thumbprint is required.' }
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Artifact Authenticode validation failed.' }
if ($signature.SignerCertificate.Thumbprint -ine $PublisherThumbprint) { throw 'Unexpected Authenticode publisher.' }
if ($null -eq $signature.TimeStamperCertificate) { throw 'Timestamped Authenticode signature is required.' }
@{ schemaVersion = 1; valid = $true; authenticode = 'signed'; publisherThumbprint = $signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress
