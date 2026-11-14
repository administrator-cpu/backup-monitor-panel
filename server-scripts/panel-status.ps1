# panel-status.ps1 - restore-point summaries for the backup panel.
# Windows PowerShell 5.1, ASCII only. Lives next to the backup scripts in
# C:\Apps\db-backup. The three morning checks dot-source it (when it is there)
# and call one function at the end of their checks:
#
#   pg-backup-check.ps1     Save-PanelPgSummary     -> status\pg-snapshots.json
#   mongo-backup-check.ps1  Save-PanelMongoSummary  -> status\mongo-snapshots.json
#   files-backup-check.ps1  Save-PanelFilesSummary  -> status\files-snapshots.json
#
# The panel agent already sends status\*.json to the panel, so the panel can list
# restore points without the agent ever touching a password. These functions only
# LIST (rclone lsf/about and a psql SELECT, as the checks already do) and use data
# the checks already have. They never throw: a problem is written to the log as a
# warning and never changes the check's result or its e-mails.

$PanelStatusMaxPoints = 180     # the agent sends at most 200 items per list
$PanelStatusMaxPaths  = 150

function Write-PanelStatusNote([string]$Message) {
    if (Get-Command -Name Log -CommandType Function -ErrorAction SilentlyContinue) { Log ('Panel summary: ' + $Message) 'WARN' }
}

# Any time (text with or without an offset, or a DateTime) -> 'yyyy-MM-ddTHH:mm:ssZ'.
function ConvertTo-PanelUtc($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $text = ([string]$Value) -replace '(\.\d{7})\d+', '$1'
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeLocal
    $d = [datetime]::MinValue
    if (-not [datetime]::TryParse($text, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$d)) { return $null }
    return $d.ToString('yyyy-MM-ddTHH:mm:ssZ')
}

function ConvertTo-PanelProblems($Problems) {
    $out = New-Object System.Collections.ArrayList
    foreach ($p in @($Problems)) {
        if ($null -eq $p) { continue }
        $t = [string]$p
        if ($t.Length -gt 400) { $t = $t.Substring(0, 400) + ' ...' }
        [void]$out.Add($t)
        if ($out.Count -ge 10) { break }
    }
    return [ordered]@{ ok = ($out.Count -eq 0); problems = @($out) }
}

# ---------------------------------------------------------------------------
# Google Drive (Postgres and MongoDB): one folder per night, named yyyy-MM-dd.
# ---------------------------------------------------------------------------

# Lines of  rclone lsf -R --files-only --format ps --separator "|"  ->  folders by date.
function ConvertFrom-PanelDriveListing($Lines) {
    $groups = @{}
    foreach ($line in @($Lines)) {
        $m = [regex]::Match([string]$line, '^(\d{4}-\d{2}-\d{2})/(.+)\|(\d+)\s*$')
        if (-not $m.Success) { continue }
        $date = $m.Groups[1].Value
        if (-not $groups.ContainsKey($date)) { $groups[$date] = @{ bytes = [int64]0; files = 0; names = (New-Object System.Collections.ArrayList) } }
        $g = $groups[$date]
        $g.bytes = [int64]$g.bytes + [int64]$m.Groups[3].Value
        $g.files = [int]$g.files + 1
        [void]$g.names.Add($m.Groups[2].Value)
    }
    return $groups
}

function New-PanelDriveSet([string]$Id, [string]$Remote, $Groups) {
    $dates = @($Groups.Keys | Sort-Object -Descending)
    $points = New-Object System.Collections.ArrayList
    $total = [int64]0
    foreach ($d in $dates) {
        $g = $Groups[$d]
        $total += [int64]$g.bytes
        if ($points.Count -lt $PanelStatusMaxPoints) { [void]$points.Add([ordered]@{ id = $d; date = $d; bytes = [int64]$g.bytes; files = [int]$g.files }) }
    }
    $newest = $null
    $oldest = $null
    if ($dates.Count -gt 0) { $newest = $dates[0]; $oldest = $dates[$dates.Count - 1] }
    return [ordered]@{
        id          = $Id
        provider    = 'Google Drive'
        location    = $Remote
        count       = $dates.Count
        oldest      = $oldest
        newest      = $newest
        storedBytes = $total
        points      = @($points)
    }
}

# Files in the newest folder (for the coverage list).
function Get-PanelNewestNames($Groups) {
    $dates = @($Groups.Keys | Sort-Object -Descending)
    if ($dates.Count -eq 0) { return @() }
    return @($Groups[$dates[0]].names)
}

# rclone about: how full the Google account is. $null when rclone cannot tell.
function Get-PanelDriveSpace([string]$Remote) {
    $root = ($Remote -replace ':.*$', '') + ':'
    $r = Invoke-Rclone @('about', $root, '--json')
    if ($r.Code -ne 0) { return $null }
    $text = (@($r.Lines) -join "`n")
    $a = $text.IndexOf('{')
    $b = $text.LastIndexOf('}')
    if ($a -lt 0 -or $b -le $a) { return $null }
    $o = ConvertFrom-Json -InputObject $text.Substring($a, $b - $a + 1)
    $num = { param($v) if ($null -eq $v) { $null } else { [double]$v } }
    return [ordered]@{
        totalBytes   = (& $num $o.total)
        usedBytes    = (& $num $o.used)
        otherBytes   = (& $num $o.other)
        trashedBytes = (& $num $o.trashed)
        freeBytes    = (& $num $o.free)
    }
}

function Get-PanelDriveSet([string]$Id, [string]$Remote, [ref]$NewestNames) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Rclone @('lsf', '-R', '--files-only', '--fast-list', '--format', 'ps', '--separator', '|', $Remote)
    $ms = $sw.ElapsedMilliseconds
    if ($r.Code -ne 0) {
        $detail = @(@($r.Lines) | Where-Object { "$_" -match '(?i)error|fail|denied|token|timeout|unauthori' } | Select-Object -Last 2) -join ' | '
        if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
        throw ('rclone could not list {0}: {1}' -f $Remote, $detail)
    }
    $groups = ConvertFrom-PanelDriveListing $r.Lines
    $NewestNames.Value = Get-PanelNewestNames $groups
    $set = New-PanelDriveSet $Id $Remote $groups
    $set['listMs'] = [int64]$ms
    return $set
}

# Which databases exist, and which have a dump in the newest folder.
function Get-PanelDbCoverage($Databases, $NewestNames, [string]$Suffix) {
    $dumps = @()
    foreach ($n in @($NewestNames)) {
        $leaf = ([string]$n -split '/')[-1]
        if ($Suffix -and $leaf -like ('*' + $Suffix)) { $dumps += $leaf.Substring(0, $leaf.Length - $Suffix.Length) }
    }
    $covered = @()
    $missing = @()
    foreach ($db in @($Databases)) {
        $name = ([string]$db).Trim()
        if (-not $name) { continue }
        $hit = $false
        foreach ($d in $dumps) { if ($d -eq $name -or $d.StartsWith($name + '_') -or $d.StartsWith($name + '-') -or $d.StartsWith($name + '.')) { $hit = $true } }
        if ($hit -or -not $Suffix) { $covered += $name } else { $missing += $name }
    }
    return [ordered]@{ databases = @($covered); missing = @($missing) }
}

# ---------------------------------------------------------------------------
# restic (server logs and files in Backblaze B2)
# ---------------------------------------------------------------------------
function New-PanelResticSet([string]$Name, $Snapshots, [double]$StoredBytes, $ListMs = $null, $Retries = $null) {
    $list = @(@($Snapshots) | Where-Object { $null -ne $_ } | Sort-Object { [string](ConvertTo-PanelUtc $_.time) } -Descending)
    $points = New-Object System.Collections.ArrayList
    foreach ($s in $list) {
        if ($points.Count -ge $PanelStatusMaxPoints) { break }
        $id = [string]$s.short_id
        if (-not $id -and $s.id) { $id = ([string]$s.id).Substring(0, [Math]::Min(8, ([string]$s.id).Length)) }
        $p = [ordered]@{ id = $id; time = (ConvertTo-PanelUtc $s.time); bytes = $null; added = $null; files = $null }
        if ($null -ne $s.summary) {
            if ($null -ne $s.summary.total_bytes_processed) { $p.bytes = [double]$s.summary.total_bytes_processed }
            if ($null -ne $s.summary.data_added_packed) { $p.added = [double]$s.summary.data_added_packed }
            elseif ($null -ne $s.summary.data_added) { $p.added = [double]$s.summary.data_added }
            if ($null -ne $s.summary.total_files_processed) { $p.files = [int64]$s.summary.total_files_processed }
        }
        [void]$points.Add($p)
    }
    $paths = @()
    if ($list.Count -gt 0) { $paths = @(@($list[0].paths) | Where-Object { $_ } | Select-Object -First $PanelStatusMaxPaths | ForEach-Object { [string]$_ }) }
    $newest = $null
    $oldest = $null
    if ($points.Count -gt 0) {
        $newest = ConvertTo-PanelUtc $list[0].time
        $oldest = ConvertTo-PanelUtc $list[$list.Count - 1].time
    }
    return [ordered]@{
        id          = $Name
        provider    = 'Backblaze B2'
        location    = 'restic-' + $Name
        count       = $list.Count
        oldest      = $oldest
        newest      = $newest
        storedBytes = $StoredBytes
        listMs      = $ListMs
        retries     = $Retries
        points      = @($points)
        paths       = @($paths)
    }
}

# ---------------------------------------------------------------------------
# Writing: atomic, UTF-8 without BOM. A part that could not be read this time
# ($null, or a set that is missing) is kept from the previous file.
# ---------------------------------------------------------------------------
function Write-PanelStatus([string]$StatusDir, [string]$FileName, $Data) {
    $path = Join-Path $StatusDir $FileName
    $old = $null
    if (Test-Path -LiteralPath $path) {
        try { $old = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($path)) } catch { $old = $null }
    }
    if ($null -ne $old) {
        $names = @($old.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($k in @($Data.Keys)) {
            if ($null -eq $Data[$k] -and $names -contains $k) { $Data[$k] = $old.$k }
        }
        if ($null -ne $Data['sets'] -and $names -contains 'sets') {
            $have = @(@($Data['sets']) | ForEach-Object { [string]$_.id })
            $merged = New-Object System.Collections.ArrayList
            foreach ($s in @($Data['sets'])) { [void]$merged.Add($s) }
            foreach ($s in @($old.sets)) {
                if ($null -ne $s -and $have -notcontains [string]$s.id) {
                    $s | Add-Member -NotePropertyName fromEarlierCheck -NotePropertyValue $true -Force
                    [void]$merged.Add($s)
                }
            }
            $Data['sets'] = @($merged)
        }
    }
    $json = ConvertTo-Json -InputObject $Data -Depth 8
    $tmp = $path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function New-PanelSummary([string]$Kind, $Problems) {
    return [ordered]@{
        schema    = 1
        kind      = $Kind
        checkedAt = (ConvertTo-PanelUtc (Get-Date))
        check     = (ConvertTo-PanelProblems $Problems)
        sets      = $null
        coverage  = $null
        drive     = $null
        notes     = @()
    }
}

# ---------------------------------------------------------------------------
# The three entry points. Each one never throws.
# ---------------------------------------------------------------------------
function Save-PanelPgSummary($Problems, [string]$Remote, [string]$StatusDir) {
    try {
        $s = New-PanelSummary 'pg' $Problems
        $notes = New-Object System.Collections.ArrayList
        $newest = @()
        try { $s.sets = @(Get-PanelDriveSet 'pg' $Remote ([ref]$newest)) } catch { [void]$notes.Add($_.Exception.Message) }
        try { $s.drive = Get-PanelDriveSpace $Remote } catch { [void]$notes.Add('rclone about: ' + $_.Exception.Message) }
        try {
            $q = Invoke-Psql 'postgres' @('-tA', '-c', 'select datname from pg_database where not datistemplate and datallowconn order by 1')
            if ($q.Code -eq 0) { $s.coverage = Get-PanelDbCoverage @($q.Lines) $newest '.dump' }
            else { [void]$notes.Add('could not list the Postgres databases') }
        } catch { [void]$notes.Add('psql: ' + $_.Exception.Message) }
        $s.notes = @($notes)
        Write-PanelStatus $StatusDir 'pg-snapshots.json' $s
    } catch { Write-PanelStatusNote $_.Exception.Message }
}

function Save-PanelMongoSummary($Problems, [string]$Remote, [string]$StatusDir, $Last) {
    try {
        $s = New-PanelSummary 'mongo' $Problems
        $notes = New-Object System.Collections.ArrayList
        $newest = @()
        try { $s.sets = @(Get-PanelDriveSet 'mongo' $Remote ([ref]$newest)) } catch { [void]$notes.Add($_.Exception.Message) }
        if ($null -ne $Last -and $null -ne $Last.databases) {
            # mongodump writes every database into one archive, so all of them are in it.
            $s.coverage = Get-PanelDbCoverage @($Last.databases | ForEach-Object { [string]$_ }) $newest ''
        }
        $s.notes = @($notes)
        Write-PanelStatus $StatusDir 'mongo-snapshots.json' $s
    } catch { Write-PanelStatusNote $_.Exception.Message }
}

# $Sets: hashtable set name -> @{ Snaps = <restic snapshots>; Stored = <bytes in Backblaze> }
function Save-PanelFilesSummary($Problems, $Sets, [string]$StatusDir) {
    try {
        $s = New-PanelSummary 'files' $Problems
        $list = New-Object System.Collections.ArrayList
        foreach ($name in @($Sets.Keys | Sort-Object)) {
            try { [void]$list.Add((New-PanelResticSet $name $Sets[$name].Snaps ([double]$Sets[$name].Stored) $Sets[$name].Ms $Sets[$name].Retries)) }
            catch { $s.notes = @($s.notes) + @("[$name] " + $_.Exception.Message) }
        }
        if ($list.Count -gt 0) { $s.sets = @($list) }
        Write-PanelStatus $StatusDir 'files-snapshots.json' $s
    } catch { Write-PanelStatusNote $_.Exception.Message }
}
