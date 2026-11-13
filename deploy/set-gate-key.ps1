# set-gate-key.ps1 - make the gate key for the page in front of the backup panel.
# Windows PowerShell 5.1, ASCII only. Run on the SERVER as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\set-gate-key.ps1
#
# It writes C:\nginx-1.30.2\conf\backup-panel-gate.conf, which Nginx reads (see
# deploy\nginx-backup-panel.conf), and prints the new key ONCE. Save it in your
# password manager. Running it again makes a new key: every device then has to
# enter the new one (that is also how you lock out a lost laptop).
# It changes nothing else and does not reload Nginx; the guide says when to.

[CmdletBinding()]
param(
    [string]$NginxDir = 'C:\nginx-1.30.2'
)

$ErrorActionPreference = 'Stop'
$conf = Join-Path $NginxDir 'conf'
if (-not (Test-Path -LiteralPath $conf)) { throw "Nginx conf folder not found: $conf (use -NginxDir)" }
$path = Join-Path $conf 'backup-panel-gate.conf'

# 20 characters from 32 easy-to-read letters and digits (no 0/O, 1/I): 100 random bits.
$alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$bytes = New-Object byte[] 20
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$chars = @()
foreach ($b in $bytes) { $chars += $alphabet[$b % 32] }   # 256 is a multiple of 32: no bias
$plain = -join $chars
$key = '{0}-{1}-{2}-{3}' -f $plain.Substring(0, 5), $plain.Substring(5, 5), $plain.Substring(10, 5), $plain.Substring(15, 5)

if (Test-Path -LiteralPath $path) {
    Copy-Item -LiteralPath $path -Destination ($path + '.previous') -Force
    Write-Host ('The old key file was kept as {0}.previous' -f $path)
}
$text = @(
    ('# Gate key for the backup panel, made by set-gate-key.ps1 on {0}.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm')),
    '# Keep this file private. Run set-gate-key.ps1 again to change the key.',
    '# (An exact-match pattern, so no map_hash_bucket_size change is needed in nginx.conf.)',
    'map $cookie_bp_gate $backup_panel_gate {',
    '    default 0;',
    ('    "~^{0}$" 1;' -f $key),
    '}'
) -join "`r`n"
[System.IO.File]::WriteAllText($path, $text + "`r`n", (New-Object System.Text.ASCIIEncoding))

Write-Host ''
Write-Host 'New gate key (shown only now; save it in your password manager):'
Write-Host ''
Write-Host ('    ' + $key) -ForegroundColor Yellow
Write-Host ''
Write-Host ('Written to {0}' -f $path)
Write-Host 'Next, in C:\nginx-1.30.2:  .\nginx.exe -t   and, only if the test is successful,  .\nginx.exe -s reload'
