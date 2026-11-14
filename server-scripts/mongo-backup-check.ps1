<#
  mongo-backup-check.ps1  v1.2   morning check of the nightly MongoDB backup  (scheduled at 08:05)
  v1.1: also writes status\mongo-snapshots.json for the backup panel (panel-status.ps1; optional, never changes the check).
  v1.2: a check started before 04:00 (by hand, or with the panel's Run check) looks at last night's
        snapshot: today's does not exist until the 02:30 backup has run. The e-mail says when the check ran.

  Looks at what is really in Google Drive (does not trust the nightly script's own word):
   - today's snapshot folder exists and has manifest.txt and mongo-all.archive,
   - the archive is not suspiciously smaller than yesterday's (a wiped database would make it shrink),
   - the last successful run on this server is recent, and the staging disk has room.
  Problems are e-mailed. On Mondays (or with -Summary) it also e-mails a short summary.
#>
param([switch]$Summary)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mongo-backup-common.ps1')
$panelStatus = Join-Path $PSScriptRoot 'panel-status.ps1'
if (Test-Path $panelStatus) { . $panelStatus }   # restore-point summary for the backup panel (optional)

$now   = Get-Date
$today = $now.ToString('yyyy-MM-dd')
$problems = New-Object System.Collections.ArrayList
$last = $null

# Which night's snapshot to look at: today's, or last night's when the check runs before 04:00.
$snapDay = $today
$snapName = "Today's MongoDB snapshot ($today)"
if ($now.Hour -lt 4) {
    $snapDay = $now.AddDays(-1).ToString('yyyy-MM-dd')
    $snapName = "Last night's MongoDB snapshot ($snapDay)"
}

try {
    Log "===== MongoDB backup check ($today) ====="
    if ($snapDay -ne $today) { Log "Started before 04:00, so this checks last night's snapshot ($snapDay); today's is made at 02:30." }

    $r = Invoke-Rclone @('lsf', "$($Cfg.MongoRemote)/$snapDay", '--files-only', '--format', 'ps', '--separator', '|')
    if ($r.Code -ne 0) {
        [void]$problems.Add("$snapName is not in Google Drive, or Drive cannot be reached. rclone said: $($r.Lines -join ' | ')")
    } else {
        $sizes = @{}
        foreach ($line in $r.Lines) {
            $p = $line.Split('|')
            if ($p.Count -ge 2) { $sizes[$p[0].Trim()] = [double]$p[1] }
        }
        foreach ($need in @('manifest.txt', 'mongo-all.archive')) {
            if (-not $sizes.ContainsKey($need)) { [void]$problems.Add("$snapName is missing $need") }
        }
        if ($sizes.ContainsKey('mongo-all.archive')) {
            $todaySize = $sizes['mongo-all.archive']
            $snaps = @(Get-MongoRemoteSnapshots | Where-Object { $_ -lt $snapDay })
            if ($snaps.Count -gt 0) {
                $prev = $snaps[-1]
                $pr = Invoke-Rclone @('lsf', "$($Cfg.MongoRemote)/$prev", '--files-only', '--format', 'ps', '--separator', '|')
                if ($pr.Code -eq 0) {
                    foreach ($line in $pr.Lines) {
                        $p = $line.Split('|')
                        if ($p.Count -ge 2 -and $p[0].Trim() -eq 'mongo-all.archive') {
                            $prevSize = [double]$p[1]
                            if ($prevSize -gt 1MB -and $todaySize -lt ($prevSize * $Cfg.MongoShrinkAlarm)) {
                                [void]$problems.Add(("The archive from {3} is only {0} but the one from {1} was {2}. Data may have been deleted - look before trusting this backup." -f (Format-Size $todaySize), $prev, (Format-Size $prevSize), $snapDay))
                            }
                        }
                    }
                }
            }
        }
    }

    $okFile = Join-Path $Cfg.StatusDir 'mongo-last-success.json'
    if (-not (Test-Path $okFile)) {
        [void]$problems.Add('No successful MongoDB run is recorded on this server yet.')
    } else {
        $last = (Get-Content $okFile -Raw | ConvertFrom-Json)
        $ageH = [math]::Round(($now - [datetime]$last.time).TotalHours, 1)
        if ($ageH -gt $Cfg.MaxBackupAgeHours) { [void]$problems.Add("The last successful MongoDB backup was $ageH hours ago (limit $($Cfg.MaxBackupAgeHours)).") }
    }

    $free = Get-FreeGB $Cfg.MongoStaging
    if ($free -lt ($Cfg.MinFreeGB * 2)) { [void]$problems.Add("Only $free GB free on the staging disk ($($Cfg.MongoStaging)).") }

    # Restore-point list for the backup panel (status\mongo-snapshots.json). Never changes this check.
    if (Get-Command Save-PanelMongoSummary -ErrorAction SilentlyContinue) { Save-PanelMongoSummary $problems $Cfg.MongoRemote $Cfg.StatusDir $last }

    if ($problems.Count -gt 0) {
        $text = "Problems found by the MongoDB backup check (run at $($now.ToString('HH:mm'))) on $env:COMPUTERNAME ($today):`r`n`r`n- " + (Limit-Text ($problems -join "`r`n- ") 1500) +
                "`r`n`r`nLog: $(Join-Path $Cfg.LogDir 'mongo-backup.log')"
        Log ('CHECK FAILED: ' + ($problems -join ' || ')) 'ERROR'
        $null = Send-Mail 'MongoDB backup check: PROBLEM' $text
        exit 1
    }
    Log 'Check OK: today''s MongoDB snapshot is in Drive and complete.'

    if ($now.DayOfWeek -eq 'Monday' -or $Summary) {
        $snaps = @(Get-MongoRemoteSnapshots)
        $sz = Invoke-Rclone @('size', $Cfg.MongoRemote, '--json')
        $total = 'unknown'
        if ($sz.Code -eq 0) { try { $total = Format-Size ((($sz.Lines -join '') | ConvertFrom-Json).bytes) } catch { } }
        $body = "Weekly MongoDB backup summary ($env:COMPUTERNAME, $today)`r`n`r`n" +
                "Snapshots in Google Drive: $($snaps.Count) (oldest $($snaps[0]), newest $($snaps[-1]))`r`n" +
                "Total size in Drive: $total`r`n" +
                "Last night: $(@($last.databases).Count) databases ($(@($last.databases) -join ', ')), $(Format-Size $last.totalBytes), took $($last.seconds) s`r`n" +
                "Free space on staging disk: $free GB`r`n"
        $null = Send-Mail 'MongoDB backup weekly summary' $body
    }
    exit 0
}
catch {
    Log "CHECK ERROR: $($_.Exception.Message)" 'ERROR'
    $null = Send-Mail 'MongoDB backup check: ERROR' "The 08:05 MongoDB backup check itself failed on $env:COMPUTERNAME:`r`n$($_.Exception.Message)"
    exit 1
}
