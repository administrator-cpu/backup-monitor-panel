# panel-agent.config.psd1 - settings for panel-agent.ps1 (data only, no code).
# After any change, check it with:  .\panel-agent.ps1 -Discover
@{
    # The panel app on this server (see "port" in panel\panel.config.json).
    # Always 127.0.0.1: the agent talks to the app directly, never through Nginx.
    PanelUrl        = 'http://127.0.0.1:7480'

    # Folder that holds the backup scripts, status\ and logs\.
    BaseDir         = 'C:\Apps\db-backup'

    # Leave $false until the read-only panel works. Set $true to allow the
    # "Run now" buttons (panel.config.json must also have "commandsEnabled": true).
    CommandsEnabled = $false

    # Buttons you never want to work, even when CommandsEnabled is $true.
    # Possible values: run-pg-backup, run-pg-check, run-mongo-backup,
    # run-mongo-check, run-files-backup, run-files-check
    # Example: DisabledActions = @('run-files-backup')
    DisabledActions = @()

    # A disk shows a warning on the panel when free space drops below this.
    DiskWarnFreeGB  = 60

    # Optional per-card tuning. StatusPatterns pick which status\*.json files
    # belong to a card; MaxAgeHours is how old the last success may be before
    # the card turns red. Uncomment and edit only if -Discover shows a need.
    Jobs = @{
        # pg    = @{ StatusPatterns = @('pg-*', 'postgres*'); LogFile = 'pg-backup.log'; MaxAgeHours = 26 }
        # mongo = @{ StatusPatterns = @('mongo*'); LogFile = 'mongo-backup.log'; MaxAgeHours = 26 }
        # files = @{ StatusPatterns = @('files-*'); LogFile = 'files-backup.log'; MaxAgeHours = 26 }
    }

    # Backblaze bucket size and cost. Needs a separate READ-ONLY key:
    #   .\panel-agent-setup.ps1 -SetBackblazeKey   then set Enabled = $true
    Backblaze = @{
        Enabled         = $false
        Bucket          = 'windows-vps-vault'
        Prefixes        = @('restic-logs/', 'restic-files/')
        EveryHours      = 12
        PricePerTBMonth = 6.95
        FreeGB          = 10
    }
}
