# backup-monitor-panel

A private control panel for the server's backups (Postgres, MongoDB, and restic file
and log backups to Backblaze B2). It runs **on the server** as a small Node.js app on
127.0.0.1, published over HTTPS by Nginx, with password + authenticator sign-in. A
PowerShell agent run by Task Scheduler feeds it, and it is the only part that can start
anything.

**To install it, follow [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md).**

## Layout

| Path | What it is |
|---|---|
| `agent/panel-agent.ps1` | The agent (Windows PowerShell 5.1, ASCII only). Every minute: collect, redact, POST to 127.0.0.1, run allowlisted commands. |
| `agent/panel-agent-setup.ps1` | One-time setup on the server: agent token (DPAPI) and fingerprint, read-only Backblaze key, scheduled task, status, kill switch. |
| `agent/panel-agent.config.psd1` | Agent settings (data only). Ships read-only (`CommandsEnabled = $false`). |
| `agent/tests/run-agent-tests.ps1` | Agent tests. Fake Task Scheduler hooks; never touches real tasks. |
| `src/server.js` | Entry point: HTTP server on 127.0.0.1, hourly housekeeping. |
| `src/app.js` | Routes: agent API (loopback only, Bearer token), sign-in, page API. |
| `src/auth.js` | scrypt passwords, TOTP (RFC 6238), sessions, lockouts, agent token check. |
| `src/store.js` | All data in one JSON file, written atomically. |
| `src/setup-login.js` | `npm run setup-login`: sets the password and authenticator key. |
| `src/actions.js` | The six Run-now actions (the agent has its own copy and checks it). |
| `public/` | The page: plain ES modules, no build step, strict CSP, server data always rendered as text. |
| `public/js/health.js` | Every judgement the page makes (job status, summary sentence, button availability, disk forecast). Pure, so it's unit-tested. |
| `public/fonts/` | IBM Plex Sans and Mono (SIL Open Font License, see `OFL.txt`), served locally. |
| `panel.config.example.json` | Panel settings template. On the server it is copied to `panel.config.json` (git-ignored, so `git pull` never touches your settings). |
| `deploy/nginx-backup-panel.conf` | Nginx template: HTTPS, agent API blocked, sign-in rate limit. |
| `test/` | Node tests (`node --test`): API, Run-now flow, sign-in, the real HTTP server. |

No npm dependencies: nothing to install, and `npm audit` has nothing to report.

## Security model

- **Two separate pieces.** The web app stores and shows data and queues requests. It
  contains no code that starts programs. The agent runs as a scheduled task and starts
  only one of six fixed scheduled tasks; the list is hard-coded and checked
  case-sensitively. Commands also need a well-formed id, must be under 15 minutes old,
  are never run twice, and are refused while the task is running.
- **Not directly reachable.** The app binds to 127.0.0.1. Nginx terminates HTTPS. The
  agent API refuses anything relayed by Nginx or coming from another machine.
- **Sign-in.** Password (scrypt) plus TOTP. A code can be used once. Each address is
  locked for 15 minutes after 5 failures, and everyone after 20. Sessions are 12 hours,
  held in memory, with an HttpOnly, SameSite=Strict, `__Host-` Secure cookie. Each POST
  needs a custom header, the same origin and JSON. The page shows recent sign-ins and
  failed attempts.
- **No secrets leave the agent.** Secret-looking status keys are replaced, and log lines
  are scrubbed for passwords, keys, bearer tokens and `user:password@` URLs. The Backblaze
  check uses a separate read-only key.
- **Two switches for buttons.** `CommandsEnabled` in the agent config and
  `commandsEnabled` in `panel.config.json` must both be on.

## Development (on a PC)

```
node dev/seed-dev-login.js     # dev-only login + agent fingerprint in .dev-data/
npm run dev                    # http://127.0.0.1:8787
node dev/dev-code.js           # current dev authenticator code
npm test                       # Node tests
npm run test:agent             # agent tests (Windows PowerShell 5.1)
```

The dev password is in `dev/seed-dev-login.js`. It works only with the dev config and
must never be used on the server.
