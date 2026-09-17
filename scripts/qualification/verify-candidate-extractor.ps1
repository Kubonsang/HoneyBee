param([Parameter(Mandatory=$true)][string]$Installation,[Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference='Stop'
$runtime=Join-Path $Installation 'recovery\v1'
$manifestPath=Join-Path $runtime 'manifest.json'
# This is the assembled Setup input's recovery manifest, not the release
# manifest's recovery.inventorySha256 (which hashes the application inventory).
if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne '454e376271bcd6a52e98d3334d7efc2410e691289ec1536699f0f0c0675fe9f2'){throw 'Candidate recovery inventory differs'}
$inventory=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tool=Join-Path $runtime 'output\update-tools\honeybee-update-package.exe'
$toolHash=(Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash.ToLowerInvariant()
if($toolHash -ne $inventory.files.'output/update-tools/honeybee-update-package.exe'){throw 'Candidate extractor differs'}
$directory=Join-Path $OutputRoot ('extractor-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
Add-Type -AssemblyName System.IO.Compression
$results=@()
$reasons=@{
    traversal='unsafe path segment';absolute='unsafe path segment';stream='unsafe archive path';device='Windows device path';
    duplicate='duplicate or unsupported ZIP entry';'case-collision'='case-aliased path';'stable-launcher'='entry outside application payload';
    'user-state'='entry outside application payload';digest='archive SHA-256 mismatch';truncated='zip: not a valid zip file'
}
$cases=@(
    @{id='valid';names=@('desktop/file.txt');valid=$true},
    @{id='traversal';names=@('desktop/../../escape')},
    @{id='absolute';names=@('/desktop/file')},
    @{id='stream';names=@('desktop/file:stream')},
    @{id='device';names=@('desktop/NUL.txt')},
    @{id='duplicate';names=@('desktop/a','desktop/a')},
    @{id='case-collision';names=@('desktop/A','desktop/a')},
    @{id='stable-launcher';names=@('HoneyBeeLauncher.exe')},
    @{id='user-state';names=@('data/user.json')},
    @{id='digest';names=@('desktop/a');badHash=$true},
    @{id='truncated';names=@('desktop/a');truncate=$true}
)
foreach($case in $cases){
    $archive=Join-Path $directory ($case.id+'.zip')
    $file=[IO.File]::Open($archive,[IO.FileMode]::CreateNew)
    try{
        $zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create,$true)
        try{
            foreach($name in $case.names){
                $entry=$zip.CreateEntry($name)
                $stream=$entry.Open()
                try{$bytes=[Text.Encoding]::UTF8.GetBytes('fixture');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
            }
        }finally{$zip.Dispose()}
    }finally{$file.Dispose()}
    if($case.truncate){$file=[IO.File]::OpenWrite($archive);try{$file.SetLength(16)}finally{$file.Dispose()}}
    $hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if($case.badHash){$hash='0'*64}
    $destination=Join-Path $directory ($case.id+'-extracted')
    $process=Start-Process -FilePath $tool -WindowStyle Hidden -ArgumentList @('extract',('"'+$archive+'"'),('"'+$destination+'"'),$hash) -Wait -PassThru -RedirectStandardOutput (Join-Path $directory ($case.id+'.stdout')) -RedirectStandardError (Join-Path $directory ($case.id+'.stderr'))
    $errorText=Get-Content -LiteralPath (Join-Path $directory ($case.id+'.stderr')) -Raw
    if($null -eq $errorText){$errorText=''}else{$errorText=$errorText.Trim()}
    $passed=if($case.valid){$process.ExitCode -eq 0 -and (Get-Content (Join-Path $destination 'desktop\file.txt') -Raw) -eq 'fixture'}else{$process.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $destination) -and $errorText -eq $reasons[$case.id]}
    $results+=@{case=$case.id;passed=$passed;exitCode=$process.ExitCode;reason=$errorText}
}
$report=@{schemaVersion=1;candidate='0.1.0-beta.32';extractorSha256=$toolHash;results=$results;passed=(@($results | Where-Object {-not $_.passed}).Count -eq 0);acceptancePromoted=$false}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'result.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 5
if(-not $report.passed){exit 1}
