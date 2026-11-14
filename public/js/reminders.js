// Reminders the owner keeps on the panel: practice restores, when keys and
// passwords were last changed, and the Backblaze caps. Pure functions, used by
// the page and by the server (src/app.js validates changes with them).

export const PRACTICE = Object.freeze([
  { id: 'pg', label: 'Postgres', how: 'restore-db.ps1 into a new database name' },
  { id: 'mongo', label: 'MongoDB', how: 'restore-mongo.ps1 -NewName, then remove the copy with mongo-drop-db.cjs' },
  { id: 'files', label: 'Files and logs', how: 'restore-files.ps1 -Target into a new folder' },
]);
export const PRACTICE_DAYS = 31;

// manual: the owner enters the date. Otherwise it is read from the server.
export const KEYS = Object.freeze([
  { id: 'b2', label: 'Backblaze application key (backups)', manual: true },
  { id: 'restic', label: 'restic repository password', manual: true },
  { id: 'drive', label: 'Google Drive access (rclone)', manual: true },
  { id: 'smtp', label: 'E-mail (SMTP) password', manual: true },
  { id: 'gate', label: 'Gate key', manual: true },
  { id: 'panel', label: 'Panel password and authenticator', manual: false },
  { id: 'agent', label: 'Agent token', manual: false },
]);
export const KEY_MONTHS = Object.freeze([3, 6, 12, 24]);
export const DEFAULT_KEY_MONTHS = 12;
export const MAX_CAP_DOLLARS = 1000;

const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const isDay = (v) => typeof v === 'string' && DAY_RE.test(v) && Number.isFinite(dayMs(v));

export function addDays(day, n) {
  return new Date(dayMs(day) + n * 86400000).toISOString().slice(0, 10);
}

export function addMonths(day, months) {
  const d = new Date(dayMs(day));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);

// level: ok | due | never
export function practiceRows(notes, today) {
  const p = (notes && notes.practice) || {};
  return PRACTICE.map((def) => {
    const last = isDay(p[def.id]) ? p[def.id] : null;
    if (!last) return { ...def, last: null, ageDays: null, dueOn: null, level: 'never' };
    const ageDays = daysBetween(last, today);
    return { ...def, last, ageDays, dueOn: addDays(last, PRACTICE_DAYS), level: ageDays > PRACTICE_DAYS ? 'due' : 'ok' };
  });
}

// auto: { panel: iso|null, agent: iso|null } read from the server.
export function keyRows(notes, auto, today) {
  const k = (notes && notes.keys) || {};
  return KEYS.map((def) => {
    const saved = k[def.id] || {};
    const months = KEY_MONTHS.includes(saved.months) ? saved.months : DEFAULT_KEY_MONTHS;
    const fromServer = !def.manual && auto && typeof auto[def.id] === 'string' ? auto[def.id].slice(0, 10) : null;
    const last = def.manual ? (isDay(saved.date) ? saved.date : null) : (isDay(fromServer) ? fromServer : null);
    if (!last) return { ...def, months, last: null, dueOn: null, level: 'never' };
    const dueOn = addMonths(last, months);
    return { ...def, months, last, dueOn, level: today > dueOn ? 'due' : 'ok' };
  });
}

// Backblaze caps (dollars a day) against the storage estimate.
export function capsInfo(notes, perMonthEstimate) {
  const c = (notes && notes.caps) || {};
  const storage = typeof c.storagePerDay === 'number' ? c.storagePerDay : null;
  const download = typeof c.downloadPerDay === 'number' ? c.downloadPerDay : null;
  const perDay = typeof perMonthEstimate === 'number' ? perMonthEstimate / 30 : null;
  const ratio = storage && perDay !== null ? perDay / storage : null;
  return { storage, download, perDay, ratio, level: ratio === null ? 'idle' : ratio >= 0.8 ? 'warn' : 'ok' };
}

// Checks one change sent by the page. Returns { change } or { error }.
// today: the latest acceptable date ('YYYY-MM-DD').
export function validateNoteChange(body, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object.' };
  const date = (v) => v === null || (isDay(v) && v >= '2020-01-01' && v <= today);
  if (body.section === 'practice') {
    if (!PRACTICE.some((p) => p.id === body.id)) return { error: 'Unknown practice restore.' };
    if (!date(body.date)) return { error: 'The date must be a day between 2020 and today.' };
    return { change: { section: 'practice', id: body.id, date: body.date } };
  }
  if (body.section === 'keys') {
    const def = KEYS.find((k) => k.id === body.id);
    if (!def || !def.manual) return { error: 'Unknown key, or one whose date comes from the server.' };
    const change = { section: 'keys', id: body.id };
    if ('date' in body) {
      if (!date(body.date)) return { error: 'The date must be a day between 2020 and today.' };
      change.date = body.date;
    }
    if ('months' in body) {
      if (!KEY_MONTHS.includes(body.months)) return { error: 'Choose 3, 6, 12 or 24 months.' };
      change.months = body.months;
    }
    if (!('date' in change) && !('months' in change)) return { error: 'Nothing to change.' };
    return { change };
  }
  if (body.section === 'caps') {
    const money = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_CAP_DOLLARS);
    if (!money(body.storagePerDay) || !money(body.downloadPerDay)) return { error: `Caps are dollars a day, from 0 to ${MAX_CAP_DOLLARS}.` };
    return { change: { section: 'caps', storagePerDay: body.storagePerDay, downloadPerDay: body.downloadPerDay } };
  }
  return { error: 'Unknown section.' };
}

export function applyNoteChange(notes, change) {
  const next = JSON.parse(JSON.stringify(notes || {}));
  if (change.section === 'practice') {
    next.practice = { ...(next.practice || {}), [change.id]: change.date };
  } else if (change.section === 'keys') {
    const keys = next.keys || {};
    const item = { ...(keys[change.id] || {}) };
    if ('date' in change) item.date = change.date;
    if ('months' in change) item.months = change.months;
    next.keys = { ...keys, [change.id]: item };
  } else if (change.section === 'caps') {
    next.caps = { storagePerDay: change.storagePerDay, downloadPerDay: change.downloadPerDay };
  }
  return next;
}
