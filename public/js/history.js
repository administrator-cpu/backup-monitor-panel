// Run history (one row per task, one cell per day), the 24-hour counts, log
// lines as events, and what kind of problem an error message describes.
// Pure functions, tested in Node.

import { addDays } from './reminders.js';

export const TASK_ROWS = Object.freeze([
  { job: 'pg', kind: 'backup', label: 'Postgres backup' },
  { job: 'pg', kind: 'check', label: 'Postgres check' },
  { job: 'mongo', kind: 'backup', label: 'MongoDB backup' },
  { job: 'mongo', kind: 'check', label: 'MongoDB check' },
  { job: 'files', kind: 'backup', label: 'Files backup' },
  { job: 'files', kind: 'check', label: 'Files check' },
]);

// n days ending with today, oldest first.
export function lastDays(today, n) {
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

// cell level: ok | bad | none (no run that day) | later (today, not run yet) | unknown (before the panel recorded)
export function runGrid(runs, days, dayOf, sinceDay) {
  const today = days[days.length - 1];
  return TASK_ROWS.map((row) => {
    const mine = (runs || []).filter((r) => r.job === row.job && r.kind === row.kind);
    const counts = { ok: 0, bad: 0, none: 0 };
    const cells = days.map((day) => {
      const list = mine.filter((r) => dayOf(r.runAt) === day);
      let level;
      if (list.length) level = list.some((r) => Number(r.result) !== 0) ? 'bad' : 'ok';
      else if (sinceDay && day < sinceDay) level = 'unknown';
      else level = day === today ? 'later' : 'none';
      if (level in counts) counts[level] += 1;
      return { day, level, runs: list };
    });
    return { ...row, cells, counts };
  });
}

// "6 tasks · 1 running · 5 OK and 0 failed in the last 24 hours"
export function dayCounts(state, now) {
  const since = now - 86400000;
  const recent = (state.runs || []).filter((r) => Date.parse(r.runAt) >= since);
  const jobs = (state.report && state.report.data && state.report.data.jobs) || [];
  let running = 0;
  for (const j of jobs) for (const k of ['backup', 'check']) if (j && j[k] && j[k].task && j[k].task.state === 'Running') running += 1;
  return {
    tasks: TASK_ROWS.length,
    running,
    ok: recent.filter((r) => Number(r.result) === 0).length,
    failed: recent.filter((r) => Number(r.result) !== 0).length,
  };
}

// ---------------------------------------------------------------- error types

const ERROR_KINDS = [
  ['auth', 'Access refused', /\b(401|403)\b|unauthori[sz]ed|forbidden|access (is )?denied|permission denied|wrong password|no key found|invalid[_ ]grant|token (has )?expired|expired_auth_token|bad_auth_token|invalid credentials|not authorized/i],
  ['unreachable', 'Could not connect', /no such host|could not resolve|name resolution|timed? ?out|timeout|connection (was )?(refused|reset|closed)|dial tcp|network is unreachable|cannot be reached|could not reach|unable to connect|tls handshake|\bEOF\b/i],
  ['server', 'Server error', /\b5\d\d\b|service unavailable|internal (server )?error|bad gateway|too many requests|\b429\b|rate.?limit|retrying/i],
  ['backup', 'Backup problem', /snapshot|dump|archive|hours old|smaller|missing|no successful|invalid json|repository|free on|alarm/i],
];

// { kind, label } for an error message; kind is auth | unreachable | server | backup | other.
export function errorKind(text) {
  const s = String(text || '');
  for (const [kind, label, re] of ERROR_KINDS) if (re.test(s)) return { kind, label };
  return { kind: 'other', label: 'Problem' };
}

// ---------------------------------------------------------------- log lines as events

const LINE_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[(INFO|WARN|WARNING|ERROR|FATAL)\] (.*)$/;
const RANK = { INFO: 0, WARN: 1, ERROR: 2 };

// "2026-11-14 03:30:06 [INFO] text" -> { time, level, message } (level INFO when unmarked).
export function parseLogLine(line) {
  const m = LINE_RE.exec(String(line));
  if (!m) return { time: null, level: 'INFO', message: String(line) };
  const level = m[2] === 'WARNING' ? 'WARN' : m[2] === 'FATAL' ? 'ERROR' : m[2];
  return { time: m[1], level, message: m[3] };
}

// All log tails as one list, newest first. minLevel: INFO | WARN | ERROR.
export function logEvents(logs, minLevel = 'INFO') {
  const min = RANK[minLevel] || 0;
  const out = [];
  for (const l of logs || []) {
    if (!l || !Array.isArray(l.tail)) continue;
    l.tail.forEach((line, i) => {
      const e = parseLogLine(line);
      if (RANK[e.level] >= min) out.push({ ...e, source: l.name, order: i });
    });
  }
  return out.sort((a, b) => (b.time || '').localeCompare(a.time || '') || b.order - a.order);
}
