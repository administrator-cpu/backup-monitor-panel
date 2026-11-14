<#
  pg-backup-check.ps1  v1.2   morning check of the nightly backup  (scheduled at 08:00)
  v1.1: also writes status\pg-snapshots.json for the backup panel (panel-status.ps1; optional, never changes the check).
  v1.2: a check started before 04:00 (by hand, or with the panel's Run check) looks at last night's
        snapshot: today's does not exist until the 02:00 backup has run. The e-mail says when the check ran.

  Does NOT trust the nightly script's own word. It looks at what is really in Google Drive:
   - today's snapshot folder exists and has manifest.txt, globals.sql and a dump for every database,
   - the last successful run on this server is recent, and the staging disk has room.
  If anything is wrong (including "Google Drive cannot be reached" or "the task never ran"), it e-mails you.
  On Mondays it also e-mails a short summary (-Summary sends one right now, e.g. to test the e-mail).
#>
param([switch]$Summary)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'pg-backup-common.ps1')
$panelStatus = Join-Path $PSScriptRoot 'panel-status.ps1'
if (Test-Path $panelStatus) { . $panelStatus }   # restore-point summary for the backup panel (optional)

$now   = Get-Date
$today = $now.ToString('yyyy-MM-dd')
$problems = New-Object System.Collections.ArrayList

# Which night's snapshot to look at: today's, or last night's when the check runs before 04:00.
$snapDay = $today
$snapName = "Today's snapshot ($today)"
if ($now.Hour -lt 4) {
    $snapDay = $now.AddDays(-1).ToString('yyyy-MM-dd')
    $snapName = "Last night's snapshot ($snapDay)"
}

try {
    Log "===== backup check ($today) ====="
    if ($snapDay -ne $today) { Log "Started before 04:00, so this checks last night's snapshot ($snapDay); today's is made at 02:00." }

    # 1. what is in Drive for that night?
    $r = Invoke-Rclone @('lsf', "$($Cfg.Remote)/$snapDay", '--files-only')
    if ($r.Code -ne 0) {
        [void]$problems.Add("$snapName is not in Google Drive, or Drive cannot be reached. rclone said: $($r.Lines -join ' | ')")
    } else {
        $files = @($r.Lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($need in @('manifest.txt', 'globals.sql')) {   # names as rclone shows them after decryption
            if ($files -notcontains $need) { [void]$problems.Add("$snapName is missing $need") }
        }
        $dumpsInDrive = @($files | Where-Object { $_ -like '*.dump' }).Count

        # compare with the databases that exist now
        $q = Invoke-Psql 'postgres' @('-tA', '-c', 'select count(*) from pg_database where not datistemplate and datallowconn')
        if ($q.Code -eq 0) {
            $expected = [int](($q.Lines | Select-Object -First 1).Trim())
            if ($dumpsInDrive -lt $expected) {
                [void]$problems.Add("$snapName has $dumpsInDrive database dumps but Postgres has $expected databases (a database created after 02:00 would explain one missing).")
            }
        } else {
            [void]$problems.Add("Could not ask Postgres how many databases exist: $($q.Lines -join ' | ')")
        }
    }

    # 2. last successful run on this server
    $okFile = Join-Path $Cfg.StatusDir 'last-success.json'
    if (-not (Test-Path $okFile)) {
        [void]$problems.Add('No successful run is recorded on this server yet.')
    } else {
        $last = (Get-Content $okFile -Raw | ConvertFrom-Json)
        $ageH = [math]::Round(($now - [datetime]$last.time).TotalHours, 1)
        if ($ageH -gt $Cfg.MaxBackupAgeHours) { [void]$problems.Add("The last successful backup was $ageH hours ago (limit $($Cfg.MaxBackupAgeHours)).") }
    }

    # 3. disk space for the temporary copies
    $free = Get-FreeGB $Cfg.Staging
    if ($free -lt ($Cfg.MinFreeGB * 2)) { [void]$problems.Add("Only $free GB free on the staging disk ($($Cfg.Staging)).") }

    # 4. restore-point list for the backup panel (status\pg-snapshots.json). Never changes this check.
    if (Get-Command Save-PanelPgSummary -ErrorAction SilentlyContinue) { Save-PanelPgSummary $problems $Cfg.Remote $Cfg.StatusDir }

    if ($problems.Count -gt 0) {
        $text = "Problems found by the Postgres backup check (run at $($now.ToString('HH:mm'))) on $env:COMPUTERNAME ($today):`r`n`r`n- " + (Limit-Text ($problems -join "`r`n- ") 1500) +
                "`r`n`r`nLog: $(Join-Path $Cfg.LogDir 'pg-backup.log')"
        Log ("CHECK FAILED: " + ($problems -join ' || ')) 'ERROR'
        $null = Send-Mail 'Postgres backup check: PROBLEM' $text
        exit 1
    }
    Log 'Check OK: today''s snapshot is in Drive and complete.'

    # Monday summary
    if ($now.DayOfWeek -eq 'Monday' -or $Summary) {
        $snaps = @(Get-RemoteSnapshots)
        $sz = Invoke-Rclone @('size', $Cfg.Remote, '--json')
        $total = 'unknown'
        if ($sz.Code -eq 0) { try { $total = Format-Size ((($sz.Lines -join '') | ConvertFrom-Json).bytes) } catch { } }
        $body = "Weekly Postgres backup summary ($env:COMPUTERNAME, $today)`r`n`r`n" +
                "Snapshots in Google Drive: $($snaps.Count) (oldest $($snaps[0]), newest $($snaps[-1]))`r`n" +
                "Total size in Drive (unencrypted size): $total`r`n" +
                "Last night: $($last.databases.Count) databases, $(Format-Size $last.totalBytes), took $($last.seconds) s`r`n" +
                "Free space on staging disk: $free GB`r`n"
        $null = Send-Mail 'Postgres backup weekly summary' $body
    }
    exit 0
}
catch {
    Log "CHECK ERROR: $($_.Exception.Message)" 'ERROR'
    $null = Send-Mail 'Postgres backup check: ERROR' "The 08:00 backup check itself failed on $env:COMPUTERNAME:`r`n$($_.Exception.Message)"
    exit 1
}
