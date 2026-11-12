# panel-agent.ps1 - Backup panel agent. Windows PowerShell 5.1, ASCII only.
#
# Runs every minute from the "Backup Panel Agent" scheduled task. Each run it:
#   1. Reads backup status on THIS server: status\*.json, log tails, the six
#      backup/check scheduled tasks, disk free space and (every few hours) the
#      Backblaze bucket size.
#   2. Blanks anything that looks like a password, key or token, then POSTs the
#      summary to the panel app on this machine (http://127.0.0.1:7480). The
#      panel app cannot start anything itself; only this agent can.
#   3. Only if CommandsEnabled = $true in panel-agent.config.psd1: it may START
#      one of the six scheduled tasks in $AllowedActions below. Nothing else:
#      no free-form commands, no restores, no deletes.
#
# Usage (on the server, in C:\Apps\db-backup):
#   .\panel-agent.ps1 -DryRun      collect and print the report; send nothing, run nothing
#   .\panel-agent.ps1 -Discover    print what the agent can see (to adjust the config)
#   .\panel-agent.ps1 -Verbose     one normal run, showing each step

[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [switch]$DryRun,
    [switch]$Discover
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0.0'

# ---------------------------------------------------------------------------
# Fixed allowlist. The panel can only name one of these ids; anything else is
# refused. Checked case-sensitively. Keep this list in the script (not in the
# config file) so nothing outside this file can add to it.
# ---------------------------------------------------------------------------
$AllowedActions = @(
    @{ Id = 'run-pg-backup';    Task = 'Postgres Nightly Backup' },
    @{ Id = 'run-pg-check';     Task = 'Postgres Backup Check' },
    @{ Id = 'run-mongo-backup'; Task = 'MongoDB Nightly Backup' },
    @{ Id = 'run-mongo-check';  Task = 'MongoDB Backup Check' },
    @{ Id = 'run-files-backup'; Task = 'Files Nightly Backup' },
    @{ Id = 'run-files-check';  Task = 'Files Backup Check' }
)
$AllowedActionIds = @($AllowedActions | ForEach-Object { $_.Id })
# A command older than this (seconds, as measured by the panel) is refused.
$MaxCommandAgeSeconds = 900

# The three backup jobs shown on the panel. StatusPatterns, LogFile and
# MaxAgeHours can be changed per job in the config file (Jobs = @{ ... }).
$JobDefs = @(
    @{ Id = 'pg';    Label = 'Postgres';       BackupAction = 'run-pg-backup';    CheckAction = 'run-pg-check';    StatusPatterns = @('pg-*', 'postgres*'); LogFile = 'pg-backup.log';    MaxAgeHours = 26 },
    @{ Id = 'mongo'; Label = 'MongoDB';        BackupAction = 'run-mongo-backup'; CheckAction = 'run-mongo-check'; StatusPatterns = @('mongo*');            LogFile = 'mongo-backup.log'; MaxAgeHours = 26 },
    @{ Id = 'files'; Label = 'Files and logs'; BackupAction = 'run-files-backup'; CheckAction = 'run-files-check'; StatusPatterns = @('files-*', 'restic*'); LogFile = 'files-backup.log'; MaxAgeHours = 26 }
)

# Hooks so the tests can replace the real scheduled-task calls.
$GetTaskHook     = { param([string]$Name) @(Get-ScheduledTask -TaskName $Name -ErrorAction Stop) }
$GetTaskInfoHook = { param($Task) $Task | Get-ScheduledTaskInfo -ErrorAction Stop }
$StartTaskHook   = { param($Task) $Task | Start-ScheduledTask -ErrorAction Stop }

$Cfg = $null
$StateDir = $null
$AgentLogPath = Join-Path $PSScriptRoot 'logs\panel-agent.log'
$LogToFile = -not ($DryRun -or $Discover)
$CollectErrors = New-Object System.Collections.ArrayList
$AgentToken = $null
$ExitCode = 0

$ProblemPattern = '(?i)\b(error|errors|failed|failure|fail|fatal|exception|warning|warn|cannot|unable|denied|timed out|timeout)\b'
$NotProblemPattern = '(?i)\b(0|no|zero) (errors?|warnings?|failures?)\b'
$SensitiveKeyPattern = '(?i)(password|passwd|passphrase|pwd|secret|token|api.?key|access.?key|private.?key|credential|authorization|cookie|connection.?string|conn.?str|^key$|^pass$)'

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
function Get-UtcNow { return [DateTime]::UtcNow }

function ConvertTo-IsoTime($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return $Value }
    if ($Value -isnot [datetime]) { return $null }
    if ($Value.Year -lt 2001) { return $null }   # "never run" shows up as 1999 or 0001
    return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

function ConvertFrom-IsoTime([string]$Text) {
    if (-not $Text) { return $null }
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $d = [datetime]::MinValue
    if ([datetime]::TryParse($Text, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$d)) { return $d }
    return $null
}

# Blank anything that looks like a secret inside free text (log lines, JSON strings).
function Protect-Text([string]$Text, [int]$MaxLength = 2000) {
    if ($null -eq $Text) { return $null }
    $s = $Text
    # scheme://user:password@host
    $s = [regex]::Replace($s, '(?i)([a-z][a-z0-9+.-]*://[^/\s:@]*:)[^@\s/]+@', '$1***@')
    # Authorization: Bearer xxx / Basic xxx
    $s = [regex]::Replace($s, '(?i)\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}', '$1 ***')
    # password=xxx, api_key: "xxx", RESTIC_PASSWORD=xxx, AWS_SECRET_ACCESS_KEY=xxx
    $s = [regex]::Replace($s, '(?i)([a-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[a-z0-9_.-]*["'']?)(\s*[:=]\s*)("[^"]*"|''[^'']*''|[^\s,;]+)', '$1$2***')
    # --password xxx, -p:xxx style switches
    $s = [regex]::Replace($s, '(?i)(\s-{1,2}(?:password|passwd|pwd|secret|token|api-?key)[a-z0-9_-]*)(\s+)("[^"]*"|''[^'']*''|\S+)', '$1$2***')
    # long random-looking strings with upper case, lower case and digits (keys)
    $s = [regex]::Replace($s, '(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[0-9])[A-Za-z0-9+/_=-]{28,}(?![A-Za-z0-9+/_=-])', '***')
    if ($s.Length -gt $MaxLength) { $s = $s.Substring(0, $MaxLength) + ' ...(cut)' }
    return $s
}

# Copy a parsed JSON value, hiding secret-looking keys and blanking secret-looking text.
function ConvertTo-SafeValue($Value, [int]$Depth = 0) {
    if ($null -eq $Value) { return $null }
    if ($Depth -gt 8) { return '(nested too deep)' }
    if ($Value -is [string]) { return (Protect-Text $Value 2000) }
    if ($Value -is [datetime]) { return (ConvertTo-IsoTime $Value) }
    if ($Value -is [bool]) { return $Value }
    if ($Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IDictionary]) {
        $o = [ordered]@{}
        foreach ($k in @($Value.Keys)) {
            $name = [string]$k
            if ($name -match $SensitiveKeyPattern) { $o[$name] = '(hidden)' }
            else { $o[$name] = ConvertTo-SafeValue $Value[$k] ($Depth + 1) }
        }
        return $o
    }
    if ($Value.GetType().FullName -eq 'System.Management.Automation.PSCustomObject') {
        $o = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) {
            $name = [string]$p.Name
            if ($name -match $SensitiveKeyPattern) { $o[$name] = '(hidden)' }
            else { $o[$name] = ConvertTo-SafeValue $p.Value ($Depth + 1) }
        }
        return $o
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $list = @()
        $n = 0
        foreach ($x in $Value) {
            if ($n -ge 200) { break }
            $list += , (ConvertTo-SafeValue $x ($Depth + 1))
            $n++
        }
        return , $list
    }
    return (Protect-Text ([string]$Value) 2000)
}

function Add-CollectError([string]$Message) {
    [void]$CollectErrors.Add((Protect-Text $Message 500))
    Write-AgentLog $Message 'WARN'
}

function Write-AgentLog([string]$Message, [string]$Level = 'INFO') {
    Write-Verbose ('[{0}] {1}' -f $Level, $Message)
    if (-not $LogToFile) { return }
    try {
        $dir = Split-Path -Parent $AgentLogPath
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        if ((Test-Path -LiteralPath $AgentLogPath) -and ((Get-Item -LiteralPath $AgentLogPath).Length -gt 1MB)) {
            Move-Item -LiteralPath $AgentLogPath -Destination ($AgentLogPath + '.1') -Force
        }
        $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, (Protect-Text $Message 1000)
        Add-Content -LiteralPath $AgentLogPath -Value $line -Encoding ASCII
    } catch { }
}

function Resolve-AgentPath([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-Path $Cfg.BaseDir $Path)
}

# Read a whole text file even while another process is writing to it.
function Read-TextShared([string]$Path) {
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
    try {
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
        try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

# Return the last lines of a text file, reading at most $MaxBytes from its end.
# Handles UTF-8/ANSI and UTF-16 (Out-File default in PowerShell 5.1).
function Read-FileTail([string]$Path, [int]$MaxBytes = 262144) {
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]'ReadWrite, Delete')
    try {
        $len = $fs.Length
        if ($len -eq 0) { return }
        $bom = New-Object byte[] 2
        $n = $fs.Read($bom, 0, 2)
        $enc = [System.Text.Encoding]::UTF8
        $unit = 1
        if ($n -eq 2 -and $bom[0] -eq 0xFF -and $bom[1] -eq 0xFE) { $enc = [System.Text.Encoding]::Unicode; $unit = 2 }
        elseif ($n -eq 2 -and $bom[0] -eq 0xFE -and $bom[1] -eq 0xFF) { $enc = [System.Text.Encoding]::BigEndianUnicode; $unit = 2 }
        $start = [Math]::Max([int64]0, $len - $MaxBytes)
        if ($unit -eq 2 -and ($start % 2) -ne 0) { $start++ }
        [void]$fs.Seek($start, [System.IO.SeekOrigin]::Begin)
        $count = [int]($len - $start)
        $buf = New-Object byte[] $count
        $read = 0
        while ($read -lt $count) {
            $r = $fs.Read($buf, $read, $count - $read)
            if ($r -le 0) { break }
            $read += $r
        }
    } finally { $fs.Dispose() }
    $text = $enc.GetString($buf, 0, $read).TrimStart([char]0xFEFF)
    $lines = @($text -split "`r?`n")
    if ($start -gt 0 -and $lines.Count -gt 1) { $lines = @($lines[1..($lines.Count - 1)]) }   # first line may be cut
    foreach ($l in $lines) { if ($l.Trim() -ne '') { $l } }
}

function Read-SecretCredential([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $c = Import-Clixml -LiteralPath $Path
    if ($c -is [System.Management.Automation.PSCredential]) { return $c }
    throw "Secret file does not hold a saved credential: $Path"
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (ConvertFrom-Json -InputObject (Read-TextShared $Path)) } catch { return $null }
}

function Write-JsonFile([string]$Path, $Object) {
    $json = ConvertTo-Json -InputObject $Object -Depth 10
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
function Get-AgentConfig([string]$Path) {
    if (-not $Path) { $Path = Join-Path $PSScriptRoot 'panel-agent.config.psd1' }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Config file not found: $Path" }
    $raw = Import-PowerShellDataFile -LiteralPath $Path
    $c = [ordered]@{
        ConfigPath      = $Path
        PanelUrl        = 'http://127.0.0.1:7480'
        BaseDir         = 'C:\Apps\db-backup'
        CommandsEnabled = $false
        DisabledActions = @()
        TokenFile       = 'secrets\panel-agent-token.clixml'
        TokenHashFile   = 'secrets\panel-agent-token.sha256'
        StatusDir       = 'status'
        LogDir          = 'logs'
        StateDir        = 'panel-agent-state'
        LogTailLines    = 40
        LogScanKB       = 256
        MaxProblemLines = 15
        DiskWarnFreeGB  = 60
        TimeoutSec      = 30
        Jobs            = @{}
        Backblaze       = @{}
    }
    foreach ($k in @($raw.Keys)) {
        if (-not $c.Contains($k) -or $k -eq 'ConfigPath') { throw "Unknown setting '$k' in $Path (check the spelling)" }
        $c[$k] = $raw[$k]
    }
    $bb = [ordered]@{
        Enabled         = $false
        KeyFile         = 'secrets\panel-b2-readonly.clixml'
        Bucket          = 'windows-vps-vault'
        Prefixes        = @('restic-logs/', 'restic-files/')
        EveryHours      = 12
        PricePerTBMonth = 6.95
        FreeGB          = 10
    }
    foreach ($k in @($c.Backblaze.Keys)) {
        if (-not $bb.Contains($k)) { throw "Unknown Backblaze setting '$k' in $Path" }
        $bb[$k] = $c.Backblaze[$k]
    }
    $c.Backblaze = $bb
    foreach ($jobId in @($c.Jobs.Keys)) {
        $known = $false
        foreach ($j in $JobDefs) { if ($j.Id -eq $jobId) { $known = $true } }
        if (-not $known) { throw "Unknown job '$jobId' in Jobs (use pg, mongo or files)" }
        foreach ($k in @($c.Jobs[$jobId].Keys)) {
            if (@('StatusPatterns', 'LogFile', 'MaxAgeHours') -notcontains $k) { throw "Unknown setting '$k' for job '$jobId'" }
        }
    }
    $url = [string]$c.PanelUrl
    # The panel app runs on this server; the agent talks to it directly, never through Nginx.
    if ($url -notmatch '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$') {
        throw "PanelUrl must be the panel app on this server, like http://127.0.0.1:7480 (got '$url')"
    }
    $c.PanelUrl = $url.TrimEnd('/')
    if ($c.CommandsEnabled -isnot [bool]) { throw 'CommandsEnabled must be $true or $false' }
    $c.DisabledActions = @($c.DisabledActions)
    foreach ($a in $c.DisabledActions) {
        if ($AllowedActionIds -cnotcontains $a) { throw "DisabledActions contains an unknown action '$a'" }
    }
    return $c
}

function Get-JobSetting($Job, [string]$Name) {
    if ($Cfg -and $Cfg.Jobs.Contains($Job.Id) -and $Cfg.Jobs[$Job.Id].Contains($Name)) { return $Cfg.Jobs[$Job.Id][$Name] }
    return $Job[$Name]
}

# ---------------------------------------------------------------------------
# Allowlist logic
# ---------------------------------------------------------------------------
function Get-AllowedTaskName([string]$Action) {
    foreach ($a in $AllowedActions) {
        if ($a.Id -ceq $Action) { return $a.Task }
    }
    return $null
}

# Decide whether a command from the panel may run. Returns Ok, Reason, CanReply.
function Test-CommandAllowed($Command, [string[]]$DoneIds) {
    $res = @{ Ok = $false; Reason = ''; CanReply = $false }
    if ($null -eq $Command) { $res.Reason = 'empty command'; return $res }
    $id = [string]$Command.id
    $action = [string]$Command.action
    if ($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { $res.Reason = 'malformed command id'; return $res }
    $res.CanReply = $true
    if (@($DoneIds) -ccontains $id) { $res.CanReply = $false; $res.Reason = 'command id already handled'; return $res }
    if (-not $Cfg.CommandsEnabled) { $res.Reason = 'Run-now buttons are switched off on the server (CommandsEnabled = $false)'; return $res }
    if ($action -cnotmatch '^[a-z-]{3,40}$' -or $null -eq (Get-AllowedTaskName $action)) { $res.Reason = 'action is not on the allowlist'; return $res }
    if (@($Cfg.DisabledActions) -ccontains $action) { $res.Reason = 'action is disabled in the server config (DisabledActions)'; return $res }
    $age = $null
    try { $age = [double]$Command.ageSeconds } catch { $age = $null }
    if ($null -eq $Command.ageSeconds -or $null -eq $age) { $res.Reason = 'command has no age'; return $res }
    if ($age -gt $MaxCommandAgeSeconds -or $age -lt -60) { $res.Reason = ('command is too old ({0:N0} s)' -f $age); return $res }
    $res.Ok = $true
    return $res
}

# Start the scheduled task behind an allowlisted action. Never throws.
function Invoke-AllowedCommand([string]$Action) {
    $taskName = Get-AllowedTaskName $Action
    if ($null -eq $taskName) { return @{ Status = 'rejected'; Message = 'action is not on the allowlist' } }
    try { $tasks = @(& $GetTaskHook $taskName) } catch { return @{ Status = 'failed'; Message = "Scheduled task '$taskName' was not found" } }
    if ($tasks.Count -eq 0) { return @{ Status = 'failed'; Message = "Scheduled task '$taskName' was not found" } }
    $task = $tasks[0]
    $state = [string]$task.State
    if ($state -eq 'Running') { return @{ Status = 'rejected'; Message = "'$taskName' is already running" } }
    if ($state -eq 'Disabled') { return @{ Status = 'rejected'; Message = "'$taskName' is disabled in Task Scheduler" } }
    try {
        & $StartTaskHook $task | Out-Null
        return @{ Status = 'started'; Message = "Started scheduled task '$taskName'" }
    } catch {
        return @{ Status = 'failed'; Message = ("Could not start '{0}': {1}" -f $taskName, (Protect-Text $_.Exception.Message 300)) }
    }
}

function Get-DoneCommandIds {
    $parsed = Read-JsonFile (Join-Path $StateDir 'done-commands.json')
    if ($null -ne $parsed) { foreach ($x in $parsed) { [string]$x } }
}

function Add-DoneCommandId([string]$Id) {
    $ids = @(Get-DoneCommandIds) + @($Id)
    if ($ids.Count -gt 200) { $ids = @($ids[($ids.Count - 200)..($ids.Count - 1)]) }
    Write-JsonFile (Join-Path $StateDir 'done-commands.json') @($ids)
}

# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------
function Get-TaskSummary([string]$TaskName) {
    $r = [ordered]@{ name = $TaskName; found = $false; path = $null; state = $null; lastRunAt = $null; lastResult = $null; nextRunAt = $null; missedRuns = $null; error = $null }
    $tasks = @()
    try { $tasks = @(& $GetTaskHook $TaskName) }
    catch {
        if ($_.Exception.Message -notmatch 'No MSFT_ScheduledTask') { $r.error = Protect-Text $_.Exception.Message 300 }
        return $r
    }
    if ($tasks.Count -eq 0) { return $r }
    $t = $tasks[0]
    $r.found = $true
    $r.path = [string]$t.TaskPath
    $r.state = [string]$t.State
    try {
        $i = & $GetTaskInfoHook $t
        $r.lastRunAt = ConvertTo-IsoTime $i.LastRunTime
        $r.lastResult = [int64]$i.LastTaskResult
        $r.nextRunAt = ConvertTo-IsoTime $i.NextRunTime
        $r.missedRuns = [int]$i.NumberOfMissedRuns
    } catch { $r.error = Protect-Text $_.Exception.Message 300 }
    return $r
}

function Get-JobIdForStatusFile([string]$Name) {
    foreach ($j in $JobDefs) {
        foreach ($p in @(Get-JobSetting $j 'StatusPatterns')) { if ($Name -like $p) { return $j.Id } }
    }
    return $null
}

function Get-StatusFileSummaries {
    $dir = Resolve-AgentPath $Cfg.StatusDir
    if (-not (Test-Path -LiteralPath $dir)) { Add-CollectError "Status folder not found: $dir"; return }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 60)
    foreach ($f in $files) {
        $item = [ordered]@{ name = $f.Name; job = (Get-JobIdForStatusFile $f.Name); modifiedAt = (ConvertTo-IsoTime $f.LastWriteTime); sizeBytes = [int64]$f.Length; content = $null; error = $null }
        if ($f.Length -gt 262144) { $item.error = 'File is larger than 256 KB; content not sent.' }
        else {
            try { $item.content = ConvertTo-SafeValue (ConvertFrom-Json -InputObject (Read-TextShared $f.FullName)) 0 }
            catch { $item.error = 'Could not read JSON: ' + (Protect-Text $_.Exception.Message 300) }
        }
        $item
    }
}

function Get-LogSummaries {
    $logDir = Resolve-AgentPath $Cfg.LogDir
    $names = @()
    foreach ($j in $JobDefs) { $names += [string](Get-JobSetting $j 'LogFile') }
    $names += 'panel-agent.log'
    foreach ($n in $names) {
        $path = Join-Path $logDir $n
        $jobId = $null
        foreach ($j in $JobDefs) { if ((Get-JobSetting $j 'LogFile') -eq $n) { $jobId = $j.Id } }
        $item = [ordered]@{ name = $n; job = $jobId; found = $false; modifiedAt = $null; sizeBytes = $null; tail = @(); problems = @(); error = $null }
        if (Test-Path -LiteralPath $path) {
            $fi = Get-Item -LiteralPath $path
            $item.found = $true
            $item.modifiedAt = ConvertTo-IsoTime $fi.LastWriteTime
            $item.sizeBytes = [int64]$fi.Length
            try {
                $lines = @(Read-FileTail $path ([int]$Cfg.LogScanKB * 1024))
                $item.tail = @($lines | Select-Object -Last ([int]$Cfg.LogTailLines) | ForEach-Object { Protect-Text $_ 500 })
                $item.problems = @($lines | Where-Object { $_ -match $ProblemPattern -and $_ -notmatch $NotProblemPattern } | Select-Object -Last ([int]$Cfg.MaxProblemLines) | ForEach-Object { Protect-Text $_ 500 })
            } catch { $item.error = Protect-Text $_.Exception.Message 300 }
        }
        $item
    }
}

function Get-JobSummaries($StatusFiles) {
    foreach ($j in $JobDefs) {
        $success = $null
        $failure = $null
        $mine = @()
        foreach ($s in @($StatusFiles)) {
            if ($s.job -ne $j.Id) { continue }
            $mine += $s.name
            if ($s.name -match '(?i)(success|succeeded|last-ok|good)' -and ($null -eq $success -or $s.modifiedAt -gt $success)) { $success = $s.modifiedAt }
            if ($s.name -match '(?i)(fail|error)' -and ($null -eq $failure -or $s.modifiedAt -gt $failure)) { $failure = $s.modifiedAt }
        }
        [ordered]@{
            id            = $j.Id
            label         = $j.Label
            maxAgeHours   = [double](Get-JobSetting $j 'MaxAgeHours')
            logFile       = [string](Get-JobSetting $j 'LogFile')
            statusFiles   = @($mine)
            lastSuccessAt = $success
            lastFailureAt = $failure
            backup        = [ordered]@{ action = $j.BackupAction; task = (Get-TaskSummary (Get-AllowedTaskName $j.BackupAction)) }
            check         = [ordered]@{ action = $j.CheckAction; task = (Get-TaskSummary (Get-AllowedTaskName $j.CheckAction)) }
        }
    }
}

function Get-DiskSummaries {
    foreach ($d in @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3')) {
        [ordered]@{ name = [string]$d.DeviceID; label = [string]$d.VolumeName; sizeBytes = [int64]$d.Size; freeBytes = [int64]$d.FreeSpace }
    }
}

function Invoke-B2Post($Auth, [string]$Operation, $Body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Compress))
    return Invoke-RestMethod -Uri ([string]$Auth.apiUrl + '/b2api/v2/' + $Operation) -Method Post -Headers @{ Authorization = [string]$Auth.authorizationToken } -Body $bytes -ContentType 'application/json' -TimeoutSec 60 -UseBasicParsing
}

# Sum the size of all files under each prefix with a READ-ONLY key (never the restic password).
function Invoke-BackblazeListing($B) {
    $cred = Read-SecretCredential (Resolve-AgentPath $B.KeyFile)
    if ($null -eq $cred) { throw 'Backblaze key file not found. Run panel-agent-setup.ps1 -SetBackblazeKey' }
    $pair = $cred.UserName + ':' + $cred.GetNetworkCredential().Password
    $basic = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($pair))
    $auth = Invoke-RestMethod -Uri 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account' -Method Get -Headers @{ Authorization = 'Basic ' + $basic } -TimeoutSec 30 -UseBasicParsing
    $bucketId = $null
    if ($auth.allowed -and $auth.allowed.bucketId) {
        if ($auth.allowed.bucketName -and [string]$auth.allowed.bucketName -ne [string]$B.Bucket) { throw ("The Backblaze key is limited to bucket '{0}', not '{1}'" -f $auth.allowed.bucketName, $B.Bucket) }
        $bucketId = [string]$auth.allowed.bucketId
    } else {
        $lb = Invoke-B2Post $auth 'b2_list_buckets' @{ accountId = [string]$auth.accountId; bucketName = [string]$B.Bucket }
        foreach ($x in @($lb.buckets)) { if ($null -ne $x -and [string]$x.bucketName -eq [string]$B.Bucket) { $bucketId = [string]$x.bucketId } }
    }
    if (-not $bucketId) { throw ("Bucket '{0}' not found with this key" -f $B.Bucket) }
    $prefixes = @()
    $grand = [int64]0
    foreach ($prefix in @($B.Prefixes)) {
        $total = [int64]0
        $count = 0
        $next = $null
        $pages = 0
        do {
            $body = @{ bucketId = $bucketId; prefix = [string]$prefix; maxFileCount = 1000 }
            if ($next) { $body.startFileName = $next }
            $resp = Invoke-B2Post $auth 'b2_list_file_names' $body
            foreach ($f in @($resp.files)) {
                if ($null -ne $f -and [string]$f.action -eq 'upload') { $total += [int64]$f.contentLength; $count++ }
            }
            $next = $resp.nextFileName
            $pages++
        } while ($next -and $pages -lt 500)
        $grand += $total
        $prefixes += , ([ordered]@{ prefix = [string]$prefix; bytes = $total; files = $count; complete = (-not $next) })
    }
    return [ordered]@{ bucket = [string]$B.Bucket; prefixes = $prefixes; totalBytes = $grand }
}

function Get-BackblazeSummary {
    $b = $Cfg.Backblaze
    if (-not $b.Enabled) { return [ordered]@{ enabled = $false } }
    $cachePath = Join-Path $StateDir 'backblaze.json'
    $cache = Read-JsonFile $cachePath
    $now = Get-UtcNow
    $due = $true
    if ($null -ne $cache) {
        $checked = ConvertFrom-IsoTime ([string]$cache.checkedAt)
        $attempt = ConvertFrom-IsoTime ([string]$cache.lastAttemptAt)
        if ($null -ne $checked -and ($now - $checked).TotalHours -lt [double]$b.EveryHours) { $due = $false }
        if ($null -ne $attempt -and ($now - $attempt).TotalMinutes -lt 60) { $due = $false }   # wait an hour after a failure
    }
    if ($due -and -not $DryRun) {
        $nowIso = ConvertTo-IsoTime $now
        try {
            $r = Invoke-BackblazeListing $b
            $cache = [ordered]@{ checkedAt = $nowIso; lastAttemptAt = $null; lastError = $null; bucket = $r.bucket; prefixes = $r.prefixes; totalBytes = $r.totalBytes }
            Write-AgentLog ('Backblaze size check ok: {0:N1} GB' -f ($r.totalBytes / 1e9))
        } catch {
            $msg = Protect-Text $_.Exception.Message 300
            Add-CollectError "Backblaze size check failed: $msg"
            $old = ConvertTo-SafeValue $cache 0
            if ($null -eq $old) { $old = [ordered]@{ checkedAt = $null; bucket = [string]$b.Bucket; prefixes = @(); totalBytes = $null } }
            $old['lastAttemptAt'] = $nowIso
            $old['lastError'] = $msg
            $cache = $old
        }
        try { Write-JsonFile $cachePath $cache } catch { Add-CollectError ('Could not save Backblaze cache: ' + $_.Exception.Message) }
    }
    $out = ConvertTo-SafeValue $cache 0
    if ($null -eq $out) { $out = [ordered]@{ checkedAt = $null; bucket = [string]$b.Bucket; prefixes = @(); totalBytes = $null } }
    $out['enabled'] = $true
    $out['everyHours'] = [double]$b.EveryHours
    $out['pricePerTBMonth'] = [double]$b.PricePerTBMonth
    $out['freeGB'] = [double]$b.FreeGB
    return $out
}

function New-AgentReport {
    $statusFiles = @()
    try { $statusFiles = @(Get-StatusFileSummaries) } catch { Add-CollectError ('Status files: ' + $_.Exception.Message) }
    $jobs = @()
    try { $jobs = @(Get-JobSummaries $statusFiles) } catch { Add-CollectError ('Scheduled tasks: ' + $_.Exception.Message) }
    $logs = @()
    try { $logs = @(Get-LogSummaries) } catch { Add-CollectError ('Logs: ' + $_.Exception.Message) }
    $disks = @()
    try { $disks = @(Get-DiskSummaries) } catch { Add-CollectError ('Disks: ' + $_.Exception.Message) }
    $backblaze = $null
    try { $backblaze = Get-BackblazeSummary } catch { Add-CollectError ('Backblaze: ' + $_.Exception.Message) }

    $previous = Read-JsonFile (Join-Path $StateDir 'last-run.json')
    $recent = @()
    if ($null -ne $previous -and $null -ne $previous.recentErrors) {
        $tmp = ConvertTo-SafeValue $previous.recentErrors 0   # never wrap this call in @(): it returns ,$list
        if ($null -ne $tmp) { $recent = @($tmp) }
    }

    $enabledActions = @()
    if ($Cfg.CommandsEnabled) { foreach ($a in $AllowedActionIds) { if (@($Cfg.DisabledActions) -cnotcontains $a) { $enabledActions += $a } } }

    return [ordered]@{
        schema           = 1
        agentVersion     = $AgentVersion
        host             = [string]$env:COMPUTERNAME
        generatedAt      = (ConvertTo-IsoTime (Get-UtcNow))
        utcOffsetMinutes = [int][TimeZoneInfo]::Local.GetUtcOffset((Get-Date)).TotalMinutes
        agent            = [ordered]@{
            commandsEnabled = [bool]$Cfg.CommandsEnabled
            enabledActions  = @($enabledActions)
            psVersion       = [string]$PSVersionTable.PSVersion
            recentErrors    = @($recent)
            collectErrors   = @($CollectErrors)
        }
        diskWarnFreeGB   = [double]$Cfg.DiskWarnFreeGB
        jobs             = @($jobs)
        statusFiles      = @($statusFiles)
        logs             = @($logs)
        disks            = @($disks)
        backblaze        = $backblaze
    }
}

# ---------------------------------------------------------------------------
# Talking to the panel (outbound HTTPS only)
# ---------------------------------------------------------------------------
# Uses HttpWebRequest (not Invoke-RestMethod) so redirects are never followed and
# every status code can be explained; PowerShell 5.1 hides both otherwise.
function Invoke-PanelRequest([string]$Path, $Body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 12 -Compress))
    $req = [System.Net.HttpWebRequest]::Create($Cfg.PanelUrl + $Path)
    $req.Method = 'POST'
    $req.AllowAutoRedirect = $false
    $req.Timeout = [int]$Cfg.TimeoutSec * 1000
    $req.ReadWriteTimeout = [int]$Cfg.TimeoutSec * 1000
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Accept = 'application/json'
    $req.UserAgent = 'backup-panel-agent/' + $AgentVersion
    $req.Proxy = $null   # always straight to this machine, never through a system proxy
    $req.Headers.Add('Authorization', 'Bearer ' + $AgentToken)
    $req.ContentLength = $bytes.Length
    $resp = $null
    try {
        $stream = $req.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
        $resp = $req.GetResponse()
    } catch {
        $ex = $_.Exception
        while ($null -ne $ex -and $ex -isnot [System.Net.WebException]) { $ex = $ex.InnerException }
        if ($null -ne $ex -and $null -ne $ex.Response) { $resp = $ex.Response }
        else { throw ('Panel request {0} failed: could not reach {1}. Is the backup-panel app running (pm2 status)? ({2})' -f $Path, $Cfg.PanelUrl, $_.Exception.Message) }
    }
    $code = [int]$resp.StatusCode
    $text = ''
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $resp.Close() }
    $detail = $text
    if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
    $msg = $null
    if ($code -ge 300 -and $code -lt 400) {
        $msg = ('unexpected redirect ({0}). PanelUrl must point straight at the panel app, like http://127.0.0.1:7480.' -f $code)
    } elseif ($code -eq 401) {
        $msg = 'the panel refused the agent token (401). Run .\panel-agent-setup.ps1 -ShowTokenHash to rewrite the fingerprint file the panel reads.'
    } elseif ($code -eq 403) {
        $msg = 'forbidden (403): the panel only accepts the agent on 127.0.0.1, not through Nginx or a proxy. Check PanelUrl.'
    } elseif ($code -eq 503) {
        $msg = ('the panel is not ready: {0}' -f (Protect-Text $detail 300))
    } elseif ($code -ne 200 -and $code -ne 201) {
        $msg = ('HTTP {0}: {1}' -f $code, (Protect-Text $detail 300))
    }
    if ($null -ne $msg) { throw ('Panel request {0} failed: {1}' -f $Path, $msg) }
    $obj = $null
    try { $obj = ConvertFrom-Json -InputObject $text } catch { $obj = $null }
    if ($null -eq $obj -or $obj -is [string] -or $obj.ok -ne $true) {
        throw ('Panel request {0} returned an unexpected answer (not the panel JSON). Is PanelUrl right?' -f $Path)
    }
    return $obj
}

function Send-CommandResult([string]$Id, [string]$Status, [string]$Message) {
    try { [void](Invoke-PanelRequest ('/api/agent/commands/' + $Id + '/result') ([ordered]@{ status = $Status; message = $Message; at = (ConvertTo-IsoTime (Get-UtcNow)) })) }
    catch { Write-AgentLog ('Could not send result for command {0}: {1}' -f $Id, $_.Exception.Message) 'ERROR' }
}

function Invoke-PanelCommands($Commands) {
    $started = 0
    foreach ($c in @($Commands)) {
        if ($null -eq $c) { continue }
        $done = @(Get-DoneCommandIds)
        $check = Test-CommandAllowed $c $done
        $id = [string]$c.id
        $action = Protect-Text ([string]$c.action) 60
        if (-not $check.Ok) {
            Write-AgentLog ("Refused command {0} '{1}': {2}" -f (Protect-Text $id 40), $action, $check.Reason) 'WARN'
            if ($check.CanReply) { Add-DoneCommandId $id; Send-CommandResult $id 'rejected' $check.Reason }
            continue
        }
        # The panel sends at most 3 per answer; do not rely on that.
        if ($started -ge 3) { Write-AgentLog 'More than 3 commands in one answer; the rest are ignored.' 'WARN'; break }
        $started++
        Add-DoneCommandId $id    # mark first: a command id runs at most once
        $result = Invoke-AllowedCommand ([string]$c.action)
        $lvl = 'INFO'
        if ($result.Status -ne 'started') { $lvl = 'WARN' }
        Write-AgentLog ("Command {0} '{1}' requested by {2}: {3} - {4}" -f $id, $action, (Protect-Text ([string]$c.requestedBy) 80), $result.Status, $result.Message) $lvl
        Send-CommandResult $id $result.Status $result.Message
    }
}

# ---------------------------------------------------------------------------
# Discover: human-readable view of what the agent sees (sends nothing)
# ---------------------------------------------------------------------------
function Show-Discovery {
    Write-Host ''
    Write-Host ('Config file : ' + $Cfg.ConfigPath)
    Write-Host ('Panel URL   : ' + $Cfg.PanelUrl)
    $cmd = 'OFF (read-only)'
    if ($Cfg.CommandsEnabled) { $cmd = 'ON' }
    Write-Host ('Run-now     : ' + $cmd)
    Write-Host ('Base folder : ' + $Cfg.BaseDir + '  exists=' + (Test-Path -LiteralPath $Cfg.BaseDir))
    Write-Host ''
    Write-Host 'Scheduled tasks:'
    foreach ($a in $AllowedActions) {
        $t = Get-TaskSummary $a.Task
        if ($t.found) {
            $res = 'n/a'
            if ($null -ne $t.lastResult) { $res = '0x{0:X}' -f $t.lastResult }
            Write-Host ('  [found]   {0,-26} state={1,-8} last run={2}  result={3}  next={4}' -f $t.name, $t.state, $t.lastRunAt, $res, $t.nextRunAt)
        } else {
            Write-Host ('  [MISSING] {0}  {1}' -f $t.name, $t.error)
        }
    }
    Write-Host ''
    Write-Host ('Status files in ' + (Resolve-AgentPath $Cfg.StatusDir) + ':')
    foreach ($s in @(Get-StatusFileSummaries)) {
        $keys = ''
        if ($s.content -is [System.Collections.IDictionary]) { $keys = (@($s.content.Keys) -join ', ') }
        $job = $s.job
        if (-not $job) { $job = '(no card - add a pattern in Jobs)' }
        Write-Host ('  {0,-34} {1}  card={2}' -f $s.name, $s.modifiedAt, $job)
        if ($keys) { Write-Host ('      keys: ' + $keys) }
        if ($s.error) { Write-Host ('      ' + $s.error) }
    }
    Write-Host ''
    Write-Host ('Logs in ' + (Resolve-AgentPath $Cfg.LogDir) + ':')
    foreach ($l in @(Get-LogSummaries)) {
        Write-Host ('  {0,-22} found={1}  size={2}  problem lines={3}' -f $l.name, $l.found, $l.sizeBytes, @($l.problems).Count)
    }
    Write-Host ''
    Write-Host 'Disks:'
    foreach ($d in @(Get-DiskSummaries)) { Write-Host ('  {0} {1,8:N1} GB free of {2,8:N1} GB' -f $d.name, ($d.freeBytes / 1e9), ($d.sizeBytes / 1e9)) }
    Write-Host ''
    Write-Host 'Secret files (must open for THIS Windows user):'
    foreach ($f in @($Cfg.TokenFile, $Cfg.Backblaze.KeyFile)) {
        $p = Resolve-AgentPath $f
        $state = 'not created'
        if (Test-Path -LiteralPath $p) {
            try { [void](Read-SecretCredential $p); $state = 'ok' } catch { $state = 'present but cannot be opened by ' + $env:USERNAME }
        }
        Write-Host ('  {0,-48} {1}' -f $f, $state)
    }
    $hashState = 'not created'
    if (Test-Path -LiteralPath (Resolve-AgentPath $Cfg.TokenHashFile)) { $hashState = 'ok (the panel reads this)' }
    Write-Host ('  {0,-48} {1}' -f $Cfg.TokenHashFile, $hashState)
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Main. Sets $Script:ExitCode: 0 ok, 1 could not reach the panel, 2 config problem.
# ---------------------------------------------------------------------------
function Invoke-AgentMain {
    $started = Get-UtcNow
    $Script:ExitCode = 0
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try {
        $Script:Cfg = Get-AgentConfig $ConfigPath
    } catch {
        Write-AgentLog ('Config problem: ' + $_.Exception.Message) 'ERROR'
        Write-Host ('Config problem: ' + $_.Exception.Message)
        $Script:ExitCode = 2
        return
    }
    $Script:AgentLogPath = Join-Path (Resolve-AgentPath $Cfg.LogDir) 'panel-agent.log'
    $Script:StateDir = Resolve-AgentPath $Cfg.StateDir
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }

    if ($Discover) { Show-Discovery; return }

    $report = New-AgentReport
    if ($DryRun) {
        ConvertTo-Json -InputObject $report -Depth 12
        return
    }

    $runError = $null
    try {
        $tokenCred = Read-SecretCredential (Resolve-AgentPath $Cfg.TokenFile)
        if ($null -eq $tokenCred) { throw 'Agent token not found. Run panel-agent-setup.ps1 -NewToken' }
        $Script:AgentToken = $tokenCred.GetNetworkCredential().Password
        $resp = Invoke-PanelRequest '/api/agent/report' $report
        if ($resp.commands) {
            if ($Cfg.CommandsEnabled) { Invoke-PanelCommands $resp.commands }
            else {
                foreach ($c in @($resp.commands)) {
                    if ($null -eq $c) { continue }
                    $chk = Test-CommandAllowed $c @(Get-DoneCommandIds)
                    if ($chk.CanReply) { Add-DoneCommandId ([string]$c.id); Send-CommandResult ([string]$c.id) 'rejected' $chk.Reason }
                }
            }
        }
    } catch {
        $runError = Protect-Text $_.Exception.Message 500
        Write-AgentLog $runError 'ERROR'
        Write-Verbose $runError
        $Script:ExitCode = 1
    }

    # Remember how this run went; errors are shown on the panel by the next successful run.
    $prev = Read-JsonFile (Join-Path $StateDir 'last-run.json')
    $recent = @()
    if ($null -ne $prev -and $null -ne $prev.recentErrors -and $null -ne $runError) {
        $tmp = ConvertTo-SafeValue $prev.recentErrors 0
        if ($null -ne $tmp) { $recent = @($tmp) }
    }
    if ($null -ne $runError) { $recent = @($recent) + @([ordered]@{ at = (ConvertTo-IsoTime $started); message = $runError }) }
    if ($recent.Count -gt 10) { $recent = @($recent[($recent.Count - 10)..($recent.Count - 1)]) }
    $heartbeat = $null
    if ($null -ne $prev) { $heartbeat = ConvertFrom-IsoTime ([string]$prev.lastHeartbeatLogAt) }
    $heartbeatIso = $null
    if ($null -ne $heartbeat) { $heartbeatIso = ConvertTo-IsoTime $heartbeat }
    if ($null -eq $runError -and ($null -eq $heartbeat -or ((Get-UtcNow) - $heartbeat).TotalMinutes -ge 60)) {
        Write-AgentLog 'Reports are reaching the panel (hourly heartbeat).'
        $heartbeatIso = ConvertTo-IsoTime (Get-UtcNow)
    }
    $state = [ordered]@{
        at                 = (ConvertTo-IsoTime $started)
        ok                 = ($null -eq $runError)
        durationMs         = [int]((Get-UtcNow) - $started).TotalMilliseconds
        error              = $runError
        recentErrors       = @($recent)
        lastHeartbeatLogAt = $heartbeatIso
    }
    try { Write-JsonFile (Join-Path $StateDir 'last-run.json') $state } catch { }
    if ($null -eq $runError) { Write-Verbose 'Report sent.' }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-AgentMain
    exit $ExitCode
}
