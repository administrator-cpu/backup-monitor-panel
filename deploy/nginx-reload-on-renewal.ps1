# nginx-reload-on-renewal.ps1 - reload Nginx after win-acme has renewed a certificate.
# Windows PowerShell 5.1, ASCII only.
#
# Why: win-acme renews the certificates into C:\nginx-1.30.2\ssl, but Nginx only
# reads them when it starts or reloads. Without a reload it keeps serving the old
# certificate until that one expires, and the sites show "certificate expired".
#
# What it does, twice a day (scheduled task "Nginx Reload After Renewal"):
#   1. Looks for .pem files in the ssl folder that are newer than the last reload
#      (or, the first time, newer than when Nginx was started).
#   2. If there are any: runs "nginx -t". ONLY if the test passes, runs
#      "nginx -s reload" (a graceful reload: no connection is dropped).
#      If the test fails, it reloads nothing and writes an ERROR line instead,
#      so a broken nginx.conf can never take the sites down.
# It never starts, stops or edits Nginx or win-acme, and deletes nothing.
# Log: C:\Apps\db-backup\logs\nginx-reload.log (the backup panel shows it).
#
#   .\nginx-reload-on-renewal.ps1             one check now (as Administrator)
#   .\nginx-reload-on-renewal.ps1 -Install    create the scheduled task (runs as SYSTEM)
#   .\nginx-reload-on-renewal.ps1 -Status     show the task and the end of the log

[CmdletBinding()]
param(
    [string]$NginxDir = 'C:\nginx-1.30.2',
    [string]$LogFile = 'C:\Apps\db-backup\logs\nginx-reload.log',
    [string]$StateFile = 'C:\Apps\db-backup\panel-agent-state\nginx-reload.json',
    [switch]$Install,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Nginx Reload After Renewal'

function Write-ReloadLog([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 1MB)) {
            Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding ASCII
    } catch { }
}

# Runs nginx.exe in its own folder and returns exit code and output (stdout + stderr).
function Invoke-Nginx([string]$Arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $NginxDir 'nginx.exe'
    $psi.Arguments = $Arguments
    $psi.WorkingDirectory = $NginxDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; return @{ Code = -1; Text = 'nginx.exe did not finish within 60 seconds' } }
    $text = ($out + ' ' + $errTask.Result) -replace '\s+', ' '
    return @{ Code = $p.ExitCode; Text = $text.Trim() }
}

function Get-NginxStartTime {
    $exe = Join-Path $NginxDir 'nginx.exe'
    $procs = @(Get-Process -Name nginx -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path -eq $exe })
    if ($procs.Count -eq 0) { return $null }
    # The master process is the oldest one; workers are replaced on every reload.
    return (@($procs | Sort-Object StartTime)[0].StartTime).ToUniversalTime()
}

function Read-ReloadState {
    if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
    try { return (ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($StateFile))) } catch { return $null }
}

function Save-ReloadState([datetime]$WhenUtc) {
    $dir = Split-Path -Parent $StateFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $json = ConvertTo-Json -InputObject ([ordered]@{ lastReloadAt = $WhenUtc.ToString('yyyy-MM-ddTHH:mm:ssZ') })
    [System.IO.File]::WriteAllText($StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-ReloadCheck {
    $ssl = Join-Path $NginxDir 'ssl'
    if (-not (Test-Path -LiteralPath (Join-Path $NginxDir 'nginx.exe'))) { Write-ReloadLog "nginx.exe not found in $NginxDir" 'ERROR'; return 2 }
    $started = Get-NginxStartTime
    if ($null -eq $started) { Write-ReloadLog 'Nginx is not running; nothing reloaded (this script never starts it).' 'WARN'; return 1 }

    $since = $started
    $state = Read-ReloadState
    if ($null -ne $state -and $state.lastReloadAt) {
        $t = [datetime]::MinValue
        $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
        if ([datetime]::TryParse([string]$state.lastReloadAt, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$t) -and $t -gt $since) { $since = $t }
    }

    $newer = @(Get-ChildItem -LiteralPath $ssl -Filter '*.pem' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt $since } | Sort-Object LastWriteTimeUtc)
    if ($newer.Count -eq 0) {
        Write-ReloadLog ('No certificate changed since {0:yyyy-MM-dd HH:mm}; nothing to do.' -f $since.ToLocalTime())
        return 0
    }
    $names = @($newer | ForEach-Object { $_.Name -replace '-(chain|chain-only|crt|key)\.pem$', '' } | Select-Object -Unique)
    Write-ReloadLog ('Renewed certificate(s) found: {0}' -f ($names -join ', '))

    $test = Invoke-Nginx '-t'
    if ($test.Code -ne 0) {
        Write-ReloadLog ('nginx -t failed, so Nginx was NOT reloaded and keeps running as before. Fix nginx.conf, then run this again. nginx said: {0}' -f $test.Text) 'ERROR'
        return 2
    }
    $reload = Invoke-Nginx '-s reload'
    if ($reload.Code -ne 0) {
        Write-ReloadLog ('nginx -s reload failed: {0}' -f $reload.Text) 'ERROR'
        return 2
    }
    Save-ReloadState ([datetime]::UtcNow)
    Write-ReloadLog ('Nginx reloaded; it now serves the renewed certificate(s): {0}' -f ($names -join ', '))
    return 0
}

if ($Install) {
    $self = $MyInvocation.MyCommand.Path
    $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $self + '"'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory (Split-Path -Parent $self)
    $triggers = @((New-ScheduledTaskTrigger -Daily -At '10:30'), (New-ScheduledTaskTrigger -Daily -At '22:30'))
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $desc = 'After win-acme renews a certificate: nginx -t, and only if that passes, nginx -s reload. Log: C:\Apps\db-backup\logs\nginx-reload.log'
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Write-Host "Task '$TaskName' already exists; replacing its settings."
    }
    Register-ScheduledTask -TaskName $TaskName -Description $desc -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Task '$TaskName' created: every day at 10:30 and 22:30, as SYSTEM."
    exit 0
}

if ($Status) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "Task '$TaskName' is not installed." }
    else {
        $i = $t | Get-ScheduledTaskInfo
        Write-Host ('Task      : {0}  state={1}' -f $TaskName, $t.State)
        Write-Host ('Last run  : {0}  result=0x{1:X}' -f $i.LastRunTime, $i.LastTaskResult)
        Write-Host ('Next run  : {0}' -f $i.NextRunTime)
    }
    if (Test-Path -LiteralPath $LogFile) { Write-Host ''; Get-Content -LiteralPath $LogFile -Tail 10 | ForEach-Object { Write-Host ('  ' + $_) } }
    exit 0
}

exit (Invoke-ReloadCheck)
