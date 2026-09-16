param(
    [Parameter(Mandatory = $true)][ValidateSet('Protect', 'Unprotect')][string]$Action,
    [Parameter(Mandatory = $true)][string]$KeyPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.IO.Path]::GetFullPath($KeyPath)
if ($full -cne $KeyPath -or [System.IO.Path]::GetExtension($full) -ne '.dpapi') { throw 'Absolute .dpapi key path required.' }
if ($full.Substring([System.IO.Path]::GetPathRoot($full).Length).Contains(':')) { throw 'Alternate key streams refused.' }
$directory = [System.IO.Path]::GetDirectoryName($full)
function Assert-PlainPath([string]$Target) {
    $part = $Target
    while ($part) {
        if ([System.IO.File]::Exists($part) -or [System.IO.Directory]::Exists($part)) {
            if (([System.IO.File]::GetAttributes($part) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected key storage refused.' }
        }
        $part = [System.IO.Path]::GetDirectoryName($part)
    }
}
function Assert-Private([string]$Target) {
    $acl = if ([System.IO.Directory]::Exists($Target)) { [System.IO.Directory]::GetAccessControl($Target) } else { [System.IO.File]::GetAccessControl($Target) }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Private key storage owner or inheritance mismatch.' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne $allow -or $rules[0].FileSystemRights -ne $rights) { throw 'Private key storage permissions mismatch.' }
}
Assert-PlainPath $full
if ($Action -eq 'Protect' -and -not [System.IO.Directory]::Exists($directory)) {
    $parent = [System.IO.Path]::GetDirectoryName($directory)
    if (-not [System.IO.Directory]::Exists($parent)) { throw 'Key directory parent must already exist.' }
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, 'ContainerInherit,ObjectInherit', 'None', $allow)))
    [System.IO.Directory]::CreateDirectory($directory, $security) | Out-Null
}
Assert-Private $directory
$entropy = [System.Text.Encoding]::UTF8.GetBytes('HoneyBee release signing key v1')
$clear = $null
try {
    if ($Action -eq 'Protect') {
        # Input is delivered through a private child-process pipe, never arguments or a file.
        $encoded = [Console]::In.ReadToEnd()
        if ($encoded.Length -gt 16384) { throw 'Key exceeds limit.' }
        $clear = [Convert]::FromBase64String($encoded)
        $encoded = $null
        $cipher = [System.Security.Cryptography.ProtectedData]::Protect($clear, $entropy, 'CurrentUser')
        $security = New-Object System.Security.AccessControl.FileSecurity
        $security.SetOwner($sid)
        $security.SetAccessRuleProtection($true, $false)
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $allow)))
        $stream = New-Object System.IO.FileStream($full, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, $security)
        try { $stream.Write($cipher, 0, $cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-Private $full
        [Console]::Out.Write('protected')
    } else {
        Assert-Private $full
        $stream = [System.IO.File]::Open($full, 'Open', 'Read', 'None')
        try {
            if ($stream.Length -gt 16384) { throw 'Protected key exceeds limit.' }
            $cipher = New-Object byte[] $stream.Length
            $read = 0
            while ($read -lt $cipher.Length) {
                $count = $stream.Read($cipher, $read, $cipher.Length - $read)
                if ($count -eq 0) { throw 'Truncated protected key.' }
                $read += $count
            }
            $clear = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, 'CurrentUser')
            [Console]::Out.Write([Convert]::ToBase64String($clear))
        } finally { $stream.Dispose() }
    }
} finally {
    if ($null -ne $clear) { [Array]::Clear($clear, 0, $clear.Length) }
}
