# Backup panel: setup guide

Everything happens **on the server** (logged in over RDP as Administrator, the user
that runs the backup tasks), except creating one DNS record. Each step says why and
what you should see. It takes about 45 minutes. Nothing here changes your backup
scripts, the syslog collector or the routers, and nothing deletes anything.

## How it works (one minute)

- **The panel app** is a small Node.js program run by PM2, like your other apps. It
  listens **only on 127.0.0.1:7480**, so it can't be reached from outside directly.
  Nginx gives it a public HTTPS address such as `https://backups.yourdomain.com`.
- **The login** is your password plus a 6-digit code from an authenticator app.
  After 5 wrong tries from one address, sign-in pauses for 15 minutes.
- **The agent** is a PowerShell script that Task Scheduler runs every minute. It reads
  the backup status files, log ends, scheduled tasks and disk space, blanks anything
  that looks like a password or key, and sends that to the panel app on 127.0.0.1.
- **Run-now buttons** (off at first). Clicking one stores a request in the panel app.
  On its next run the agent collects it and starts the matching scheduled task. Only
  six tasks can ever be started: the three backups and the three checks. The list is
  written into the agent script itself, so nothing on the panel can add to it. The panel
  app itself cannot start any program, restore or delete anything.
- **One limit to know:** the panel runs on the server it watches. If the server is
  down, the panel is down too. Your existing morning check e-mails remain the alarm
  for that.

The panel uses these places on the server:

| Path | What |
|---|---|
| `C:\Apps\db-backup\panel\` | a git clone of this repository; the panel app runs from here |
| `C:\Apps\db-backup\panel\panel.config.json` | your panel settings (made from `panel.config.example.json`, never committed) |
| `C:\Apps\db-backup\panel-agent.ps1`, `panel-agent-setup.ps1`, `panel-agent.config.psd1` | the agent |
| `C:\Apps\db-backup\panel-data\state.json` | the panel's data (created automatically) |
| `C:\Apps\db-backup\secrets\panel-login.json` | password hash and authenticator key |
| `C:\Apps\db-backup\secrets\panel-agent-token.*` | the agent token (DPAPI) and its fingerprint |

The `secrets` folder is already left out of the file backups.

---

## Part 1: Check what the server has

Open PowerShell on the server:

```
node --version
pm2 --version
git --version
```

- **Node** must be **v18.17 or newer**. If it's older, don't upgrade it for the whole
  server without checking your other PM2 apps first. A separate newer Node can run this
  app alone: add `--interpreter "C:\path\to\newer\node.exe"` to the `pm2 start` line in Part 4.
- **PM2:** any recent version is fine.
- **Git:** if `git --version` isn't recognised, install Git for Windows first.

The panel needs no `npm install`: it has no dependencies.

## Part 2: Get the code with git

1. Clone the repository into `C:\Apps\db-backup\panel` (a new folder, so nothing existing
   is touched). The panel lives on the `user/ayush` branch until it's merged into `main`:
   ```
   cd C:\Apps\db-backup
   git clone --branch user/ayush https://github.com/administrator-cpu/backup-monitor-panel.git panel
   ```
   If the repository is private, Git asks you to sign in to GitHub the first time. On a
   production server, a read-only token or deploy key for just this repository is
   safer than your full account.

2. Create your settings file from the template:
   ```
   cd C:\Apps\db-backup\panel
   copy panel.config.example.json panel.config.json
   ```
   `panel.config.json` is never committed, so `git pull` never overwrites your settings.

3. Copy the agent next to the backup scripts:
   ```
   copy agent\panel-agent.ps1 ..\
   copy agent\panel-agent-setup.ps1 ..\
   copy agent\panel-agent.config.psd1 ..\
   ```
   These are new names in `C:\Apps\db-backup`, so nothing existing is overwritten.

## Part 3: Set your password and authenticator

```
cd C:\Apps\db-backup\panel
npm run setup-login
```

1. Type a password of at least 12 characters, twice. A few random words work well.
   Nothing is shown while you type.
2. It prints a **Key**. Add it to an authenticator app on your phone. **No account or
   sign-in is needed**: the key is the whole secret, and nothing is sent anywhere.
   - **Google Authenticator:** **+ > Enter a setup key**.
   - **Microsoft Authenticator:** **+ > Other account (Google, Facebook, etc.) > Enter code
     manually**. Don't pick "Personal" or "Work or school"; those are for Microsoft accounts.

   Name it `Backups panel`, type the key (spaces don't matter), and keep **Time based**.
   Each run of `setup-login` makes a **new** key, so first delete any older
   "Backups panel" entry in the app.
3. Type the 6-digit code the app shows. You should see
   `Saved. Restart the panel so old sessions end`, and the command finishes.

If a code is refused, the script says why and lets you try the next code with the same key:
- **"does not come from the key shown above"**: the app has a different key. This is usually
  an entry from an earlier run, or "Personal" / "Work or school" chosen in Microsoft
  Authenticator. Delete the entry and add the key again.
- **"the clocks differ by about ..."**: the key is right but a clock is off. If it says
  5 h 30 min, one clock shows India time while its time zone says UTC. Check `Get-TimeZone` and
  the clock on the server, and set the phone to automatic date, time and time zone.

Later, to change only the password: `npm run setup-login -- --password`.

## Part 4: Start the panel with PM2

```
cd C:\Apps\db-backup\panel
pm2 start src\server.js --name backup-panel
pm2 save
```

- `pm2 logs backup-panel --lines 5` should show two lines:
  `Starting backup panel (Node v…, config …)` and then
  `Backup panel listening on http://127.0.0.1:7480 (Run-now off, login set up)`.
  If it shows `Could not start: …` instead (in the error log), that line says what to fix.
- `pm2 save` keeps it in the list PM2 brings back after a reboot, the same way as
  your other apps.

Try it **inside RDP**: open a browser on the server at `http://127.0.0.1:7480`. You
should get the sign-in page. Sign in, and the panel says **"Waiting for the first report
from the agent."** That's correct for now.

## Part 5: Install the agent

1. Look at what the agent can see. Nothing is sent yet:
   ```
   cd C:\Apps\db-backup
   .\panel-agent.ps1 -Discover
   ```
   You should see:
   - all six scheduled tasks marked `[found]`
   - the files in `status\`, each with `card=pg`, `card=mongo` or `card=files`
   - the three backup logs with `found=True`
   - your disks

   If a status file says `(no card ...)`, its name doesn't match the expected pattern:
   add it under `Jobs` in `panel-agent.config.psd1` (examples are in the comments there).
   If a task says `[MISSING]`, its name in Task Scheduler differs from the list at the top
   of `panel-agent.ps1` (`$AllowedActions`); the names must match exactly.

2. Create the agent token:
   ```
   .\panel-agent-setup.ps1 -NewToken
   ```
   It saves the token with Windows DPAPI and writes its fingerprint to
   `secrets\panel-agent-token.sha256`. The panel reads that file by itself, so there's
   nothing to copy.

3. Send one report by hand:
   ```
   .\panel-agent.ps1 -Verbose
   ```
   The last line should be `VERBOSE: Report sent.` Refresh the panel in the RDP browser:
   the backups appear.

4. Make it run every minute:
   ```
   .\panel-agent-setup.ps1 -InstallTask
   ```
   It asks for the Windows password of the user you're logged in as, which Task
   Scheduler needs to run the task when nobody is logged on. You should see
   `Task 'Backup Panel Agent' created.`

5. Two minutes later:
   ```
   .\panel-agent-setup.ps1 -Status
   ```
   You should see `result=0x0` and `ok=True`.

> **When you change the Administrator password** (still on the security list), re-run
> `.\panel-agent-setup.ps1 -InstallTask -Force` with the new password. Every other task
> that runs as Administrator with a saved password needs the same update.

## Part 6: Publish it with HTTPS through Nginx

This uses the same method as your other sites: win-acme with http validation through
`C:\nginx-1.30.2\html\acme`, and PEM files in `C:\nginx-1.30.2\ssl`.

**Why the order matters:** Let's Encrypt only issues the certificate after it can fetch a
check file from the new name on port 80. Nginx refuses to load an HTTPS block whose
certificate files don't exist yet. So first add a port-80-only block, then get the
certificate, then switch to the full file. Before each reload, `nginx -t` checks the new
config; if it fails, nothing changes and your other sites keep running.

Do all of Part 6 in **one PowerShell window**. Step 2 sets `$name`, and the later steps use
it. If you open a new window, run the `$name = ...` line again.

### Step 1: DNS (at your domain provider)

Create an **A record**: name `backups` (or what you choose), value = the server's public IP
(the same one your other sites use). If the domain's DNS is on Cloudflare, set it to
**DNS only** (grey cloud). From your PC, wait until this shows that IP:
```
nslookup backups.yourdomain.com 8.8.8.8
```

### Step 2: Port 80 only (server)

This step changes nothing for your other sites:
- it keeps a copy of today's `nginx.conf` (only the first time, so running it again never
  overwrites the good copy);
- it writes a **new, separate file** `conf\backup-panel.conf` with only the new name in it;
- you then add **one line** to `nginx.conf` that loads that file.

First make sure the server has the latest files. The next command must print `True`:
```
cd C:\Apps\db-backup\panel
git pull
Test-Path deploy\nginx-backup-panel.http-only.conf
```
Then:
```
$name = 'backups.yourdomain.com'
cd C:\nginx-1.30.2
if (-not (Test-Path conf\nginx.conf.before-backup-panel)) { Copy-Item conf\nginx.conf conf\nginx.conf.before-backup-panel }
(Get-Content C:\Apps\db-backup\panel\deploy\nginx-backup-panel.http-only.conf -Raw).Replace('backups.example.com', $name) | Set-Content conf\backup-panel.conf -Encoding ASCII
Get-Content conf\backup-panel.conf
```
The last command shows the file with your name in it. The copy of `nginx.conf` is your
way back (see the end of this part).

Open `C:\nginx-1.30.2\conf\nginx.conf` in Notepad. Go to the **very last line**, which is a
single `}` that closes the `http { }` block. On a new line just **above** it, add:
```
    include C:/nginx-1.30.2/conf/backup-panel.conf;
```
It must go at the **end**, after all your other sites. Nginx treats the first site listed
for a port as the default for unknown names, so at the end the new name can never stand in
for another site.

*Prefer to paste the blocks straight into `nginx.conf` instead of using a separate file?*
That works the same. Paste the contents of `conf\backup-panel.conf` (from the commands above,
with your name already filled in) at the same place: just above the last `}`. In Step 5,
replace that pasted part with the full version. The separate file is suggested only because
`nginx.conf` then changes by one line, which is easier to check and to undo.
Save, then test and reload:
```
.\nginx.exe -t
```
You should see `syntax is ok` and `test is successful` (in red on Windows; that's normal).
Only then:
```
.\nginx.exe -s reload
```

### Step 3: Check that Let's Encrypt will reach the name (server, then PC)

```
New-Item -ItemType Directory -Force html\acme\.well-known\acme-challenge | Out-Null
Set-Content html\acme\.well-known\acme-challenge\panel-test.txt 'panel test ok' -Encoding ASCII
```
On your **PC**, open `http://backups.yourdomain.com/.well-known/acme-challenge/panel-test.txt`
in a browser. It must show `panel test ok`. If it doesn't, don't go on: Let's Encrypt
blocks a name for an hour after five failed tries. Then remove the test file:
```
Remove-Item html\acme\.well-known\acme-challenge\panel-test.txt
```

### Step 4: Create the certificate (server)

One command, with every answer given, so there are no menus:
```
C:\win-acme\wacs.exe --source manual --host $name --validation filesystem --webroot C:\nginx-1.30.2\html\acme --store pemfiles --pemfilespath C:\nginx-1.30.2\ssl --installation none --accepttos
```
It should end with `Authorization result: valid`, a line about exporting `.pem` files to
`C:\nginx-1.30.2\ssl`, and `Adding renewal for ...`. The existing "win-acme renew" task
renews it like the others. Check the files:
```
Get-ChildItem C:\nginx-1.30.2\ssl\$name*
```
You should see four files: `-chain.pem`, `-chain-only.pem`, `-crt.pem`, `-key.pem`.

### Step 5: Switch to the full file (server)

```
(Get-Content C:\Apps\db-backup\panel\deploy\nginx-backup-panel.conf -Raw).Replace('backups.example.com', $name) | Set-Content conf\backup-panel.conf -Encoding ASCII
.\nginx.exe -t
```
Again `syntax is ok` and `test is successful`, then:
```
.\nginx.exe -s reload
```

### Step 6: Try it (PC or phone)

- `https://backups.yourdomain.com` shows the sign-in page with a valid padlock.
- `http://backups.yourdomain.com` goes to the https address by itself.
- `https://backups.yourdomain.com/api/agent/report` shows a 404 page. That's intended: the
  agent's address is never public.

Port 443 is already open for your other sites. Port 7480 is not opened anywhere, because
the app only listens on 127.0.0.1. The Nginx file also limits sign-in attempts and keeps its
own log (`logs\backup-panel.access.log`), so it doesn't add to the big `access.log`.

**To undo Part 6 at any point:**
```
cd C:\nginx-1.30.2
Copy-Item conf\nginx.conf.before-backup-panel conf\nginx.conf -Force
.\nginx.exe -t
.\nginx.exe -s reload
```
This puts `nginx.conf` back exactly as it was. `conf\backup-panel.conf` is then no longer
used, and can stay or go.

## Part 7 (optional): Backblaze size and cost

Why: so the panel shows how big the B2 bucket is and roughly what it costs. The agent
uses a separate **read-only** key and never the restic password, so it can count the
files but can't read inside the backups, change them or delete them.

1. On the Backblaze website: **App Keys > Add a New Application Key**, name it
   `panel-readonly`, choose bucket **windows-vps-vault**, and set **Type of Access: Read Only**.
   Copy the keyID and applicationKey (shown once).
2. On the server:
   ```
   .\panel-agent-setup.ps1 -SetBackblazeKey
   ```
   You should see `Key works. Bucket: windows-vps-vault  Capabilities: ...` and then `Saved`.
   The script refuses any key that can write or delete.
3. In `panel-agent.config.psd1`, set `Enabled = $true` under `Backblaze`. Within a minute
   the Backblaze card shows the size. It checks again every 12 hours.

## Part 8: Switch on the Run-now buttons (after a few days read-only)

Both switches must be on. Either one alone keeps the buttons off.

1. **Agent:** in `C:\Apps\db-backup\panel-agent.config.psd1` set `CommandsEnabled = $true`.
   If you never want the long file backup to be startable from the web, also set
   `DisabledActions = @('run-files-backup')`.
2. **Panel:** in `C:\Apps\db-backup\panel\panel.config.json` set `"commandsEnabled": true`,
   then:
   ```
   pm2 restart backup-panel
   ```
3. Sign in again; restarting the panel ends sessions. The header now shows **Run-now on**.
   Test with **Run check** on the Postgres row, which is harmless. The history should go
   from `Queued` to `With agent` to `Started` within about a minute.

Good to know:
- A started task runs exactly like the nightly one: same script, same user, same e-mails.
- A request the agent hasn't collected within 15 minutes expires and never runs later.
  A task that's already running is never started a second time. At most 10 requests per hour.
- On Sundays the file backup also does its weekly prune and check, which take much longer.

## Part 9: Switching things off

| You want to | Do this |
|---|---|
| Stop the agent (no reports, no buttons) | `.\panel-agent-setup.ps1 -Disable`, or disable "Backup Panel Agent" in Task Scheduler. After 10 minutes the panel shows "The agent stopped reporting"; that's expected. `-Enable` turns it back on. |
| Keep the status, stop the buttons | `CommandsEnabled = $false` in the agent config, or `"commandsEnabled": false` in `panel.config.json` and `pm2 restart backup-panel`. |
| Take the panel off the internet | Remove the `include` line from `nginx.conf`, then `.\nginx.exe -t` and `.\nginx.exe -s reload`. It still works inside RDP at `http://127.0.0.1:7480`. |
| Stop the panel completely | `pm2 stop backup-panel` (and `pm2 save`). |
| Sign everyone out | `pm2 restart backup-panel`. |
| Lost your phone | Run `npm run setup-login` again: new password and new authenticator key. Then `pm2 restart backup-panel`. |
| Replace the agent token | `.\panel-agent-setup.ps1 -NewToken -Force`. The panel picks up the new fingerprint by itself. |

## Updating later

```
cd C:\Apps\db-backup\panel
git pull
copy agent\panel-agent.ps1 ..\
copy agent\panel-agent-setup.ps1 ..\
pm2 restart backup-panel
```

Your settings stay as they are: `panel.config.json` isn't in git, and
`panel-agent.config.psd1` isn't copied again. If a new release adds a setting, the release
notes say so. Restarting the panel signs you out.

## What the agent sends, and what it never sends

**Sends (to 127.0.0.1 only):** for the six tasks, their state, last and next run time and
result code; the contents of `status\*.json`, with any field whose name looks like a password,
key or token replaced by `(hidden)`; the last 40 lines of the three backup logs and its own log,
with passwords, keys and `user:password@` in addresses blanked; disk sizes; Backblaze byte
and file counts.

**Never sends:** anything from `secrets\`, environment variables, the restic password, database
contents or router syslog contents. Run `.\panel-agent.ps1 -DryRun` at any time to see the
exact report.

## Troubleshooting

| You see | Meaning and fix |
|---|---|
| `pm2 logs backup-panel`: "Could not start: ... EADDRINUSE" | Something else uses port 7480. Pick another free port in `panel.config.json` **and** the same in `PanelUrl` in `panel-agent.config.psd1`. |
| `pm2 logs`: "Unknown setting(s) in panel.config.json" | Typo in that file; the message names it. |
| Sign-in page: "The login is not set up yet" | Run Part 3. |
| Sign-in page: "Too many wrong attempts" | Wait 15 minutes, or `pm2 restart backup-panel`. |
| A code is always refused | The server clock is off. Check Windows time sync, and that the phone's time is automatic. |
| Agent log: "could not reach http://127.0.0.1:7480. Is the backup-panel app running" | `pm2 status`; start it (Part 4). |
| Agent log: "refused the agent token (401)" | Run `.\panel-agent-setup.ps1 -ShowTokenHash`, which writes the fingerprint file again. |
| Agent log: "forbidden (403): the panel only accepts the agent on 127.0.0.1" | `PanelUrl` must be `http://127.0.0.1:7480`, not the public address. |
| Browser: 502 Bad Gateway | Nginx can't reach the app: `pm2 status`, and check the port in the Nginx file matches `panel.config.json`. |
| `-Discover`: "present but cannot be opened by ..." | The secret file was made by a different Windows user. Run the setup command again as the user the task runs as. |
| A card says "Task missing" | The scheduled task's name differs from the list in `$AllowedActions` at the top of `panel-agent.ps1`. Compare with `.\panel-agent.ps1 -Discover` and Task Scheduler. |
| `pm2 logs`: "panel.config.json not found" | Part 2, step 2: copy `panel.config.example.json` to `panel.config.json`. |
| `pm2 logs backup-panel` shows nothing at all, and `http://127.0.0.1:7480` does not open | The code is older than the PM2 fix. Run `git pull`, then `pm2 restart backup-panel`. |

Logs: the panel's are in `pm2 logs backup-panel` (start-up, sign-ins, failed sign-ins,
Run-now requests). The agent's are in `C:\Apps\db-backup\logs\panel-agent.log` (errors,
every Run-now request and what happened to it, and an hourly heartbeat).
