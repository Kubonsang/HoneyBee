param([string]$Inspector=(Join-Path $PSScriptRoot 'inspect-integrated-guest.ps1'))
$ErrorActionPreference='Stop'
$global:HoneyBeeInspectionTestCase='missing'
# Stub only CIM reads. No service is installed, stopped or removed by this test.
function Get-CimInstance {
    param([string]$ClassName,[string]$Filter)
    if($ClassName -eq 'Win32_OperatingSystem'){return [pscustomobject]@{LastBootUpTime=[DateTime]::UtcNow}}
    if($ClassName -ne 'Win32_Service'){throw 'Unexpected CIM class'}
    if($global:HoneyBeeInspectionTestCase -eq 'error'){throw 'CIM inspection failed'}
    if($global:HoneyBeeInspectionTestCase -eq 'missing'){return}
    return [pscustomobject]@{Name='UnityWorkspaceStorage';State='Running';StartMode='Auto';StartName='LocalSystem';PathName='C:\QA\broker.exe broker-run'}
}
$missing=(& $inspector)|ConvertFrom-Json
if($null -ne $missing.service){throw 'Missing service must serialize as JSON null.'}
$global:HoneyBeeInspectionTestCase='present'
$present=(& $inspector)|ConvertFrom-Json
if($present.service.Name -ne 'UnityWorkspaceStorage' -or $present.service.State -ne 'Running' -or $present.service.PathName -ne 'C:\QA\broker.exe broker-run'){throw 'Existing service evidence must be retained.'}
$global:HoneyBeeInspectionTestCase='error'
$refused=$false
try {& $inspector|Out-Null} catch {if($_.Exception.Message -eq 'CIM inspection failed'){$refused=$true}else{throw}}
if(-not $refused){throw 'Failed CIM inspection must not be treated as a clean baseline.'}
[pscustomobject]@{powershell=$PSVersionTable.PSVersion.ToString();passed=3;serviceMutations=0}|ConvertTo-Json
