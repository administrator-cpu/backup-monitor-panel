// The only commands the panel can queue. The server agent has its own copy of
// this list (agent/panel-agent.ps1) and refuses anything else; both must agree.
export const ACTIONS = Object.freeze([
  { id: 'run-pg-backup', job: 'pg', kind: 'backup', label: 'Run Postgres backup now', task: 'Postgres Nightly Backup' },
  { id: 'run-pg-check', job: 'pg', kind: 'check', label: 'Run Postgres check now', task: 'Postgres Backup Check' },
  { id: 'run-mongo-backup', job: 'mongo', kind: 'backup', label: 'Run MongoDB backup now', task: 'MongoDB Nightly Backup' },
  { id: 'run-mongo-check', job: 'mongo', kind: 'check', label: 'Run MongoDB check now', task: 'MongoDB Backup Check' },
  { id: 'run-files-backup', job: 'files', kind: 'backup', label: 'Run file backup now', task: 'Files Nightly Backup' },
  { id: 'run-files-check', job: 'files', kind: 'check', label: 'Run file backup check now', task: 'Files Backup Check' },
]);

export const ACTION_IDS = Object.freeze(ACTIONS.map((a) => a.id));

export function findAction(id) {
  if (typeof id !== 'string') return null;
  return ACTIONS.find((a) => a.id === id) || null;
}

// How long a queued command waits for the server before it expires, and how
// long the panel waits for the server to say what it did.
export const COMMAND_PICKUP_MINUTES = 15;
export const COMMAND_REPLY_MINUTES = 15;
export const MAX_COMMANDS_PER_HOUR = 10;
