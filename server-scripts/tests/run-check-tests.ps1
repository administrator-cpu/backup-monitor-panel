# run-check-tests.ps1 - tests for panel-status.ps1 and the three morning check
# scripts. Windows PowerShell 5.1, ASCII only. Runs the real check scripts in a
# temporary folder against FAKE common files (fake rclone, restic, psql and
# e-mail), so nothing real is listed, read or sent.
#   powershell -NoProfile -ExecutionPolicy Bypass -File server-scripts\tests\run-check-tests.ps1

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$script:Pass = 0
$script:Fail = 0
function Assert([bool]$Condition, [string]$Name) {
    if ($Condition) { $script:Pass++; Write-Host ('  ok   ' + $Name) }
    else { $script:Fail++; Write-Host ('  FAIL ' + $Name) -ForegroundColor Red }
}

$tmp = Join-Path $env:TEMP ('panel-check-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
foreach ($d in @('status', 'logs')) { New-Item -ItemType Directory -Path (Join-Path $tmp $d) | Out-Null }

$today = (Get-Date).ToString('yyyy-MM-dd')
$day1 = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$day2 = (Get-Date).AddDays(-2).ToString('yyyy-MM-dd')
$recent = (Get-Date).AddHours(-5).ToString('o')

# Shared fake helpers, written into each fake common file.
$fakeShared = @'
function Log($m, $l = 'INFO') { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\test.log') -Value ('[' + $l + '] ' + $m) }
function Send-Mail($s, $b) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\mail.log') -Value $s; return $true }
function Limit-Text($t, $n) { return [string]$t }
function Format-Size($b) { return ('{0} B' -f $b) }
function Get-FreeGB($p) { return 500 }
function New-FakeResult($code, $lines) { return [pscustomobject]@{ Code = $code; Lines = @($lines) } }
$FailListing = Test-Path (Join-Path $PSScriptRoot 'fail-listing.flag')
'@

$pgCommon = $fakeShared + @"

`$Cfg = @{ Remote = 'gcrypt:postgres'; StatusDir = (Join-Path `$PSScriptRoot 'status'); LogDir = (Join-Path `$PSScriptRoot 'logs'); MaxBackupAgeHours = 30; Staging = 'C:\'; MinFreeGB = 1 }
function Get-RemoteSnapshots { return @('$day2', '$day1', '$today') }
function Invoke-Psql(`$db, `$a) {
    if ((`$a -join ' ') -match 'count') { return (New-FakeResult 0 @('2')) }
    return (New-FakeResult 0 @('app', 'crm', 'newdb'))
}
function Invoke-Rclone(`$a) {
    `$a = @(`$a)
    if (`$a[0] -eq 'lsf' -and `$a -contains '-R') {
        if (`$FailListing) { return (New-FakeResult 1 @('ERROR : listing failed')) }
        return (New-FakeResult 0 @('NOTICE: some rclone notice', '$day2/manifest.txt|10', '$day2/app.dump|1000', '$day1/manifest.txt|10', '$day1/app.dump|1100', '$day1/crm.dump|50', '$today/manifest.txt|10', '$today/globals.sql|5', '$today/app.dump|1200', '$today/crm.dump|60'))
    }
    if (`$a[0] -eq 'lsf') { return (New-FakeResult 0 @('manifest.txt', 'globals.sql', 'app.dump', 'crm.dump')) }
    if (`$a[0] -eq 'about') { return (New-FakeResult 0 @('{', '  "total": 2199023255552,', '  "used": 107374182400,', '  "trashed": 0,', '  "other": 1073741824,', '  "free": 2090575331328', '}')) }
    if (`$a[0] -eq 'size') { return (New-FakeResult 0 @('{"count":9,"bytes":3445}')) }
    return (New-FakeResult 1 @('unexpected'))
}
"@

$mongoCommon = $fakeShared + @"

`$Cfg = @{ MongoRemote = 'gcrypt:mongodb'; MongoShrinkAlarm = 0.5; StatusDir = (Join-Path `$PSScriptRoot 'status'); LogDir = (Join-Path `$PSScriptRoot 'logs'); MaxBackupAgeHours = 30; MongoStaging = 'C:\'; MinFreeGB = 1 }
function Get-MongoRemoteSnapshots { return @('$day1', '$today') }
function Invoke-Rclone(`$a) {
    `$a = @(`$a)
    if (`$a[0] -eq 'lsf' -and `$a -contains '-R') { return (New-FakeResult 0 @('$day1/manifest.txt|10', '$day1/mongo-all.archive|5000000', '$today/manifest.txt|10', '$today/mongo-all.archive|5100000')) }
    if (`$a[0] -eq 'lsf') { return (New-FakeResult 0 @('manifest.txt|10', 'mongo-all.archive|5100000')) }
    if (`$a[0] -eq 'size') { return (New-FakeResult 0 @('{"count":4,"bytes":10100020}')) }
    return (New-FakeResult 1 @('unexpected'))
}
"@

$filesCommon = $fakeShared + @"

`$Cfg = @{ FileSets = [ordered]@{ logs = @{}; files = @{} }; ResticHost = 'vps-prod'; FileMaxAgeHours = 30; StatusDir = (Join-Path `$PSScriptRoot 'status'); LogDir = (Join-Path `$PSScriptRoot 'logs'); MinFreeGB_F = 1; MinFreeGB_C = 1; B2SizeAlarmGB = 100000; B2PricePerGB = 0.00695 }
`$script:Set = ''
function Find-Restic { return 'restic.exe' }
function Initialize-ResticEnv(`$n) { `$script:Set = `$n }
function Clear-ResticEnv { `$script:Set = '' }
function ConvertFrom-ResticJsonLines(`$lines) { foreach (`$l in @(`$lines)) { if (`$l) { `$l | ConvertFrom-Json } } }
function Invoke-Restic(`$a) {
    `$a = @(`$a)
    if (`$a[0] -eq 'stats') { return (New-FakeResult 0 @('{"total_size":5000000,"total_file_count":12}')) }
    `$t1 = (Get-Date).ToUniversalTime().AddHours(-5).ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')
    `$t2 = (Get-Date).ToUniversalTime().AddHours(-29).ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')
    if (`$script:Set -eq 'logs') { `$paths = '["F:\\syslog-data"]' } else { `$paths = '["C:\\Apps\\one","C:\\Site"]' }
    `$s1 = '{"time":"' + `$t2 + '","id":"aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888","short_id":"aaaa1111","paths":' + `$paths + ',"summary":{"data_added":2048,"data_added_packed":1024,"total_files_processed":10,"total_bytes_processed":999999}}'
    `$s2 = '{"time":"' + `$t1 + '","id":"1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90","short_id":"1234abcd","paths":' + `$paths + ',"summary":{"data_added":4096,"total_files_processed":11,"total_bytes_processed":1000123}}'
    `$list = @('[' + `$s1 + ',' + `$s2 + ']')
    # Slow Backblaze: restic prints retry lines next to the JSON (this broke v1.1 on 2026-11-12).
    if (Test-Path (Join-Path `$PSScriptRoot 'slow-b2.flag')) { `$list = @('Load(<snapshot/aaaa1111>, 0, 0) returned error, retrying after 552.330144ms: Get "https://f003.backblazeb2.com/...": EOF') + `$list }
    return (New-FakeResult 0 `$list)
}
"@

function Set-Fixture([string]$Common, [string]$CommonName, [string]$CheckName, [bool]$WithHelper = $true) {
    Get-ChildItem -LiteralPath (Join-Path $tmp 'status') | Remove-Item -Force
    Get-ChildItem -LiteralPath (Join-Path $tmp 'logs') | Remove-Item -Force
    Get-ChildItem -LiteralPath $tmp -Filter '*.ps1' | Remove-Item -Force
    Remove-Item -LiteralPath (Join-Path $tmp 'fail-listing.flag') -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText((Join-Path $tmp $CommonName), $Common)
    Copy-Item -LiteralPath (Join-Path $src $CheckName) -Destination $tmp
    if ($WithHelper) { Copy-Item -LiteralPath (Join-Path $src 'panel-status.ps1') -Destination $tmp }
}

function Invoke-Check([string]$CheckName) {
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp $CheckName)
    return $LASTEXITCODE
}

function Read-Status([string]$Name) {
    $p = Join-Path $tmp ('status\' + $Name)
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    return (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($p)))
}

$mails = { $p = Join-Path $tmp 'logs\mail.log'; if (Test-Path $p) { @(Get-Content $p) } else { @() } }

try {
    # ------------------------------------------------------------------
    Write-Host 'Helper functions'
    . (Join-Path $src 'panel-status.ps1')
    Assert ((ConvertTo-PanelUtc '2026-11-12T03:30:05.123456789+05:30') -eq '2026-11-11T22:00:05Z') 'nine-digit restic times are read'
    Assert ((ConvertTo-PanelUtc '2026-11-12T03:30:05Z') -eq '2026-11-12T03:30:05Z') 'UTC times stay UTC'
    Assert ($null -eq (ConvertTo-PanelUtc 'not a time')) 'nonsense is not a time'
    $g = ConvertFrom-PanelDriveListing @('2026-11-10/a.dump|100', 'junk line', '2026-11-11/a.dump|200', '2026-11-11/b.dump|5', 'other/x|9')
    $set = New-PanelDriveSet 'pg' 'gcrypt:postgres' $g
    Assert ($set.count -eq 2 -and $set.newest -eq '2026-11-11' -and $set.oldest -eq '2026-11-10' -and $set.storedBytes -eq 305) 'Drive folders are grouped by night, newest first'
    Assert ($set.points[0].files -eq 2 -and $set.points[0].bytes -eq 205) 'each night has its size and file count'
    $cov = Get-PanelDbCoverage @('app', 'crm', 'app2') @('2026-11-11/app.dump', '2026-11-11/crm_2026-11-11.dump') '.dump'
    Assert ((@($cov.databases) -join ',') -eq 'app,crm' -and (@($cov.missing) -join ',') -eq 'app2') 'a database without a dump is listed as missing'
    $many = @{}
    for ($i = 0; $i -lt 400; $i++) { $many[(Get-Date '2025-01-01').AddDays($i).ToString('yyyy-MM-dd')] = @{ bytes = [int64]1; files = 1; names = @('x.dump') } }
    $big = New-PanelDriveSet 'pg' 'r:' $many
    Assert ($big.count -eq 400 -and @($big.points).Count -eq 180 -and $big.points[0].id -eq '2026-02-04') 'long histories keep the newest 180 nights and the full count'

    # ------------------------------------------------------------------
    Write-Host 'pg-backup-check.ps1 with the helper'
    Set-Fixture $pgCommon 'pg-backup-common.ps1' 'pg-backup-check.ps1'
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\last-success.json'), ('{"time":"' + $recent + '","databases":["app","crm"],"totalBytes":1260,"seconds":4}'))
    $code = Invoke-Check 'pg-backup-check.ps1'
    $st = Read-Status 'pg-snapshots.json'
    Assert ($code -eq 0 -and (& $mails).Count -eq 0) 'the check still passes and sends no e-mail'
    Assert ($null -ne $st -and $st.kind -eq 'pg' -and $st.check.ok -eq $true) 'pg-snapshots.json is written with the check result'
    Assert ($st.sets[0].count -eq 3 -and $st.sets[0].newest -eq $today -and $st.sets[0].storedBytes -eq 3445) 'three nights listed, newest today'
    Assert ($st.drive.totalBytes -eq 2199023255552 -and $st.drive.usedBytes -eq 107374182400) 'Google Drive space is recorded'
    Assert ((@($st.coverage.missing) -join ',') -eq 'newdb' -and @($st.coverage.databases).Count -eq 2) 'a database with no dump today is flagged'
    New-Item -ItemType File -Path (Join-Path $tmp 'fail-listing.flag') | Out-Null
    $code = Invoke-Check 'pg-backup-check.ps1'
    $st = Read-Status 'pg-snapshots.json'
    Assert ($code -eq 0 -and (& $mails).Count -eq 0) 'a failed panel listing does not change the check'
    Assert ($st.sets[0].count -eq 3 -and @($st.notes).Count -ge 1) 'the last good list is kept and the problem is noted'

    Write-Host 'pg-backup-check.ps1 without the helper'
    Set-Fixture $pgCommon 'pg-backup-common.ps1' 'pg-backup-check.ps1' $false
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\last-success.json'), ('{"time":"' + $recent + '"}'))
    $code = Invoke-Check 'pg-backup-check.ps1'
    Assert ($code -eq 0 -and $null -eq (Read-Status 'pg-snapshots.json')) 'without panel-status.ps1 the check runs as before'

    Write-Host 'pg-backup-check.ps1 when the check finds a problem'
    Set-Fixture $pgCommon 'pg-backup-common.ps1' 'pg-backup-check.ps1'
    $code = Invoke-Check 'pg-backup-check.ps1'
    $st = Read-Status 'pg-snapshots.json'
    Assert ($code -eq 1 -and (& $mails).Count -eq 1) 'a problem is still e-mailed and exits 1'
    Assert ($st.check.ok -eq $false -and @($st.check.problems)[0] -match 'No successful run') 'the panel file carries the problem'

    # ------------------------------------------------------------------
    Write-Host 'mongo-backup-check.ps1'
    Set-Fixture $mongoCommon 'mongo-backup-common.ps1' 'mongo-backup-check.ps1'
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\mongo-last-success.json'), ('{"time":"' + $recent + '","databases":["shop_production","reports_db"],"totalBytes":5100000,"seconds":40}'))
    $code = Invoke-Check 'mongo-backup-check.ps1'
    $st = Read-Status 'mongo-snapshots.json'
    Assert ($code -eq 0 -and (& $mails).Count -eq 0) 'the check still passes and sends no e-mail'
    Assert ($st.kind -eq 'mongo' -and $st.sets[0].count -eq 2 -and $st.sets[0].points[0].bytes -eq 5100010) 'two nights listed with their size'
    Assert ((@($st.coverage.databases) -join ',') -eq 'shop_production,reports_db') 'the databases in the archive are listed'

    # ------------------------------------------------------------------
    Write-Host 'files-backup-check.ps1'
    Set-Fixture $filesCommon 'files-backup-common.ps1' 'files-backup-check.ps1'
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\files-last-success.json'), ('{"time":"' + $recent + '","sets":{}}'))
    $code = Invoke-Check 'files-backup-check.ps1'
    $st = Read-Status 'files-snapshots.json'
    Assert ($code -eq 0 -and (& $mails).Count -eq 0) 'the check still passes and sends no e-mail'
    $logs = @($st.sets | Where-Object { $_.id -eq 'logs' })[0]
    $files = @($st.sets | Where-Object { $_.id -eq 'files' })[0]
    Assert ($logs.count -eq 2 -and $logs.points[0].id -eq '1234abcd' -and $logs.points[1].id -eq 'aaaa1111') 'restic snapshots are listed newest first by short id'
    Assert ($logs.points[0].added -eq 4096 -and $logs.points[1].added -eq 1024 -and $logs.points[0].bytes -eq 1000123) 'size and uploaded bytes come from the snapshot summary'
    Assert ($logs.storedBytes -eq 5000000 -and $logs.provider -eq 'Backblaze B2') 'the stored size in Backblaze is kept per set'
    Assert ((@($logs.paths) -join ',') -eq 'F:\syslog-data' -and @($files.paths).Count -eq 2) 'the folders in the newest snapshot are listed'
    Assert ($logs.oldest -lt $logs.newest) 'oldest and newest restore points are known'
    Assert ($logs.listMs -ge 0 -and $null -ne $logs.listMs -and $logs.retries -eq 0) 'the time the listing took is recorded'

    Write-Host 'files-backup-check.ps1 when Backblaze is slow (restic retries)'
    New-Item -ItemType File -Path (Join-Path $tmp 'slow-b2.flag') | Out-Null
    $code = Invoke-Check 'files-backup-check.ps1'
    $st = Read-Status 'files-snapshots.json'
    $log = Get-Content -LiteralPath (Join-Path $tmp 'logs\test.log') -Raw
    Remove-Item -LiteralPath (Join-Path $tmp 'slow-b2.flag')
    Assert ($code -eq 0 -and (& $mails).Count -eq 0) 'retry lines no longer make the check fail (was "Invalid JSON primitive: Load")'
    Assert ($log -match 'Backblaze was slow: restic retried 1 time' -and $log -notmatch 'CHECK FAILED') 'the retries are logged as a warning instead'
    Assert (@($st.sets | Where-Object { $_.id -eq 'logs' })[0].retries -eq 1) 'the panel learns about the retries'

    # ------------------------------------------------------------------
    Write-Host 'What the agent makes of these files'
    . (Join-Path (Split-Path -Parent $src) 'agent\panel-agent.ps1') -ConfigPath 'unused'
    $sizeOk = (Get-Item (Join-Path $tmp 'status\files-snapshots.json')).Length -lt 262144
    Assert $sizeOk 'the summary is small enough for the agent to send'
    $parsed = ConvertFrom-Json ([System.IO.File]::ReadAllText((Join-Path $tmp 'status\files-snapshots.json')))
    $safe = ConvertTo-SafeValue $parsed 0
    $json = ConvertTo-Json -InputObject $safe -Depth 12 -Compress
    Assert ($json -notmatch '\(hidden\)' -and $json -match '1234abcd' -and $json -match 'syslog-data') 'nothing in it looks like a secret to the agent'
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('{0} passed, {1} failed' -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
