// Restore points, read from the summary files the morning checks write
// (status\pg-snapshots.json, mongo-snapshots.json, files-snapshots.json; see
// server-scripts/panel-status.ps1). Pure functions, tested in Node.

import { parseTime } from './format.js';

const DRIVE_ENCRYPTION = 'rclone crypt, encrypted on the server before upload';
const RESTIC_ENCRYPTION = 'restic, AES-256, repository level';

// What each set is. The retention rules are the ones the backup scripts use.
export const POINT_SETS = Object.freeze([
  { id: 'pg', file: 'pg-snapshots.json', label: 'Postgres', kind: 'drive', kept: 'Kept forever', encryption: DRIVE_ENCRYPTION, checkAt: '08:00' },
  { id: 'mongo', file: 'mongo-snapshots.json', label: 'MongoDB', kind: 'drive', kept: 'Kept forever', encryption: DRIVE_ENCRYPTION, checkAt: '08:05' },
  { id: 'logs', file: 'files-snapshots.json', label: 'Server logs', kind: 'restic', kept: '14 daily, 8 weekly, 36 monthly', encryption: RESTIC_ENCRYPTION, checkAt: '08:15', goalYears: 3 },
  { id: 'files', file: 'files-snapshots.json', label: 'Files', kind: 'restic', kept: '30 daily, 12 weekly, 12 monthly', encryption: RESTIC_ENCRYPTION, checkAt: '08:15' },
]);

export function summaryFile(data, name) {
  const f = ((data && data.statusFiles) || []).find((s) => s && s.name === name);
  return f && f.content && typeof f.content === 'object' && !Array.isArray(f.content) ? f.content : null;
}

// One row per set: { def, summary, set }. summary/set are null until a check wrote them.
export function restoreSets(data) {
  return POINT_SETS.map((def) => {
    const summary = summaryFile(data, def.file);
    const sets = summary && Array.isArray(summary.sets) ? summary.sets : [];
    return { def, summary, set: sets.find((s) => s && s.id === def.id) || null };
  });
}

export const hasRestoreData = (data) => restoreSets(data).some((r) => r.summary);

// The calendar day of a point: Drive folders are named by day, restic points carry a time.
export function pointDay(p, dayOf) {
  if (p && typeof p.date === 'string') return p.date;
  return p && p.time ? dayOf(p.time) : null;
}

// from/to are 'YYYY-MM-DD' (either may be empty).
export function filterPoints(points, { from = '', to = '' } = {}, dayOf) {
  return (points || []).filter((p) => {
    const d = pointDay(p, dayOf);
    if (!d) return !from && !to;
    return (!from || d >= from) && (!to || d <= to);
  });
}

// How far the oldest restore point reaches towards a goal, e.g. 3 years of logs.
export function historyGoal(set, years, now) {
  const oldest = parseTime(set && set.oldest);
  if (oldest === null || !years) return null;
  const goalMs = years * 365.25 * 86400000;
  const ageMs = Math.max(0, now - oldest);
  return { ageDays: ageMs / 86400000, goalDays: goalMs / 86400000, ratio: Math.min(1, ageMs / goalMs), metAt: oldest + goalMs, met: ageMs >= goalMs };
}

// A summary older than this was not refreshed by this morning's check.
export const SUMMARY_STALE_HOURS = 30;

export function summaryAgeHours(summary, now) {
  const t = parseTime(summary && summary.checkedAt);
  return t === null ? null : Math.max(0, (now - t) / 3600000);
}

// What is backed up, per set: names (databases or folders) and anything missing.
export function coverageOf(row) {
  const { def, summary, set } = row;
  if (def.kind === 'drive') {
    const c = (summary && summary.coverage) || {};
    return { what: 'databases', items: Array.isArray(c.databases) ? c.databases : [], missing: Array.isArray(c.missing) ? c.missing : [] };
  }
  return { what: 'folders', items: set && Array.isArray(set.paths) ? set.paths : [], missing: [] };
}

// Google Drive: the backups' size (from the listings) and the account's space (rclone about).
export function driveTotals(data) {
  const rows = restoreSets(data).filter((r) => r.def.kind === 'drive' && r.set);
  const pg = summaryFile(data, 'pg-snapshots.json');
  const space = pg && pg.drive && typeof pg.drive.totalBytes === 'number' && pg.drive.totalBytes > 0 ? pg.drive : null;
  if (!space && !rows.length) return null;
  const backups = rows.map((r) => ({ label: r.def.label, bytes: Number(r.set.storedBytes) || 0, count: Number(r.set.count) || 0 }));
  const accountUsed = space ? (Number(space.usedBytes) || 0) + (Number(space.otherBytes) || 0) : null;
  return { backups, backupBytes: backups.reduce((a, b) => a + b.bytes, 0), space, accountUsed };
}
