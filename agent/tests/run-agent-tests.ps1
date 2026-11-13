# run-agent-tests.ps1 - tests for panel-agent.ps1. Windows PowerShell 5.1, ASCII only.
# Safe to run anywhere: uses a temporary folder and fake scheduled-task hooks;
# it never starts, changes or creates a real scheduled task.
#   powershell -NoProfile -ExecutionPolicy Bypass -File agent\tests\run-agent-tests.ps1

$ErrorActionPreference = 'Stop'
$agentPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'panel-agent.ps1'
$script:Pass = 0
$script:Fail = 0

function Assert([bool]$Condition, [string]$Name) {
    if ($Condition) { $script:Pass++; Write-Host ('  ok   ' + $Name) }
    else { $script:Fail++; Write-Host ('  FAIL ' + $Name) -ForegroundColor Red }
}

$tmp = Join-Path $env:TEMP ('panel-agent-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'status') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'logs') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmp 'secrets') | Out-Null

function Write-TestConfig([string]$Path, [string]$Extra) {
    $text = "@{`r`n    PanelUrl = 'http://127.0.0.1:8787'`r`n    BaseDir = '$tmp'`r`n$Extra`r`n}`r`n"
    [System.IO.File]::WriteAllText($Path, $text)
}
$cfgPath = Join-Path $tmp 'test.config.psd1'
Write-TestConfig $cfgPath "    CommandsEnabled = `$true`r`n    DisabledActions = @('run-files-backup')"

try {
    . $agentPath -ConfigPath $cfgPath
    $Cfg = Get-AgentConfig $cfgPath
    $StateDir = Join-Path $tmp 'panel-agent-state'
    New-Item -ItemType Directory -Path $StateDir | Out-Null
    $LogToFile = $true
    $AgentLogPath = Join-Path $tmp 'logs\panel-agent.log'

    # ------------------------------------------------------------------
    Write-Host 'Allowlist: action names'
    Assert ((Get-AllowedTaskName 'run-pg-backup') -eq 'Postgres Nightly Backup') 'run-pg-backup maps to Postgres Nightly Backup'
    Assert ((Get-AllowedTaskName 'run-files-check') -eq 'Files Backup Check') 'run-files-check maps to Files Backup Check'
    Assert ($null -eq (Get-AllowedTaskName 'RUN-PG-BACKUP')) 'upper-case action is refused (case-sensitive)'
    Assert ($null -eq (Get-AllowedTaskName 'run-pg-backup ')) 'action with trailing space is refused'
    Assert ($null -eq (Get-AllowedTaskName 'cmd.exe /c del')) 'free-form command is refused'
    Assert ($null -eq (Get-AllowedTaskName '')) 'empty action is refused'
    Assert ($null -eq (Get-AllowedTaskName 'run-restore')) 'restore is not on the allowlist'
    Assert ($AllowedActionIds.Count -eq 6) 'exactly six allowlisted actions'

    # ------------------------------------------------------------------
    Write-Host 'Allowlist: command checks'
    $goodId = '0f8fad5b-d9cb-469f-a165-70867728950e'
    function New-Cmd($Id, $Action, $Age) {
        $o = [ordered]@{ id = $Id; action = $Action }
        if ($null -ne $Age) { $o.ageSeconds = $Age }
        return (ConvertFrom-Json (ConvertTo-Json $o))
    }
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' 30) @()
    Assert ($r.Ok) 'fresh allowlisted command is accepted'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-files-backup' 30) @()
    Assert (-not $r.Ok -and $r.CanReply -and $r.Reason -match 'DisabledActions') 'action listed in DisabledActions is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-anything' 30) @()
    Assert (-not $r.Ok -and $r.Reason -match 'allowlist') 'unknown action is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'Run-PG-Backup' 30) @()
    Assert (-not $r.Ok) 'mixed-case action is refused'
    $r = Test-CommandAllowed (New-Cmd 'abc; rm -rf' 'run-pg-backup' 30) @()
    Assert (-not $r.Ok -and -not $r.CanReply) 'malformed id is refused without a reply'
    $r = Test-CommandAllowed (New-Cmd $goodId.ToUpper() 'run-pg-backup' 30) @()
    Assert (-not $r.Ok) 'upper-case id is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' 901) @()
    Assert (-not $r.Ok -and $r.Reason -match 'too old') 'command older than 15 minutes is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' -300) @()
    Assert (-not $r.Ok) 'command from the future is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' $null) @()
    Assert (-not $r.Ok -and $r.Reason -match 'no age') 'command without age is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' 'soon') @()
    Assert (-not $r.Ok) 'command with non-numeric age is refused'
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' 30) @($goodId)
    Assert (-not $r.Ok -and -not $r.CanReply) 'command id that already ran is refused'
    $Cfg.CommandsEnabled = $false
    $r = Test-CommandAllowed (New-Cmd $goodId 'run-pg-backup' 30) @()
    Assert (-not $r.Ok -and $r.CanReply -and $r.Reason -match 'switched off') 'everything refused when CommandsEnabled is false'
    $Cfg.CommandsEnabled = $true

    # ------------------------------------------------------------------
    Write-Host 'Allowlist: starting tasks (fake Task Scheduler)'
    $script:FakeTasks = @{}
    $script:Started = New-Object System.Collections.ArrayList
    $GetTaskHook = {
        param([string]$Name)
        if ($script:FakeTasks.ContainsKey($Name)) { return , @($script:FakeTasks[$Name]) }
        throw "No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$Name'."
    }
    $GetTaskInfoHook = { param($Task) [pscustomobject]@{ LastRunTime = (Get-Date).AddHours(-3); LastTaskResult = 0; NextRunTime = (Get-Date).AddHours(20); NumberOfMissedRuns = 0 } }
    $StartTaskHook = { param($Task) if ($Task.FailStart) { throw 'Access is denied.' }; [void]$script:Started.Add($Task.TaskName) }
    function Set-FakeTask([string]$Name, [string]$State, [bool]$FailStart = $false) {
        $script:FakeTasks[$Name] = [pscustomobject]@{ TaskName = $Name; TaskPath = '\'; State = $State; FailStart = $FailStart }
    }
    Set-FakeTask 'Postgres Nightly Backup' 'Ready'
    Set-FakeTask 'MongoDB Nightly Backup' 'Ready'
    Set-FakeTask 'Postgres Backup Check' 'Disabled'
    Set-FakeTask 'MongoDB Backup Check' 'Ready' $true

    $res = Invoke-AllowedCommand 'run-pg-backup'
    Assert ($res.Status -eq 'started' -and $script:Started -contains 'Postgres Nightly Backup') 'ready task is started'
    $script:Started.Clear()
    Set-FakeTask 'MongoDB Nightly Backup' 'Running'
    $res = Invoke-AllowedCommand 'run-mongo-backup'
    Assert ($res.Status -eq 'rejected' -and $res.Message -match 'already running' -and $script:Started.Count -eq 0) 'running task is not started twice'
    $res = Invoke-AllowedCommand 'run-pg-backup'
    Assert ($res.Status -eq 'rejected' -and $res.Message -match "'MongoDB Nightly Backup' is running" -and $script:Started.Count -eq 0) 'nothing starts while another backup is running'
    Set-FakeTask 'MongoDB Nightly Backup' 'Ready'
    $res = Invoke-AllowedCommand 'run-pg-check'
    Assert ($res.Status -eq 'rejected' -and $res.Message -match 'disabled' -and $script:Started.Count -eq 0) 'disabled task is not started'
    $res = Invoke-AllowedCommand 'run-files-check'
    Assert ($res.Status -eq 'failed' -and $res.Message -match 'not found') 'missing task reports failed'
    $res = Invoke-AllowedCommand 'run-mongo-check'
    Assert ($res.Status -eq 'failed' -and $res.Message -match 'denied') 'start error reports failed'
    $res = Invoke-AllowedCommand 'powershell -c evil'
    Assert ($res.Status -eq 'rejected' -and $script:Started.Count -eq 0) 'non-allowlisted action never reaches Task Scheduler'

    # ------------------------------------------------------------------
    Write-Host 'Allowlist: full command loop'
    $script:Replies = New-Object System.Collections.ArrayList
    function Send-CommandResult([string]$Id, [string]$Status, [string]$Message) { [void]$script:Replies.Add(@{ Id = $Id; Status = $Status; Message = $Message }) }
    $id1 = 'a1b2c3d4-0000-4000-8000-000000000001'
    $id2 = 'a1b2c3d4-0000-4000-8000-000000000002'
    $id3 = 'a1b2c3d4-0000-4000-8000-000000000003'
    $cmds = ConvertFrom-Json ('[{"id":"' + $id1 + '","action":"run-pg-backup","ageSeconds":12,"requestedBy":"owner"},' +
        '{"id":"' + $id2 + '","action":"del C:\\*","ageSeconds":12},' +
        '{"id":"bad id","action":"run-pg-backup","ageSeconds":12},' +
        '{"id":"' + $id3 + '","action":"run-files-backup","ageSeconds":12}]')
    Invoke-PanelCommands $cmds
    Assert ($script:Started.Count -eq 1 -and $script:Started[0] -eq 'Postgres Nightly Backup') 'only the allowlisted command started a task'
    $byId = @{}; foreach ($x in $script:Replies) { $byId[$x.Id] = $x }
    Assert ($byId[$id1].Status -eq 'started') 'reply: started'
    Assert ($byId[$id2].Status -eq 'rejected') 'reply: rejected for free-form action'
    Assert ($byId[$id3].Status -eq 'rejected') 'reply: rejected for disabled action'
    Assert (-not $byId.ContainsKey('bad id')) 'no reply for malformed id'
    $done = @(Get-DoneCommandIds)
    Assert ($done -contains $id1 -and $done -contains $id2) 'handled ids are remembered'
    $script:Replies.Clear()
    Invoke-PanelCommands (ConvertFrom-Json ('[{"id":"' + $id1 + '","action":"run-pg-backup","ageSeconds":5}]'))
    Assert ($script:Started.Count -eq 1 -and $script:Replies.Count -eq 0) 'replayed command id does not run again'
    $log = Get-Content -LiteralPath $AgentLogPath -Raw
    Assert ($log -match 'Refused command' -and $log -match 'started') 'commands are written to panel-agent.log'
    $script:Replies.Clear()
    $ids = 11..14 | ForEach-Object { 'b1b2c3d4-0000-4000-8000-0000000000{0}' -f $_ }
    $four = ConvertFrom-Json ('[{"id":"' + $ids[0] + '","action":"run-pg-backup","ageSeconds":1},{"id":"' + $ids[1] + '","action":"run-mongo-backup","ageSeconds":1},' +
        '{"id":"' + $ids[2] + '","action":"run-pg-check","ageSeconds":1},{"id":"' + $ids[3] + '","action":"run-mongo-check","ageSeconds":1}]')
    Invoke-PanelCommands $four
    $replied = @($script:Replies | ForEach-Object { $_.Id })
    Assert ($replied.Count -eq 3 -and $replied -notcontains $ids[3]) 'at most 3 commands reach Task Scheduler per run'

    # ------------------------------------------------------------------
    Write-Host 'Redaction'
    $cases = @(
        @('mongodb://admin:S3cretPw@127.0.0.1:27017/app', 'S3cretPw'),
        @('postgres://u:p4ss%21@db/x', 'p4ss'),
        @('set PGPASSWORD=hunter2 and run', 'hunter2'),
        @('RESTIC_PASSWORD="correct horse"', 'correct horse'),
        @('AWS_SECRET_ACCESS_KEY=abcdEFGH1234', 'abcdEFGH1234'),
        @('smtpPassword: letmein', 'letmein'),
        @('"api_key": "zzz-111"', 'zzz-111'),
        @('mongodump --password Pa55word --archive', 'Pa55word'),
        @('Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'),
        @('key K003aBcDeFgHiJkLmNoPqRsTuVwXyZ12 used', 'K003aBcDeFgHiJkLmNoPqRsTuVwXyZ12')
    )
    foreach ($c in $cases) {
        $out = Protect-Text $c[0]
        Assert ($out -notmatch [regex]::Escape($c[1])) ("hides secret in: " + $c[0].Substring(0, [Math]::Min(30, $c[0].Length)))
    }
    $keep = @(
        '2026-11-11 02:00:04 [INFO] Backup finished: 1.2 GB before compression, 40 MB actually uploaded',
        'snapshot 4f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f saved',
        'Reading C:\Apps\db-backup\logs\files-backup.log',
        'restic: wrong password or no key found',
        'Uploaded to gcrypt:postgres/2026-11-11/app.dump'
    )
    foreach ($k in $keep) { Assert ((Protect-Text $k) -eq $k) ('keeps normal line: ' + $k.Substring(0, [Math]::Min(40, $k.Length))) }
    Assert ((Protect-Text ('x' * 3000) 100).Length -lt 120) 'long text is cut'

    $obj = ConvertFrom-Json '{"database":"app","smtpPassword":"x1","nested":{"apiKey":"k","token":"t","size":123,"items":[{"name":"one"}]},"single":["only"],"uri":"mongodb://a:b@h/db","ok":true}'
    $safe = ConvertTo-SafeValue $obj 0
    $json = ConvertTo-Json -InputObject $safe -Depth 10 -Compress
    Assert ($json -notmatch '"x1"' -and $safe.smtpPassword -eq '(hidden)') 'secret-looking keys are hidden'
    Assert ($safe.nested.apiKey -eq '(hidden)' -and $safe.nested.token -eq '(hidden)') 'nested secret keys are hidden'
    Assert ($safe.nested.size -eq 123 -and $safe.ok -eq $true -and $safe.database -eq 'app') 'normal values are kept'
    Assert ($json -match '"single":\["only"\]') 'one-item arrays stay arrays'
    Assert ($json -match '"items":\[\{"name":"one"\}\]') 'arrays of objects stay arrays'
    Assert ($safe.uri -notmatch ':b@') 'credentials in URIs are hidden'

    # ------------------------------------------------------------------
    Write-Host 'Reading log tails'
    $utf8 = Join-Path $tmp 'logs\utf8.log'
    $lines = 1..500 | ForEach-Object { '2026-11-11 02:00:00 line {0:D4} ok' -f $_ }
    [System.IO.File]::WriteAllLines($utf8, $lines)
    $t = @(Read-FileTail $utf8 1000)
    Assert ($t.Count -gt 5 -and $t[-1] -eq '2026-11-11 02:00:00 line 0500 ok') 'UTF-8 tail ends with the last line'
    Assert ($t[0] -match '^2026-11-11 02:00:00 line \d{4} ok$') 'cut first line is dropped'
    $utf16 = Join-Path $tmp 'logs\utf16.log'
    $lines | Out-File -LiteralPath $utf16 -Encoding Unicode
    $t = @(Read-FileTail $utf16 1001)
    Assert ($t[-1] -eq '2026-11-11 02:00:00 line 0500 ok' -and $t[0] -match '^2026') 'UTF-16 (Out-File) tail works with an odd offset'
    $small = Join-Path $tmp 'logs\small.log'
    [System.IO.File]::WriteAllText($small, "one`r`ntwo`r`n")
    $t = @(Read-FileTail $small 100000)
    Assert ($t.Count -eq 2 -and $t[0] -eq 'one') 'small file is read whole'
    $empty = Join-Path $tmp 'logs\empty.log'
    [System.IO.File]::WriteAllText($empty, '')
    Assert (@(Read-FileTail $empty 1000).Count -eq 0) 'empty file gives no lines'
    $fs = New-Object System.IO.FileStream($utf8, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try { Assert (@(Read-FileTail $utf8 500).Count -gt 0) 'reads while another process has the log open' } finally { $fs.Dispose() }

    # ------------------------------------------------------------------
    Write-Host 'Config validation'
    $bad = Join-Path $tmp 'bad.psd1'
    $threw = $false; Write-TestConfig $bad "    CommandEnabled = `$true"; try { [void](Get-AgentConfig $bad) } catch { $threw = $_.Exception.Message -match 'Unknown setting' }
    Assert $threw 'misspelt setting is rejected'
    $threw = $false; [System.IO.File]::WriteAllText($bad, "@{ PanelUrl = 'http://evil.example.com' }"); try { [void](Get-AgentConfig $bad) } catch { $threw = $true }
    Assert $threw 'plain http to a remote host is rejected'
    $threw = $false; [System.IO.File]::WriteAllText($bad, "@{ PanelUrl = 'http://127.0.0.1:7480/api?x=1' }"); try { [void](Get-AgentConfig $bad) } catch { $threw = $true }
    Assert $threw 'PanelUrl with a path is rejected'
    $threw = $false; [System.IO.File]::WriteAllText($bad, "@{ PanelUrl = 'https://backups.example.com' }"); try { [void](Get-AgentConfig $bad) } catch { $threw = $_.Exception.Message -match '127\.0\.0\.1' }
    Assert $threw 'the public Nginx address is rejected (agent talks to 127.0.0.1)'
    $threw = $false; Write-TestConfig $bad "    DisabledActions = @('run-everything')"; try { [void](Get-AgentConfig $bad) } catch { $threw = $true }
    Assert $threw 'unknown DisabledActions entry is rejected'
    $threw = $false; Write-TestConfig $bad "    CommandsEnabled = 'yes'"; try { [void](Get-AgentConfig $bad) } catch { $threw = $true }
    Assert $threw 'CommandsEnabled must be a real boolean'
    $threw = $false; [System.IO.File]::WriteAllText($bad, "@{ PanelUrl = 'http://127.0.0.1:7480'; Backblaze = @{ Enabeld = `$true } }"); try { [void](Get-AgentConfig $bad) } catch { $threw = $_.Exception.Message -match 'Backblaze' }
    Assert $threw 'misspelt Backblaze setting is rejected'
    $threw = $false; [System.IO.File]::WriteAllText($bad, "@{ PanelUrl = 'http://127.0.0.1:7480'; Heartbeat = @{ Url = 'x' } }"); try { [void](Get-AgentConfig $bad) } catch { $threw = $_.Exception.Message -match 'Heartbeat' }
    Assert $threw 'unknown Heartbeat setting is rejected (the address belongs in the secret file)'
    $okCfg = Get-AgentConfig (Join-Path (Split-Path -Parent $PSScriptRoot) 'panel-agent.config.psd1')
    Assert ($okCfg.CommandsEnabled -eq $false -and $okCfg.Backblaze.Enabled -eq $false) 'shipped config starts read-only'
    Assert ($okCfg.PanelUrl -eq 'http://127.0.0.1:7480') 'shipped config points at the local panel app'
    Assert ($okCfg.Heartbeat.Enabled -eq $true -and $okCfg.Heartbeat.EveryMinutes -eq 5) 'shipped config pings every 5 minutes once an address is saved'

    # ------------------------------------------------------------------
    Write-Host 'Heartbeat'
    $hbUrl = 'https://hc-ping.com/0f8fad5b-d9cb-469f-a165-70867728950e'
    Assert (Test-HeartbeatUrl $hbUrl) 'a Healthchecks ping address is accepted'
    Assert (-not (Test-HeartbeatUrl 'http://hc-ping.com/abc')) 'plain http is refused'
    Assert (-not (Test-HeartbeatUrl 'https://hc-ping.com/abc?x=1')) 'query strings are refused'
    Assert (-not (Test-HeartbeatUrl 'https://hc-ping.com/a b')) 'spaces are refused'
    Assert (-not (Test-HeartbeatUrl 'https://hc-ping.com')) 'an address without a path is refused'
    $script:Pings = New-Object System.Collections.ArrayList
    $script:PingCode = 200
    $PingHook = { param([string]$Url) [void]$script:Pings.Add($Url); return $script:PingCode }
    $hbState = Join-Path $StateDir 'heartbeat.json'
    Send-Heartbeat
    Assert ($script:Pings.Count -eq 0 -and -not (Test-Path $hbState)) 'no ping before an address is saved'
    $hbFile = Resolve-AgentPath $Cfg.Heartbeat.UrlFile
    New-Object System.Management.Automation.PSCredential('heartbeat', (ConvertTo-SecureString $hbUrl -AsPlainText -Force)) | Export-Clixml -LiteralPath $hbFile
    Send-Heartbeat
    $st = Read-JsonFile $hbState
    Assert ($script:Pings.Count -eq 1 -and $script:Pings[0] -eq $hbUrl -and $st.lastPingAt -and -not $st.lastError) 'first run pings and remembers when'
    Send-Heartbeat
    Assert ($script:Pings.Count -eq 1) 'no second ping within 5 minutes'
    Write-JsonFile $hbState ([ordered]@{ lastPingAt = (ConvertTo-IsoTime ((Get-UtcNow).AddMinutes(-6))); lastAttemptAt = $null; lastError = $null })
    $script:PingCode = 500
    Send-Heartbeat
    $st = Read-JsonFile $hbState
    Assert ($script:Pings.Count -eq 2 -and $st.lastError -match '500' -and $st.lastPingAt) 'a refused ping is recorded as an error and keeps the last good time'
    $script:PingCode = 200
    Send-Heartbeat
    $st = Read-JsonFile $hbState
    Assert ($script:Pings.Count -eq 3 -and -not $st.lastError) 'after an error the next run tries again'
    $log = Get-Content -LiteralPath $AgentLogPath -Raw
    Assert ($log -match 'Heartbeat failed' -and $log -match 'Heartbeat works again' -and $log -notmatch 'hc-ping') 'heartbeat problems are logged without the address'
    $Cfg.Heartbeat.Enabled = $false
    Write-JsonFile $hbState ([ordered]@{ lastPingAt = $null; lastAttemptAt = $null; lastError = $null })
    Send-Heartbeat
    Assert ($script:Pings.Count -eq 3) 'Enabled = $false stops the pings'
    $Cfg.Heartbeat.Enabled = $true
    $hbSum = Get-HeartbeatSummary
    Assert ($hbSum.enabled -eq $true -and $hbSum.everyMinutes -eq 5) 'the report says the heartbeat is on'

    # ------------------------------------------------------------------
    Write-Host 'Full report on a fake server folder'
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\pg-last-success.json'), '{"time":"2026-11-11T02:05:00+05:30","sizeBytes":123456789,"databases":["app"],"pgPassword":"nope"}')
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\last-success.json'), '{"time":"2026-11-11T02:05:00+05:30","databases":["app"]}')
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\mongo-last-failure.json'), '{"time":"2026-11-10T02:31:00+05:30","error":"mongodump exited 1 uri mongodb://root:Hunter22@localhost"}')
    '{"sets":[{"name":"logs","added":"40 MB"}],"finished":"2026-11-11T03:33:00+05:30"}' | Out-File -LiteralPath (Join-Path $tmp 'status\files-last-success.json') -Encoding Unicode
    [System.IO.File]::WriteAllText((Join-Path $tmp 'status\other.json'), 'not json')
    [System.IO.File]::WriteAllLines((Join-Path $tmp 'logs\pg-backup.log'), [string[]]@('2026-11-11 02:00:00 start', '2026-11-11 02:05:00 ERROR upload failed PGPASSWORD=abc', '2026-11-11 02:06:00 0 errors'))
    Set-FakeTask 'Files Nightly Backup' 'Ready'
    $CollectErrors.Clear()
    $report = New-AgentReport
    $json = ConvertTo-Json -InputObject $report -Depth 12
    $back = ConvertFrom-Json $json
    Assert ($back.schema -eq 1 -and @($back.jobs).Count -eq 3) 'report has three jobs'
    $pg = @($back.jobs | Where-Object { $_.id -eq 'pg' })[0]
    Assert ($pg.backup.task.found -eq $true -and $pg.backup.task.lastResult -eq 0) 'job shows its scheduled task'
    Assert ($null -ne $pg.lastSuccessAt -and @($pg.statusFiles) -contains 'pg-last-success.json') 'job picks up its success status file'
    $mongo = @($back.jobs | Where-Object { $_.id -eq 'mongo' })[0]
    Assert ($null -ne $mongo.lastFailureAt -and $null -eq $mongo.lastSuccessAt) 'job picks up its failure status file'
    $files = @($back.statusFiles | Where-Object { $_.name -eq 'files-last-success.json' })[0]
    Assert ($files.content.sets[0].name -eq 'logs') 'UTF-16 status file is parsed'
    $other = @($back.statusFiles | Where-Object { $_.name -eq 'other.json' })[0]
    Assert ($null -ne $other.error -and $null -eq $other.job) 'broken JSON is reported, not fatal'
    Assert ($json -notmatch 'Hunter22' -and $json -notmatch '"nope"' -and $json -notmatch 'PGPASSWORD=abc') 'no secrets in the report'
    $pgLog = @($back.logs | Where-Object { $_.name -eq 'pg-backup.log' })[0]
    Assert (@($pgLog.problems).Count -eq 1 -and $pgLog.problems[0] -match 'upload failed') 'log problem lines found, "0 errors" ignored'
    Assert (@($back.disks).Count -ge 1 -and $back.disks[0].sizeBytes -gt 0) 'disks are listed'
    Assert ($back.agent.commandsEnabled -eq $true -and @($back.agent.enabledActions) -notcontains 'run-files-backup') 'report lists enabled actions without the disabled one'
    Assert ($back.backblaze.enabled -eq $false) 'Backblaze off by default'
    Assert (@($pg.statusFiles) -contains 'last-success.json') 'the Postgres check file last-success.json belongs to the Postgres card'
    Assert ($back.agent.heartbeat.enabled -eq $true -and $json -notmatch 'hc-ping') 'report shows the heartbeat state, never its address'
    Assert (@($back.logs | Where-Object { $_.name -eq 'nginx-reload.log' }).Count -eq 1) 'the Nginx reload log is watched too'
    Assert ($json.Length -lt 200000) ('report is small ({0:N0} bytes)' -f $json.Length)

    # ------------------------------------------------------------------
    Write-Host 'DryRun in a separate PowerShell process (real, read-only Task Scheduler queries)'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath -DryRun -ConfigPath $cfgPath
    $parsed = $null
    try { $parsed = ($out -join "`n") | ConvertFrom-Json } catch { }
    Assert ($LASTEXITCODE -eq 0 -and $null -ne $parsed -and @($parsed.jobs).Count -eq 3) 'DryRun prints a valid report and exits 0'
    $badRun = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentPath -ConfigPath $bad
    Assert ($LASTEXITCODE -eq 2) 'config problem exits with code 2'
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('{0} passed, {1} failed' -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
