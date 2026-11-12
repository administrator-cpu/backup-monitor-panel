// Panel data in one JSON file: the newest report, a small row per day for
// trends, Run-now commands and a few events. Writes go to a temporary file
// that then replaces the old one, so a crash never leaves half a file.
// The panel runs as a single process, so plain in-memory updates are safe.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { COMMAND_PICKUP_MINUTES, COMMAND_REPLY_MINUTES } from './actions.js';

export const iso = (ms) => new Date(ms).toISOString();

const DAY = 86400000;
const ACTIVE = new Set(['pending', 'sent']);
const empty = () => ({ version: 1, latest: null, metrics: {}, commands: [], events: [] });

function load(file, log) {
  if (!file || !existsSync(file)) return empty();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data && data.version === 1) return { ...empty(), ...data };
    throw new Error('unexpected format');
  } catch (e) {
    const aside = `${file}.unreadable-${Date.now()}`;
    renameSync(file, aside);
    log(`Could not read ${file} (${e.message}); kept it as ${aside} and started empty.`);
    return empty();
  }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  // Antivirus can hold the file for a moment on Windows; try a few times.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

// file === null keeps everything in memory (tests).
export function openStore(file, { log = console.log } = {}) {
  const data = load(file, log);
  const save = () => {
    if (file) writeAtomic(file, JSON.stringify(data));
  };
  const findCommand = (id) => data.commands.find((c) => c.id === id);

  return {
    saveReport({ nowIso, payload, day, metrics, events }) {
      data.latest = { received_at: nowIso, payload };
      data.metrics[day] = { updated_at: nowIso, payload: metrics };
      for (const e of events) {
        if (!data.events.some((x) => x.at === e.at && x.kind === e.kind && x.message === e.message)) data.events.push({ ...e });
      }
      save();
    },

    getLatest() {
      return data.latest ? { ...data.latest } : null;
    },

    expireCommands(nowMs) {
      const nowIso = iso(nowMs);
      const pickup = iso(nowMs - COMMAND_PICKUP_MINUTES * 60000);
      const reply = iso(nowMs - COMMAND_REPLY_MINUTES * 60000);
      let changed = false;
      for (const c of data.commands) {
        if (c.status === 'pending' && c.requested_at < pickup) {
          Object.assign(c, { status: 'expired', finished_at: nowIso, message: `The server did not pick this up within ${COMMAND_PICKUP_MINUTES} minutes.` });
          changed = true;
        } else if (c.status === 'sent' && c.sent_at < reply) {
          Object.assign(c, { status: 'no-reply', finished_at: nowIso, message: 'The server took the command but did not say what happened.' });
          changed = true;
        }
      }
      if (changed) save();
    },

    listPending(limit) {
      return data.commands
        .filter((c) => c.status === 'pending')
        .sort((a, b) => a.requested_at.localeCompare(b.requested_at))
        .slice(0, limit)
        .map((c) => ({ id: c.id, action: c.action, requested_at: c.requested_at, requested_by: c.requested_by }));
    },

    claim(id, nowIso) {
      const c = findCommand(id);
      if (!c || c.status !== 'pending') return false;
      Object.assign(c, { status: 'sent', sent_at: nowIso });
      save();
      return true;
    },

    recordResult(id, status, message, nowIso) {
      const c = findCommand(id);
      if (!c || (c.status !== 'sent' && c.status !== 'no-reply')) return false;
      Object.assign(c, { status, message, finished_at: nowIso });
      save();
      return true;
    },

    // At most one waiting command per action, even if the button is clicked twice.
    insertCommand(cmd) {
      if (ACTIVE.has(cmd.status) && data.commands.some((c) => c.action === cmd.action && ACTIVE.has(c.status))) {
        throw new Error('UNIQUE: a command for this action is already waiting');
      }
      data.commands.push({ sent_at: null, finished_at: null, message: null, ...cmd });
      save();
    },

    activeForAction(action) {
      const c = data.commands.find((x) => x.action === action && ACTIVE.has(x.status));
      return c ? c.id : null;
    },

    countSince(sinceIso) {
      return data.commands.filter((c) => c.requested_at >= sinceIso).length;
    },

    cancelCommand(id, by, nowIso) {
      const c = findCommand(id);
      if (!c || c.status !== 'pending') return false;
      Object.assign(c, { status: 'cancelled', finished_at: nowIso, message: `Cancelled on the panel by ${by}.` });
      save();
      return true;
    },

    listCommands(limit) {
      return [...data.commands].sort((a, b) => b.requested_at.localeCompare(a.requested_at)).slice(0, limit).map((c) => ({ ...c }));
    },

    listMetrics(sinceDay) {
      return Object.keys(data.metrics)
        .filter((d) => d >= sinceDay)
        .sort()
        .map((day) => ({ day, ...(data.metrics[day].payload || {}) }));
    },

    addEvent(e) {
      data.events.push({ ...e });
      save();
    },

    listEvents(kind, limit) {
      return data.events
        .filter((e) => e.kind === kind)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
        .map((e) => ({ ...e }));
    },

    cleanup(nowMs) {
      const keepCommands = iso(nowMs - 365 * DAY);
      const keepEvents = iso(nowMs - 180 * DAY);
      const keepDays = iso(nowMs - 3 * 365 * DAY).slice(0, 10);
      data.commands = data.commands.filter((c) => c.requested_at >= keepCommands);
      data.events = data.events.filter((e) => e.at >= keepEvents);
      for (const day of Object.keys(data.metrics)) if (day < keepDays) delete data.metrics[day];
      save();
    },
  };
}
