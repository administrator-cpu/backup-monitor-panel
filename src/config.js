// Panel settings from panel.config.json. Paths may be absolute or relative
// to the config file. The listen address is fixed to 127.0.0.1 on purpose:
// the panel is only ever reached through Nginx or by the local agent.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const DEFAULTS = {
  port: 7480,
  commandsEnabled: false,
  timeZone: 'Asia/Kolkata',
  staleAfterMinutes: 10,
  dataFile: 'C:/Apps/db-backup/panel-data/state.json',
  loginFile: 'C:/Apps/db-backup/secrets/panel-login.json',
  agentTokenHashFile: 'C:/Apps/db-backup/secrets/panel-agent-token.sha256',
};

export const LISTEN_HOST = '127.0.0.1';

export function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Copy panel.config.example.json to panel.config.json next to it, then edit it if needed.`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULTS));
  if (unknown.length) throw new Error(`Unknown setting(s) in ${path}: ${unknown.join(', ')} (check the spelling)`);
  const cfg = { ...DEFAULTS, ...raw };
  const base = dirname(resolve(path));
  for (const k of ['dataFile', 'loginFile', 'agentTokenHashFile']) {
    if (typeof cfg[k] !== 'string' || !cfg[k]) throw new Error(`${k} must be a file path`);
    cfg[k] = isAbsolute(cfg[k]) ? cfg[k] : resolve(base, cfg[k]);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) throw new Error('port must be a number from 1024 to 65535');
  if (typeof cfg.commandsEnabled !== 'boolean') throw new Error('commandsEnabled must be true or false');
  if (!(Number(cfg.staleAfterMinutes) > 0)) throw new Error('staleAfterMinutes must be a positive number');
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: cfg.timeZone });
  } catch {
    throw new Error(`timeZone "${cfg.timeZone}" is not a valid time zone name`);
  }
  return cfg;
}
