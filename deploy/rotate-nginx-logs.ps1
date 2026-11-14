# rotate-nginx-logs.ps1 - keep Nginx's log files from growing forever.
# Windows PowerShell 5.1, ASCII only.
#
# Nginx on Windows never starts a new log file by itself (access.log had reached
# 10.6 GB). Once a week (scheduled task "Nginx Log Rotation") this script:
#   1. renames every log in C:\nginx-1.30.2\logs that is bigger than -MinSizeMB
#      (access.log -> access-20261116-0530.log),
#   2. runs "nginx -s reopen", so Nginx starts fresh files (no restart, nothing dropped),
#   3. packs each renamed file into a .gz (about 10 to 20 times smaller), reads the
#      .gz back to check it holds every byte, and only then removes the unpacked
#      renamed copy. If anything does not match, both are kept.
# It never touches .gz files or anything outside the logs folder, and never
# deletes old .gz files: delete those yourself when you no longer want them.
# Log: C:\Apps\db-backup\logs\nginx-rotate.log (the backup panel shows it).
#
#   .\rotate-nginx-logs.ps1             rotate now (as Administrator)
#   .\rotate-nginx-logs.ps1 -Install    create the weekly task (Mondays 05:30, as SYSTEM)
#   .\rotate-nginx-logs.ps1 -Status     show the task, the logs folder and the end of the log

[CmdletBinding()]
param(
    [string]$NginxDir = 'C:\nginx-1.30.2',
    [string]$LogFile = 'C:\Apps\db-backup\logs\nginx-rotate.log',
    [int]$MinSizeMB = 50,
    [switch]$Install,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Nginx Log Rotation'
$LogsDir = Join-Path $NginxDir 'logs'

function Write-RotateLog([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding ASCII
    } catch { }
}

function Format-Bytes([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N0} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f ($Bytes / 1KB))
}

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
    return @{ Code = $p.ExitCode; Text = (($out + ' ' + $errTask.Result) -replace '\s+', ' ').Trim() }
}

function Test-NginxRunning {
    $exe = Join-Path $NginxDir 'nginx.exe'
    return (@(Get-Process -Name nginx -ErrorAction SilentlyContinue | Where-Object { -not $_.Path -or $_.Path -eq $exe }).Count -gt 0)
}

# Packs $Source into $Target (.gz). Returns the number of bytes read from $Source.
function Compress-ToGzip([string]$Source, [string]$Target) {
    $in = [System.IO.File]::Open($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
    try {
        $out = [System.IO.File]::Create($Target)
        try {
            $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionMode]::Compress)
            try { $in.CopyTo($gz, 1MB) } finally { $gz.Dispose() }
        } finally { $out.Dispose() }
        return $in.Position
    } finally { $in.Dispose() }
}

# Unpacks $Path to nowhere and returns how many bytes it held.
function Measure-Gzip([string]$Path) {
    $f = [System.IO.File]::OpenRead($Path)
    try {
        $gz = New-Object System.IO.Compression.GZipStream($f, [System.IO.Compression.CompressionMode]::Decompress)
        try {
            $buf = New-Object byte[] 1048576
            $total = [int64]0
            while (($n = $gz.Read($buf, 0, $buf.Length)) -gt 0) { $total += $n }
            return $total
        } finally { $gz.Dispose() }
    } finally { $f.Dispose() }
}

function Invoke-Rotation {
    if (-not (Test-Path -LiteralPath $LogsDir)) { Write-RotateLog "Logs folder not found: $LogsDir" 'ERROR'; return 2 }
    $limit = [int64]$MinSizeMB * 1MB
    $due = @(Get-ChildItem -LiteralPath $LogsDir -Filter '*.log' -File | Where-Object { $_.Length -ge $limit -and $_.Name -notmatch '-\d{8}-\d{4}\.log$' })
    if ($due.Count -eq 0) {
        Write-RotateLog ('Nothing to rotate: every log is under {0} MB.' -f $MinSizeMB)
        return 0
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $moved = @()
    foreach ($f in $due) {
        $newName = '{0}-{1}.log' -f $f.BaseName, $stamp
        try {
            Rename-Item -LiteralPath $f.FullName -NewName $newName
            $moved += Join-Path $LogsDir $newName
            Write-RotateLog ('Renamed {0} ({1}) to {2}' -f $f.Name, (Format-Bytes $f.Length), $newName)
        } catch {
            Write-RotateLog ('Could not rename {0}: {1}' -f $f.Name, $_.Exception.Message) 'ERROR'
        }
    }
    if ($moved.Count -eq 0) { return 2 }

    $code = 0
    if (Test-NginxRunning) {
        $r = Invoke-Nginx '-s reopen'
        if ($r.Code -ne 0) {
            Write-RotateLog ('nginx -s reopen failed, so Nginx keeps writing into the renamed files (nothing is lost). Run "nginx -s reopen" by hand. nginx said: {0}' -f $r.Text) 'ERROR'
            return 2
        }
        Write-RotateLog 'Nginx reopened its logs; new entries go to fresh files.'
        Start-Sleep -Seconds 5   # let the workers switch to the new files
    } else {
        Write-RotateLog 'Nginx is not running; its logs were only renamed.' 'WARN'
    }

    foreach ($path in $moved) {
        $gzPath = $path + '.gz'
        $tmp = $gzPath + '.tmp'
        try {
            $before = (Get-Item -LiteralPath $path).Length
            $read = Compress-ToGzip $path $tmp
            $after = (Get-Item -LiteralPath $path).Length
            $inside = Measure-Gzip $tmp
            if ($read -ne $before -or $after -ne $before -or $inside -ne $before) {
                Remove-Item -LiteralPath $tmp -Force
                Write-RotateLog ('{0} changed while packing, so it was left unpacked; the next run packs it.' -f (Split-Path -Leaf $path)) 'WARN'
                $code = 1
                continue
            }
            Move-Item -LiteralPath $tmp -Destination $gzPath
            Remove-Item -LiteralPath $path -Force
            Write-RotateLog ('Packed {0}: {1} -> {2}' -f (Split-Path -Leaf $gzPath), (Format-Bytes $before), (Format-Bytes (Get-Item -LiteralPath $gzPath).Length))
        } catch {
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            Write-RotateLog ('Could not pack {0}; it stays as it is: {1}' -f (Split-Path -Leaf $path), $_.Exception.Message) 'ERROR'
            $code = 2
        }
    }
    # Earlier renamed files that were left unpacked (e.g. they were still being written).
    foreach ($old in @(Get-ChildItem -LiteralPath $LogsDir -Filter '*.log' -File | Where-Object { $_.Name -match '-\d{8}-\d{4}\.log$' -and $moved -notcontains $_.FullName })) {
        Write-RotateLog ('{0} from an earlier run is still unpacked ({1}); run this again to pack it.' -f $old.Name, (Format-Bytes $old.Length)) 'WARN'
    }
    return $code
}

if ($Install) {
    $self = $MyInvocation.MyCommand.Path
    $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $self + '"'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory (Split-Path -Parent $self)
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '05:30'
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $desc = 'Weekly: renames Nginx logs over 50 MB, nginx -s reopen, packs the old ones to .gz. Log: C:\Apps\db-backup\logs\nginx-rotate.log'
    Register-ScheduledTask -TaskName $TaskName -Description $desc -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Task '$TaskName' created: every Monday at 05:30, as SYSTEM."
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
    Write-Host ''
    Get-ChildItem -LiteralPath $LogsDir -File | Sort-Object Length -Descending | Select-Object -First 12 |
        ForEach-Object { Write-Host ('  {0,-44} {1,10}' -f $_.Name, (Format-Bytes $_.Length)) }
    if (Test-Path -LiteralPath $LogFile) { Write-Host ''; Get-Content -LiteralPath $LogFile -Tail 10 | ForEach-Object { Write-Host ('  ' + $_) } }
    exit 0
}

exit (Invoke-Rotation)
