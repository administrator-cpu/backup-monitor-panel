# panel-agent-setup.ps1 - one-time setup for the backup panel agent.
# Windows PowerShell 5.1, ASCII only. Run on the SERVER, in C:\Apps\db-backup,
# as the same Windows user that runs the backup tasks (secrets are DPAPI-bound
# to that user).
#
#   .\panel-agent-setup.ps1 -NewToken                create the agent token and the fingerprint file the panel reads
#   .\panel-agent-setup.ps1 -ShowTokenHash           print the fingerprint and write the file again
#   .\panel-agent-setup.ps1 -SetBackblazeKey         save a READ-ONLY Backblaze key (bucket size and cost)
#   .\panel-agent-setup.ps1 -SetHeartbeatUrl         save the outside "I'm alive" ping address (Healthchecks.io)
#   .\panel-agent-setup.ps1 -InstallTask             create the "Backup Panel Agent" task (every minute)
#   .\panel-agent-setup.ps1 -Status                  show the task, the last run and the agent log
#   .\panel-agent-setup.ps1 -Disable                 stop the agent (kill switch)
#   .\panel-agent-setup.ps1 -Enable                  start it again
#
# Nothing here deletes files. -Force is needed to replace an existing token or task.

[CmdletBinding()]
param(
    [switch]$NewToken,
    [switch]$ShowTokenHash,
    [switch]$SetBackblazeKey,
    [switch]$SetHeartbeatUrl,
    [switch]$InstallTask,
    [switch]$Status,
    [switch]$Disable,
    [switch]$Enable,
    [switch]$Force,
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Backup Panel Agent'
$AgentScript = Join-Path $PSScriptRoot 'panel-agent.ps1'
if (-not (Test-Path -LiteralPath $AgentScript)) { throw "panel-agent.ps1 must be in the same folder as this script ($PSScriptRoot)" }

# Reuse the agent's config reader (dot-sourcing does not start a run). Pass
# -ConfigPath through, or the agent's own parameter would overwrite ours.
. $AgentScript -ConfigPath $ConfigPath
$Cfg = Get-AgentConfig $ConfigPath

function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Save-Secret([string]$RelativePath, [string]$UserName, [System.Security.SecureString]$Secret) {
    $path = Resolve-AgentPath $RelativePath
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $cred = New-Object System.Management.Automation.PSCredential($UserName, $Secret)
    $cred | Export-Clixml -LiteralPath $path
    Write-Host ("Saved (Windows DPAPI, only {0} on this server can open it): {1}" -f $env:USERNAME, $path)
}

# The panel app reads this file to recognise the agent. It holds only the
# SHA-256 of the token, which cannot be used to sign in as the agent.
function Write-TokenHash {
    $cred = Read-SecretCredential (Resolve-AgentPath $Cfg.TokenFile)
    if ($null -eq $cred) { throw 'No agent token yet. Run: .\panel-agent-setup.ps1 -NewToken' }
    $hash = Get-Sha256Hex $cred.GetNetworkCredential().Password
    $path = Resolve-AgentPath $Cfg.TokenHashFile
    [System.IO.File]::WriteAllText($path, $hash + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host ('Token fingerprint (SHA-256, not the secret): ' + $hash)
    Write-Host ('Written to {0}; the panel picks it up by itself.' -f $path)
    Write-Host ''
}

if ($NewToken) {
    $path = Resolve-AgentPath $Cfg.TokenFile
    if ((Test-Path -LiteralPath $path) -and -not $Force) {
        throw "A token already exists ($path). Use -NewToken -Force to replace it."
    }
    $bytes = New-Object byte[] 32
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    Save-Secret $Cfg.TokenFile 'panel-agent' (ConvertTo-SecureString $token -AsPlainText -Force)
    $token = $null
    Write-TokenHash
}

if ($ShowTokenHash) { Write-TokenHash }

if ($SetBackblazeKey) {
    Write-Host 'Create a NEW Backblaze application key: bucket windows-vps-vault, Type of Access = Read Only.'
    Write-Host 'Do not reuse the backup key; this one must not be able to write or delete.'
    $keyId = (Read-Host 'keyID').Trim()
    $appKey = Read-Host 'applicationKey (not shown while typing)' -AsSecureString
    $plain = (New-Object System.Management.Automation.PSCredential('x', $appKey)).GetNetworkCredential().Password
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $basic = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($keyId + ':' + $plain))
    $plain = $null
    Write-Host 'Checking the key with Backblaze...'
    $auth = Invoke-RestMethod -Uri 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account' -Method Get -Headers @{ Authorization = 'Basic ' + $basic } -TimeoutSec 30 -UseBasicParsing
    $caps = @($auth.allowed.capabilities)
    Write-Host ('Key works. Bucket: {0}  Capabilities: {1}' -f $auth.allowed.bucketName, ($caps -join ', '))
    $writeCaps = @($caps | Where-Object { $_ -match '^(writeFiles|deleteFiles|writeBuckets|deleteBuckets|writeKeys|deleteKeys|writeBucketRetentions|bypassGovernance)$' })
    if ($writeCaps.Count -gt 0) {
        throw ('Not saved: this key can also {0}. Create a Read Only key for the panel.' -f ($writeCaps -join ', '))
    }
    if (@($caps) -notcontains 'listFiles') { throw 'Not saved: the key cannot list files (listFiles missing).' }
    Save-Secret $Cfg.Backblaze.KeyFile $keyId $appKey
    Write-Host 'Now set Enabled = $true under Backblaze in panel-agent.config.psd1.'
}

if ($SetHeartbeatUrl) {
    Write-Host 'Paste the ping address of your check (Healthchecks.io: the "Ping URL" on the check page,'
    Write-Host 'like https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).'
    $url = (Read-Host 'Ping URL').Trim()
    if (-not (Test-HeartbeatUrl $url)) { throw 'Not saved: that is not a plain https:// address (no spaces, no ? or #).' }
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    Write-Host 'Sending one test ping...'
    $code = Invoke-HeartbeatRequest $url
    if ($code -ne 200) { throw ('Not saved: the service answered HTTP {0}. Check the address.' -f $code) }
    Write-Host 'Ping accepted (HTTP 200). The check on the website should now show "up".'
    Save-Secret $Cfg.Heartbeat.UrlFile 'heartbeat' (ConvertTo-SecureString $url -AsPlainText -Force)
    $url = $null
    Write-Host ('The agent now pings every {0} minutes after each report that reaches the panel.' -f $Cfg.Heartbeat.EveryMinutes)
}

if ($InstallTask) {
    if ($null -eq (Read-SecretCredential (Resolve-AgentPath $Cfg.TokenFile))) { throw 'Create the token first: .\panel-agent-setup.ps1 -NewToken' }
    try {
        $probe = [System.Net.HttpWebRequest]::Create($Cfg.PanelUrl + '/login')
        $probe.Proxy = $null
        $probe.Timeout = 5000
        $probe.GetResponse().Close()
    } catch {
        Write-Warning ('The panel app does not answer at {0}. Start it first (pm2 start ...); the task is created anyway.' -f $Cfg.PanelUrl)
    }
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) { throw "Task '$TaskName' already exists. Use -InstallTask -Force to replace it." }
    $user = $env:USERDOMAIN + '\' + $env:USERNAME
    Write-Host ("The task will run as {0}, every minute, whether or not anyone is logged on." -f $user)
    Write-Host 'Windows needs that account password to do this (it is given to Task Scheduler only).'
    $pw = Read-Host ("Windows password for {0}" -f $user) -AsSecureString
    $plainPw = (New-Object System.Management.Automation.PSCredential('x', $pw)).GetNetworkCredential().Password
    $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $AgentScript + '"'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $desc = 'Sends backup status to the backup panel and starts only the six allowlisted backup/check tasks. Disable this task to cut the panel off.'
    Register-ScheduledTask -TaskName $TaskName -Description $desc -Action $action -Trigger $trigger -Settings $settings -User $user -Password $plainPw -RunLevel Highest -Force | Out-Null
    $plainPw = $null
    Write-Host ("Task '{0}' created. First run in about a minute. Check with: .\panel-agent-setup.ps1 -Status" -f $TaskName)
}

if ($Disable) {
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Task '$TaskName' disabled. The panel gets no more reports and can start nothing."
}

if ($Enable) {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Task '$TaskName' enabled."
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
    $last = Read-JsonFile (Join-Path (Resolve-AgentPath $Cfg.StateDir) 'last-run.json')
    if ($null -ne $last) {
        Write-Host ('Last agent run (UTC): {0}  ok={1}  {2} ms' -f $last.at, $last.ok, $last.durationMs)
        if ($last.error) { Write-Host ('Last error: ' + $last.error) }
    }
    $log = Join-Path (Resolve-AgentPath $Cfg.LogDir) 'panel-agent.log'
    if (Test-Path -LiteralPath $log) {
        Write-Host ''
        Write-Host 'Last lines of panel-agent.log:'
        Get-Content -LiteralPath $log -Tail 15 | ForEach-Object { Write-Host ('  ' + $_) }
    }
}

if (-not ($NewToken -or $ShowTokenHash -or $SetBackblazeKey -or $SetHeartbeatUrl -or $InstallTask -or $Status -or $Disable -or $Enable)) {
    Write-Host 'Nothing to do. Use one of: -NewToken -ShowTokenHash -SetBackblazeKey -SetHeartbeatUrl -InstallTask -Status -Disable -Enable'
}
