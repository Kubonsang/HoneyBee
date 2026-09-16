$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$service = Get-CimInstance Win32_Service -Filter "Name='UnityWorkspaceStorage'"
$installation = Join-Path $env:LOCALAPPDATA 'HoneyBee'
$store = Join-Path $env:ProgramData 'UnityWorkspaceStorage'
[ordered]@{
    computerName = $env:COMPUTERNAME
    userSid = $identity.User.Value
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    installationRoot = $installation
    storeRoot = $store
    installationExists = Test-Path -LiteralPath $installation
    storeExists = Test-Path -LiteralPath $store
    service = if ($null -eq $service) { $null } else { $service | Select-Object Name,State,StartMode,StartName,PathName }
    freeBytes = (Get-PSDrive -Name C).Free
    bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 5
