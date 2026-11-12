// What the report means. Pure functions over the /api/status payload, so they
// can be tested in Node (test/ui-health.test.js). `now` is always passed in.

import { ago, binBytes, duration, parseTime, plural } from './format.js';

const TASK_RESULTS = new Map([
  [0, 'Success'],
  [1, 'Script ended with exit code 1'],
  [2, 'Script ended with exit code 2'],
  [267008, 'Ready, not run since boot'],
  [267009, 'Running'],
  [267010, 'Task is disabled'],
  [267011, 'Has not run yet'],
  [267012, 'No more runs scheduled'],
  [267014, 'Stopped by a user'],
  [267015, 'Never run, trigger missing'],
  [2147750687, 'An instance was already running'],
  [2147946720, 'Refused by an administrator'],
  [3221225786, 'Stopped (window closed or Ctrl+C)'],
]);
const RUNNING = 267009;
const NOT_YET_RUN = 267011;

export function resultText(code) {
  if (code === null || code === undefined) return '—';
  const n = Number(code);
  const hex = `0x${(n >>> 0).toString(16).toUpperCase()}`;
  return TASK_RESULTS.has(n) ? `${TASK_RESULTS.get(n)} (${hex})` : `Result code ${hex}`;
}

function endedBadly(code) {
  if (code === null || code === undefined) return false;
  const n = Number(code);
  return n !== 0 && n !== RUNNING && n !== NOT_YET_RUN;
}

const task = (job, kind) => (job && job[kind] && job[kind].task) || {};

export function lastGoodAt(job) {
  const t = parseTime(job.lastSuccessAt);
  if (t !== null) return t;
  const bt = task(job, 'backup');
  return bt.lastResult === 0 ? parseTime(bt.lastRunAt) : null;
}

export function maxAgeHours(job) {
  const n = Number(job.maxAgeHours);
  return n > 0 ? n : 26;
}

// level: ok | warn | bad | run
export function jobHealth(job, now) {
  const bt = task(job, 'backup');
  const ct = task(job, 'check');
  if (!bt.found) return { level: 'bad', label: 'Task missing', text: `"${bt.name || 'backup task'}" was not found in Task Scheduler.` };
  if (bt.state === 'Running') return { level: 'run', label: 'Running', text: 'Running now.' };
  if (bt.state === 'Disabled') return { level: 'bad', label: 'Disabled', text: 'The scheduled task is disabled, so nothing runs at night.' };

  const okAt = lastGoodAt(job);
  const failAt = parseTime(job.lastFailureAt);
  if (failAt !== null && (okAt === null || failAt > okAt)) return { level: 'bad', label: 'Failed', text: `The last run failed, ${ago(job.lastFailureAt, now)}.` };
  if (endedBadly(bt.lastResult)) return { level: 'bad', label: 'Failed', text: `The last run ended with: ${resultText(bt.lastResult)}.` };
  if (okAt === null) return { level: 'warn', label: 'No success yet', text: 'No successful run recorded yet.' };

  const ageH = (now - okAt) / 3600000;
  const limit = maxAgeHours(job);
  if (ageH > limit) return { level: 'bad', label: 'Overdue', text: `No good backup for ${duration(ageH * 3600)}; the limit is ${limit} h.` };
  if (!ct.found) return { level: 'warn', label: 'Check missing', text: `"${ct.name || 'check task'}" was not found in Task Scheduler.` };
  if (endedBadly(ct.lastResult)) return { level: 'warn', label: 'Check failed', text: `The backup is fine, but the last check ended with: ${resultText(ct.lastResult)}.` };
  return { level: 'ok', label: 'Current', text: '' };
}

// How much of the allowed age the last good backup has used (0..1).
export function freshness(job, now) {
  const okAt = lastGoodAt(job);
  const limit = maxAgeHours(job);
  if (okAt === null) return { ageHours: null, limitHours: limit, ratio: 1 };
  const ageHours = Math.max(0, (now - okAt) / 3600000);
  return { ageHours, limitHours: limit, ratio: Math.min(1, ageHours / limit) };
}

export function successFile(job, statusFiles) {
  return (statusFiles || []).find((s) => s.job === job.id && /success|succeeded|last-ok|good/i.test(s.name)) || null;
}

// First size-looking value in a status file, if the backup script records one.
export function findSize(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (!/size|bytes/i.test(k)) continue;
    if (typeof v === 'number' && v > 0) return binBytes(v);
    if (typeof v === 'string' && v.length > 0 && v.length < 40) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findSize(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export function isStale(state, now) {
  const r = state && state.report;
  if (!r) return false;
  const t = parseTime(r.receivedAt);
  return t !== null && now - t > (state.staleAfterMinutes || 10) * 60000;
}

export function commandsMode(state) {
  const agent = state.report && state.report.data && state.report.data.agent;
  const serverOn = !!(agent && agent.commandsEnabled);
  if (state.commandsEnabledOnPanel && serverOn) return { on: true, reason: '' };
  if (!state.commandsEnabledOnPanel && !serverOn) return { on: false, reason: 'Run-now is off in both the panel and the agent settings.' };
  if (!state.commandsEnabledOnPanel) return { on: false, reason: 'Run-now is off in the panel settings (panel.config.json).' };
  return { on: false, reason: 'Run-now is off in the agent settings (panel-agent.config.psd1).' };
}

export function waitingCommand(state, actionId) {
  return (state.commands || []).find((c) => c.action === actionId && (c.status === 'pending' || c.status === 'sent')) || null;
}

// Can this Run-now button be pressed? Returns { enabled, reason, waiting }.
export function actionState(state, action, now) {
  const data = state.report && state.report.data;
  if (!data) return { enabled: false, reason: 'No report from the agent yet.', waiting: null };
  const job = (data.jobs || []).find((j) => j.id === action.job);
  const t = task(job, action.kind);
  const waiting = waitingCommand(state, action.id);
  let reason = '';
  if (!((data.agent && data.agent.enabledActions) || []).includes(action.id)) reason = 'Switched off in the agent settings (DisabledActions).';
  else if (isStale(state, now)) reason = 'The agent is not reporting, so it would not collect this.';
  else if (waiting) reason = waiting.status === 'sent' ? 'The agent has it; waiting for its answer.' : 'Queued; waiting for the agent to collect it.';
  else if (t.state === 'Running') reason = 'Running now.';
  else if (job && !t.found) reason = 'Task not found on the server.';
  return { enabled: !reason, reason, waiting };
}

// Least-squares slope (bytes per day) over the last 30 daily points.
export function freeSlope(points) {
  const recent = points.slice(-30);
  if (recent.length < 4) return null;
  const t0 = Date.parse(`${recent[0].day}T00:00:00Z`);
  const xs = recent.map((p) => (Date.parse(`${p.day}T00:00:00Z`) - t0) / 86400000);
  const ys = recent.map((p) => p.free);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

export function diskSeries(metrics, name) {
  return (metrics || [])
    .map((m) => ({ day: m.day, free: ((m.disks || []).find((d) => d.name === name) || {}).freeBytes }))
    .filter((p) => typeof p.free === 'number');
}

// { series, text, daysToWarn } for one disk.
export function diskForecast(disk, metrics, warnBytes) {
  const series = diskSeries(metrics, disk.name);
  const slope = freeSlope(series);
  if (slope === null) {
    return { series, daysToFull: null, daysToWarn: null, text: series.length < 4 ? 'A trend appears after four days of reports.' : 'Not enough change to show a trend.' };
  }
  if (slope > -50 * 1024 * 1024) return { series, daysToFull: null, daysToWarn: null, text: `Steady over the last ${Math.min(series.length, 30)} days.` };
  const daysToFull = disk.freeBytes / -slope;
  const daysToWarn = disk.freeBytes > warnBytes ? (disk.freeBytes - warnBytes) / -slope : 0;
  return { series, daysToFull, daysToWarn, text: `Shrinking by about ${binBytes(-slope)} a day.` };
}

export function b2Estimate(b) {
  if (!b || typeof b.totalBytes !== 'number') return null;
  const price = Number(b.pricePerTBMonth) || 6.95;
  const freeGB = Number(b.freeGB) || 0;
  return { price, freeGB, perMonth: (Math.max(0, b.totalBytes / 1e9 - freeGB) / 1000) * price };
}

export function lowDisks(data) {
  const warn = (Number(data.diskWarnFreeGB) || 60) * 1024 ** 3;
  return (data.disks || []).filter((d) => d.freeBytes < warn);
}

// The one-sentence answer at the top of the page.
export function verdict(state, now, fmt) {
  const report = state.report;
  if (!report || !report.data) {
    return { level: 'idle', headline: 'Waiting for the first report from the agent.', detail: ['Install the agent (setup guide, part 5). This page checks again every 20 seconds.'] };
  }
  const data = report.data;
  if (isStale(state, now)) {
    return {
      level: 'bad',
      headline: `The agent stopped reporting ${ago(report.receivedAt, now)}.`,
      detail: [`Everything below is as of ${fmt.time(report.receivedAt)}. Check that the “Backup Panel Agent” scheduled task is enabled and running.`],
    };
  }
  const rows = (data.jobs || []).map((j) => ({ job: j, h: jobHealth(j, now) }));
  const bad = rows.filter((r) => r.h.level === 'bad');
  const warn = rows.filter((r) => r.h.level === 'warn');
  const running = rows.filter((r) => r.h.level === 'run');
  const disks = lowDisks(data);
  const detail = [...bad, ...warn].map((r) => `${r.job.label}: ${r.h.text}`);
  for (const d of disks) detail.push(`${d.name} has ${binBytes(d.freeBytes)} free, below the ${data.diskWarnFreeGB || 60} GB warning level.`);

  if (bad.length === 1) return { level: 'bad', headline: `${bad[0].job.label} needs attention.`, detail };
  if (bad.length > 1) return { level: 'bad', headline: `${bad.length} backups need attention.`, detail };
  const notes = warn.length + disks.length;
  if (notes) return { level: 'warn', headline: `Backups are current, with ${plural(notes, 'warning')}.`, detail };
  const good = rows.filter((r) => r.h.level === 'ok').map((r) => `${r.job.label} ${fmt.clock(new Date(lastGoodAt(r.job)).toISOString())}`);
  if (running.length) {
    return { level: 'run', headline: `${running.map((r) => r.job.label).join(' and ')} running now; the rest are current.`, detail: good.length ? [`Last good: ${good.join(' · ')}`] : [] };
  }
  const all = rows.length === 3 ? 'All three backups are current.' : 'All backups are current.';
  return { level: 'ok', headline: all, detail: good.length ? [`Last good: ${good.join(' · ')}`] : [] };
}
