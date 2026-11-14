# Backup panel: setup guide

Everything happens **on the server** (logged in over RDP as Administrator, the user
that runs the backup tasks), except creating one DNS record. Each step says why and
what you should see. It takes about 45 minutes. Only Part 11 touches your backup
scripts: it adds a few lines to the three morning checks, after keeping a copy of them.
Nothing here changes the backups themselves, the syslog collector or the routers, and
nothing deletes anything.

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
  down, the panel is down too. That's why Part 10 adds an outside "I'm alive" check
  (free) that e-mails you when the server goes quiet.
- **Two doors:** strangers first meet a gate page that wants a gate key (Part 12), and
  only then the panel's own sign-in with password and authenticator code.

The panel uses these places on the server:

| Path | What |
|---|---|
| `C:\Apps\db-backup\panel\` | a git clone of this repository; the panel app runs from here |
| `C:\Apps\db-backup\panel\panel.config.json` | your panel settings (made from `panel.config.example.json`, never committed) |
| `C:\Apps\db-backup\panel-agent.ps1`, `panel-agent-setup.ps1`, `panel-agent.config.psd1` | the agent |
| `C:\Apps\db-backup\panel-data\state.json` | the panel's data (created automatically) |
| `C:\Apps\db-backup\secrets\panel-login.json` | password hash and authenticator key |
| `C:\Apps\db-backup\secrets\panel-agent-token.*` | the agent token (DPAPI) and its fingerprint |
| `C:\Apps\db-backup\secrets\panel-heartbeat-url.clixml` | the outside alert's ping address (DPAPI, Part 10) |
| `C:\Apps\db-backup\panel-status.ps1` | helper the morning checks use to list restore points (Part 11) |
| `C:\Apps\db-backup\status\*-snapshots.json` | the restore-point lists those checks write |
| `C:\nginx-1.30.2\conf\backup-panel-gate.conf` | the gate key Nginx checks (Part 12) |
| `C:\Apps\db-backup\logs\nginx-reload.log` | what the certificate reload task did (Part 13) |
| `C:\Apps\db-backup\logs\nginx-rotate.log` | what the Nginx log rotation did (Part 14) |

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
Put **your real name** (the one you created in DNS in Step 1) between the quotes. Don't use
the example `backups.yourdomain.com`: `yourdomain.com` is someone else's real website.
```
$name = 'backups.yourdomain.com'
Resolve-DnsName $name -Type A | Select-Object Name, IPAddress
```
The `IPAddress` must be **your server's public IP**. If you get an error or a different IP,
stop: either the name in `$name` is wrong, or the DNS record isn't there yet. Then:
```
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

Save, then test and reload:
```
.\nginx.exe -t
```
You should see `syntax is ok` and `test is successful` (in red on Windows; that's normal).
Only then:
```
.\nginx.exe -s reload
```

*Prefer to paste the blocks straight into `nginx.conf` instead of using a separate file?*
That works the same. Paste the contents of `conf\backup-panel.conf` (from the commands above,
with your name already filled in) at the same place: just above the last `}`. In Step 5,
replace that pasted part with the full version. The separate file is suggested only because
`nginx.conf` then changes by one line, which is easier to check and to undo.

### Step 3: Check that Let's Encrypt will reach the name (server, then PC)

```
New-Item -ItemType Directory -Force html\acme\.well-known\acme-challenge | Out-Null
Set-Content html\acme\.well-known\acme-challenge\panel-test.txt 'panel test ok' -Encoding ASCII
"Open this on your PC:  http://$name/.well-known/acme-challenge/panel-test.txt"
```
The last line prints the exact address with your name in it. Open **that** address in a
browser on your PC. It must show `panel test ok`. If it doesn't, don't go on: Let's Encrypt
blocks a name for an hour after five failed tries. (A page from a firewall such as Sucuri or
Cloudflare means the address isn't reaching your server; check the name and its DNS record.)
Then remove the test file:
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

The full file also puts the gate page in front of the sign-in, so make the gate key
first (it prints the key once; save it in your password manager, see Part 12):
```
powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\set-gate-key.ps1
```
Then:
```
(Get-Content C:\Apps\db-backup\panel\deploy\nginx-backup-panel.conf -Raw).Replace('backups.example.com', $name) | Set-Content conf\backup-panel.conf -Encoding ASCII
.\nginx.exe -t
```
Again `syntax is ok` and `test is successful`, then:
```
.\nginx.exe -s reload
```

### Step 6: Try it (PC or phone)

On the server, print the addresses with your name in them:
```
"https://$name"; "http://$name"; "https://$name/api/agent/report"
```
- The first shows the gate page with a valid padlock; after the gate key, the sign-in page.
- The second goes to the https address by itself.
- The third shows a 404 page. That's intended: the agent's address is never public.

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
| Pause the outside alert (planned maintenance) | On healthchecks.io, open the check and click **Pause**. It wakes up by itself with the next ping. To stop the pings for good: `Heartbeat = @{ Enabled = $false }` in `panel-agent.config.psd1`. |
| Lock out a lost laptop or phone | Make a new gate key (Part 12, step 1, then `-t` and reload). Every device must enter the new key once. Also run `npm run setup-login` if the password may be known. |

## Part 10: Outside alert when the server goes quiet (free, no card)

Why: the panel lives on the server, so if the server dies, nothing on it can tell you.
After every report that reaches the panel, the agent opens a secret web address at
**healthchecks.io** (one tiny HTTPS request, no data at all). If those pings stop for
15 minutes (agent stopped, panel crashed or the whole server down), healthchecks.io
e-mails you, and again when it recovers. The free plan asks only for your e-mail
address; no credit card.

1. **On your PC:** go to `https://healthchecks.io`, choose **Sign Up**, enter your e-mail
   address and open the log-in link it sends you.
2. In your project, open the check that is already there (or **Add Check**). Name it
   `Backup server`. Click **Change Schedule** and set **Period: 5 minutes** and
   **Grace Time: 10 minutes**, then **Save**.
3. Copy the check's **Ping URL**. It looks like `https://hc-ping.com/` followed by a long
   code. Treat it like a password: anyone who has it can send fake "alive" pings.
4. Under **Integrations** your e-mail address is already listed. Add Telegram or others
   there if you like.
5. **On the server** (after `git pull` and copying the agent, see "Updating later"):
   ```
   cd C:\Apps\db-backup
   .\panel-agent-setup.ps1 -SetHeartbeatUrl
   ```
   Paste the Ping URL when asked. You should see `Ping accepted (HTTP 200)` and `Saved`, and
   the check on the website turns green. Nothing in `panel-agent.config.psd1` needs changing.
6. Within 5 minutes the panel's **Server agent** section shows `Outside alert: On · pinged ...`.

To try it: `.\panel-agent-setup.ps1 -Disable`, wait about 15 minutes for the "DOWN" e-mail,
then `.\panel-agent-setup.ps1 -Enable` and you get an "UP" e-mail a few minutes later.

## Part 11: Restore points (what you could restore from)

Why: so the panel lists every backup you can restore from, with its date, size and ID; shows
which databases and folders are covered; shows the 3-year log history; and shows how much
Google Drive space the backups use. Your three morning checks already see all of this. With
this part they also write it to small files in `status\` that the agent passes on, so neither
the agent nor the panel ever needs a backup password.

The three checks get a few extra lines, and a helper file `panel-status.ps1` next to them. The
new lines can't change what a check reports or e-mails: if anything in them goes wrong, it is
only written to the log as a warning.

1. Get the new files:
   ```
   cd C:\Apps\db-backup\panel
   git pull
   cd C:\Apps\db-backup
   ```
2. Check that your current check scripts are the ones the changes were made from:
   ```
   Get-FileHash pg-backup-check.ps1, mongo-backup-check.ps1, files-backup-check.ps1 | Select-Object @{n='File';e={Split-Path $_.Path -Leaf}}, Hash
   ```
   You should see exactly:
   ```
   pg-backup-check.ps1     77712D0A2EC1BFCA24F0AFCA960BB510ED4E8E370BFEE4BA335BB5FD9C0B186A
   mongo-backup-check.ps1  811BFC29C44C3799AEDFA2D0A7B11C8B562A38365C2E9770797115517B008CAF
   files-backup-check.ps1  63169614B42E925860234461CD79472EF16AF3185935A0C8AFC027794A649492
   ```
   **If any line differs, stop here:** that script was changed since, and copying would undo
   the change. Send the differing script instead.
3. Keep your current versions (only the first time), then copy the new ones and the helper:
   ```
   if (-not (Test-Path before-panel)) { New-Item -ItemType Directory before-panel | Out-Null; Copy-Item pg-backup-check.ps1, mongo-backup-check.ps1, files-backup-check.ps1 before-panel\ }
   Copy-Item panel\server-scripts\pg-backup-check.ps1, panel\server-scripts\mongo-backup-check.ps1, panel\server-scripts\files-backup-check.ps1, panel\server-scripts\panel-status.ps1 .\ -Force
   ```
4. Run the three checks once now, through Task Scheduler so they run as their usual user.
   They only e-mail if they find a problem, exactly as every morning:
   ```
   Start-ScheduledTask -TaskName 'Postgres Backup Check'
   Start-ScheduledTask -TaskName 'MongoDB Backup Check'
   Start-ScheduledTask -TaskName 'Files Backup Check'
   ```
5. A few minutes later:
   ```
   Get-ChildItem status\*-snapshots.json
   ```
   You should see `pg-snapshots.json`, `mongo-snapshots.json` and `files-snapshots.json`.
   The panel now shows **Restore points**, **What is backed up** and a **Google Drive** card.

To undo: `Copy-Item before-panel\*.ps1 .\ -Force`. The helper and the `*-snapshots.json`
files then simply stop being updated.

**Update the three checks to v1.2 (once, if you did Part 11 before 15 Nov 2026).** It fixes two
false alarms:
- **Files check:** "check failed: Invalid JSON primitive: Load" (12 Nov). When Backblaze is slow,
  restic prints "retrying" lines next to its list, and v1.1 read those as part of the list.
  v1.2 reads only the list, logs the retries as a warning, and tells the panel how long the
  listing took.
- **Postgres and MongoDB checks:** "Today's snapshot is not in Google Drive ... directory not
  found" when a check runs between midnight and the night's backup (14 Nov, 00:18). Before
  04:00, v1.2 checks last night's snapshot. The e-mail now says when the check ran.

```
cd C:\Apps\db-backup
Get-FileHash pg-backup-check.ps1, mongo-backup-check.ps1, files-backup-check.ps1 | Select-Object @{n='File';e={Split-Path $_.Path -Leaf}}, Hash
```
They must show exactly (that is v1.1):
```
pg-backup-check.ps1     DBD9C9C1BB7DA1B7369F452A8E9AED90A08DD1B36BB58E0A36037694C8450EBF
mongo-backup-check.ps1  3ABC1D0B01E5F01B8A1B9ED077DC176D80DA41C64443DB7BDA396BA231650110
files-backup-check.ps1  67056CF68BC6EA7C5AB9CBC94D16F0183C8AE878BF1B4D6674A3820621F45E6E
```
A file that shows a different hash was changed since; leave that one and tell me. For the
matching ones, after `git pull`:
```
Copy-Item panel\server-scripts\pg-backup-check.ps1, panel\server-scripts\mongo-backup-check.ps1, panel\server-scripts\files-backup-check.ps1, panel\server-scripts\panel-status.ps1 .\ -Force
```
Your originals stay in `before-panel\` from step 3.

## Part 12: Gate page in front of the sign-in

Why: without it, anyone on the internet can reach the sign-in page and try passwords.
With it, Nginx itself turns strangers away unless their browser holds the **gate key**,
before anything reaches the panel app. It's a normal page in the panel's style, not the
browser's grey pop-up. A device remembers the key for 30 days.

1. **Make the gate key** (server):
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\set-gate-key.ps1
   ```
   It prints a key like `ABCDE-FGHJK-LMNPQ-RSTUV` **once**. Save it in your password
   manager. It writes `C:\nginx-1.30.2\conf\backup-panel-gate.conf`.
2. **Use the Nginx file with the gate.** If you use the `include` line, run the copy command
   from Part 6, step 5 again (with `$name` set as in Part 6, step 2). If you pasted the panel
   blocks into `nginx.conf`, replace everything you pasted for the panel with the new
   contents of `conf\backup-panel.conf` made by that command.
3. Test and reload:
   ```
   cd C:\nginx-1.30.2
   .\nginx.exe -t
   ```
   Only after `test is successful`:
   ```
   .\nginx.exe -s reload
   ```
4. **On your PC**, open `https://` plus your panel name. You see the **Private area** page.
   Enter the key and you get the usual sign-in. Your password manager can save the key.

To change the key (or lock out a lost device), repeat steps 1 and 3. The old key file is kept
as `backup-panel-gate.conf.previous`.

## Part 13: Reload Nginx after certificate renewals (all sites)

Why: win-acme renews your certificates into `C:\nginx-1.30.2\ssl`, but your renewals are set
up without an installation step, so nothing tells Nginx. Nginx only reads certificates when
it starts or reloads, so after a renewal it keeps serving the old certificate until something
restarts it, and when that old one expires browsers say "certificate expired". This applies
to **all** your sites, not only the panel.

The task checks twice a day whether any certificate file is newer than Nginx's last reload. If
so, it runs `nginx -t`, and **only if that passes** `nginx -s reload`, which drops no
connection. If the test fails, it reloads nothing and writes an ERROR line, so a mistake in
`nginx.conf` can never take the sites down.

1. Run one check by hand (server):
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\nginx-reload-on-renewal.ps1
   ```
   You should see either `No certificate changed since ...; nothing to do.` or
   `Renewed certificate(s) found: ...` followed by `Nginx reloaded`. The second is
   expected if certificates were renewed since Nginx last started.
2. Create the task (runs as SYSTEM every day at 10:30 and 22:30):
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\nginx-reload-on-renewal.ps1 -Install
   ```
3. Any time later:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\nginx-reload-on-renewal.ps1 -Status
   ```
   The panel also shows `nginx-reload.log` under **From the server > Log tails**.

## Part 14: Rotate the Nginx logs (all sites)

Why: Nginx on Windows never starts a new log file by itself; `access.log` had grown to about
10.6 GB. Once a week (Mondays 05:30) this task:
1. renames each log in `C:\nginx-1.30.2\logs` that is over 50 MB (for example
   `access.log` to `access-20261116-0530.log`);
2. runs `nginx -s reopen`, so Nginx starts fresh files. That is not a restart: no site goes down;
3. packs each renamed file into a `.gz`, usually 10 to 20 times smaller. It reads the `.gz` back
   to check it holds every byte, and **only then removes the unpacked renamed copy**. If anything
   doesn't match, it keeps both.

It never deletes `.gz` files. They stay in the logs folder until you delete them yourself.

1. Run it once by hand (server, PowerShell as Administrator). The first time it packs the big
   `access.log`, which takes a few minutes:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\rotate-nginx-logs.ps1
   ```
   You should see `Renamed access.log (10.6 GB) to ...`, `Nginx reopened its logs` and
   `Packed ...gz: 10.6 GB -> ...`. Logs under 50 MB are left alone.
2. Create the weekly task:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Apps\db-backup\panel\deploy\rotate-nginx-logs.ps1 -Install
   ```
3. Any time later, `-Status` shows the task, the biggest files in the logs folder and the
   end of `nginx-rotate.log`. The panel shows that log too.

## Updating later

```
cd C:\Apps\db-backup\panel
git pull
copy agent\panel-agent.ps1 ..\
copy agent\panel-agent-setup.ps1 ..\
copy server-scripts\panel-status.ps1 ..\
pm2 restart backup-panel
```

Your settings stay as they are: `panel.config.json` isn't in git, and
`panel-agent.config.psd1` isn't copied again. If a new release adds a setting, the release
notes say so. Restarting the panel signs you out. The gate page and the reload task are used
straight from this folder, so `git pull` updates them. The three check scripts are copied only
once (Part 11), never by an update.

## What the agent sends, and what it never sends

**Sends (to 127.0.0.1 only):** for the six tasks, their state, last and next run time and
result code; the contents of `status\*.json` (including the restore-point lists from Part 11),
with any field whose name looks like a password, key or token replaced by `(hidden)`; the last
40 lines of the three backup logs, the reload log and its own log, with passwords, keys and
`user:password@` in addresses blanked; disk sizes; Backblaze byte and file counts; whether the
outside alert is working.

**To the outside alert (Part 10):** only an empty HTTPS request to the ping address, every
5 minutes. No data.

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
| `nginx -t`: "open() ... backup-panel-gate.conf failed" | The gate key file isn't made yet: Part 12, step 1. |
| Gate page: "That key is not right." | Copy the key again from your password manager. Dashes, spaces and lower case don't matter. If the key was changed with `set-gate-key.ps1`, use the new one. |
| Gate page: "Too many tries" | Nginx allows 10 tries a minute per address. Wait a minute. |
| The gate page keeps coming back after the key worked | The browser blocks cookies for this site. Allow cookies for it. |
| `-SetHeartbeatUrl`: "Not saved: the service answered HTTP 404" | The Ping URL was copied incompletely. Copy it again from the check's page. |
| Panel: "Outside alert: Last ping failed" | The server can't reach healthchecks.io (internet or firewall). If it lasts more than 15 minutes, healthchecks.io e-mails you that the server is quiet. |
| Panel: "Restore points" says nothing from a check yet | Part 11 isn't done, or that check hasn't run since. Look for `Panel summary:` warnings in that backup's log. |
| `nginx-rotate.log`: "nginx -s reopen failed" | Nginx keeps writing into the renamed file, so nothing is lost. Run `.\nginx.exe -s reopen` in `C:\nginx-1.30.2` by hand. If it says it can't find the process, Nginx was started some other way; tell me what `Get-Process nginx` shows. |
| `nginx-rotate.log`: "... changed while packing, so it was left unpacked" | Nginx was still writing to it. The next run packs it. |
| Files check e-mail: "check failed: Invalid JSON primitive: Load" | Backblaze was slow and files-backup-check v1.1 misread restic's retry messages. Install v1.2 (Part 11, last step). |
| Postgres or MongoDB check e-mail: "Today's snapshot ... directory not found", with a time after midnight in the rclone line | The check ran before that night's backup existed (a v1.1 check started by hand after midnight). The backups are fine. Install v1.2 (Part 11, last step). |
| `nginx-reload.log`: "nginx -t failed, so Nginx was NOT reloaded" | `nginx.conf` has a mistake (the sites keep running on the old settings). Run `.\nginx.exe -t` in `C:\nginx-1.30.2` to see it, fix it, then run the reload script by hand. |

Logs: the panel's are in `pm2 logs backup-panel` (start-up, sign-ins, failed sign-ins,
Run-now requests). The agent's are in `C:\Apps\db-backup\logs\panel-agent.log` (errors,
every Run-now request and what happened to it, and an hourly heartbeat).
