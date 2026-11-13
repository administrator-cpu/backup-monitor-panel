<#
  files-backup-check.ps1  v1.1   morning check of the file backups  (scheduled at 08:15)
  v1.1: also writes status\files-snapshots.json for the backup panel (panel-status.ps1; optional, never changes the check).

  Asks Backblaze itself (not the nightly script) whether every set has a fresh snapshot, and also warns when
   - the last successful run on this server is too old,
   - the log drive (F:) or C: is running out of space (the syslog collector stops writing when F: is full),
   - the data stored in Backblaze has grown past the alarm size (runaway upload).
  Problems are e-mailed. On Mondays (or with -Summary) a short summary with the size and the estimated monthly cost.
#>
param([switch]$Summary)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'files-backup-common.ps1')
$panelStatus = Join-Path $PSScriptRoot 'panel-status.ps1'
if (Test-Path $panelStatus) { . $panelStatus }   # restore-point summary for the backup panel (optional)

$now   = Get-Date
$today = $now.ToString('yyyy-MM-dd')
$problems = New-Object System.Collections.ArrayList
$lines = New-Object System.Collections.ArrayList
$totalBytes = 0.0
$last = $null
$panelSets = @{}

try {
    Log "===== file backup check ($today) ====="
    $null = Find-Restic
    foreach ($name in @($Cfg.FileSets.Keys)) {
        try {
            Initialize-ResticEnv $name
            $r = Invoke-Restic @('snapshots', '--json', '--tag', $name, '--host', $Cfg.ResticHost)
            if ($r.Code -ne 0) { [void]$problems.Add("[$name] cannot read the repository in Backblaze: $(Limit-Text ($r.Lines -join ' | ') 300)"); continue }
            $raw = $r.Lines -join "`n"
            $items = @($raw | ConvertFrom-Json)
            $snaps = @()
            foreach ($i in $items) { if ($i.PSObject.Properties.Name -contains 'snapshots') { $snaps += @($i.snapshots) } else { $snaps += $i } }
            if ($snaps.Count -eq 0) { [void]$problems.Add("[$name] no snapshots exist yet"); continue }
            $newest = $snaps | Sort-Object { [datetime]$_.time } | Select-Object -Last 1
            $ageH = [math]::Round(($now - ([datetime]$newest.time).ToLocalTime()).TotalHours, 1)
            if ($ageH -gt $Cfg.FileMaxAgeHours) { [void]$problems.Add("[$name] the newest snapshot is $ageH hours old (limit $($Cfg.FileMaxAgeHours)).") }

            $size = 0.0
            if ($Summary -or $now.DayOfWeek -eq 'Monday' -or $true) {
                $st = Invoke-Restic @('stats', '--mode', 'raw-data', '--json')
                if ($st.Code -eq 0) {
                    $o = @(ConvertFrom-ResticJsonLines $st.Lines | Select-Object -Last 1)
                    if ($o.Count -gt 0 -and $o[0].total_size) { $size = [double]$o[0].total_size }
                }
            }
            $totalBytes += $size
            [void]$lines.Add(("  {0,-6} {1} snapshots, newest {2} h ago, stored in Backblaze: {3}" -f $name, $snaps.Count, $ageH, (Format-Size $size)))
            $panelSets[$name] = @{ Snaps = $snaps; Stored = $size }
        } catch {
            [void]$problems.Add("[$name] check failed: $($_.Exception.Message)")
        } finally {
            Clear-ResticEnv
        }
    }

    $okFile = Join-Path $Cfg.StatusDir 'files-last-success.json'
    if (-not (Test-Path $okFile)) {
        [void]$problems.Add('No successful file backup run is recorded on this server yet.')
    } else {
        $last = (Get-Content $okFile -Raw | ConvertFrom-Json)
        $ageH = [math]::Round(($now - [datetime]$last.time).TotalHours, 1)
        if ($ageH -gt $Cfg.FileMaxAgeHours) { [void]$problems.Add("The last successful file backup on this server was $ageH hours ago (limit $($Cfg.FileMaxAgeHours)).") }
    }

    $freeNotes = @()
    foreach ($d in @(@('F:\', $Cfg.MinFreeGB_F), @('C:\', $Cfg.MinFreeGB_C))) {
        if (Test-Path $d[0]) {
            $free = Get-FreeGB $d[0]
            $freeNotes += "$($d[0]) $free GB free"
            if ($free -lt $d[1]) { [void]$problems.Add("Only $free GB free on $($d[0]) (warning level $($d[1]) GB).") }
        }
    }
    $totalGB = [math]::Round($totalBytes / 1GB, 1)
    if ($totalGB -gt $Cfg.B2SizeAlarmGB) { [void]$problems.Add("Backblaze now holds $totalGB GB for the file backups (alarm level $($Cfg.B2SizeAlarmGB) GB). Check for runaway growth.") }

    # Restore-point list for the backup panel (status\files-snapshots.json). Never changes this check.
    if (Get-Command Save-PanelFilesSummary -ErrorAction SilentlyContinue) { Save-PanelFilesSummary $problems $panelSets $Cfg.StatusDir }

    if ($problems.Count -gt 0) {
        $text = "Problems found by the 08:15 file backup check on $env:COMPUTERNAME ($today):`r`n`r`n- " + (Limit-Text ($problems -join "`r`n- ") 1800) +
                "`r`n`r`nLog: $(Join-Path $Cfg.LogDir 'files-backup.log')"
        Log ('CHECK FAILED: ' + ($problems -join ' || ')) 'ERROR'
        $null = Send-Mail 'File backup check: PROBLEM' $text
        exit 1
    }
    Log 'Check OK: every set has a fresh snapshot in Backblaze.'

    if ($now.DayOfWeek -eq 'Monday' -or $Summary) {
        $cost = [math]::Round($totalGB * $Cfg.B2PricePerGB, 2)
        $body = "Weekly file backup summary ($env:COMPUTERNAME, $today)`r`n`r`n" + ($lines -join "`r`n") + "`r`n`r`n" +
                "Total stored in Backblaze: $totalGB GB  (about US`$$cost per month at the list price)`r`n" +
                "Disk space: $($freeNotes -join ', ')`r`n"
        if ($last) { foreach ($k in $last.sets.PSObject.Properties) { $body += "Last night [$($k.Name)]: $($k.Value.filesNew) new, $($k.Value.filesChanged) changed files, $(Format-Size $k.Value.dataAdded) uploaded, $($k.Value.seconds) s`r`n" } }
        $null = Send-Mail 'File backup weekly summary' $body
    }
    exit 0
}
catch {
    Log "CHECK ERROR: $($_.Exception.Message)" 'ERROR'
    $null = Send-Mail 'File backup check: ERROR' "The 08:15 file backup check itself failed on $env:COMPUTERNAME:`r`n$($_.Exception.Message)"
    exit 1
}
