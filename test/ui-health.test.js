// The page's judgement calls (public/js/health.js) and formatting, tested
// without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleReport } from './helpers.js';
import { ACTIONS } from '../src/actions.js';
import {
  actionState, commandsMode, diskForecast, freeSlope, freshness, jobHealth, resultText, verdict,
} from '../public/js/health.js';
import { ago, binBytes, decBytes, duration, makeFormatter } from '../public/js/format.js';

const NOW = Date.parse('2026-11-11T08:00:00Z');
const fmt = makeFormatter('Asia/Kolkata');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function state(mutate = () => {}, extra = {}) {
  const data = sampleReport();
  for (const j of data.jobs) j.lastSuccessAt = hoursAgo(6);
  mutate(data);
  return {
    now: new Date(NOW).toISOString(), timeZone: 'Asia/Kolkata', staleAfterMinutes: 10, commandsEnabledOnPanel: true,
    actions: ACTIONS, commands: [], metrics: [], events: [],
    report: { receivedAt: hoursAgo(1 / 60), data },
    ...extra,
  };
}
const job = (s, id) => s.report.data.jobs.find((j) => j.id === id);
const action = (id) => ACTIONS.find((a) => a.id === id);

test('job health covers each way a backup can be wrong', () => {
  const ok = state();
  assert.equal(jobHealth(job(ok, 'pg'), NOW).level, 'ok');

  const cases = [
    ['task missing', (d) => { d.jobs[0].backup.task.found = false; }, 'bad', 'Task missing'],
    ['running', (d) => { d.jobs[0].backup.task.state = 'Running'; }, 'run', 'Running'],
    ['disabled', (d) => { d.jobs[0].backup.task.state = 'Disabled'; }, 'bad', 'Disabled'],
    ['failure file newer', (d) => { d.jobs[0].lastFailureAt = hoursAgo(1); }, 'bad', 'Failed'],
    ['exit code 1', (d) => { d.jobs[0].backup.task.lastResult = 1; }, 'bad', 'Failed'],
    ['too old', (d) => { d.jobs[0].lastSuccessAt = hoursAgo(30); }, 'bad', 'Overdue'],
    ['check failed', (d) => { d.jobs[0].check.task.lastResult = 1; }, 'warn', 'Check failed'],
    ['check missing', (d) => { d.jobs[0].check.task.found = false; }, 'warn', 'Check missing'],
    ['never succeeded', (d) => { d.jobs[0].lastSuccessAt = null; d.jobs[0].backup.task.lastResult = 267011; }, 'warn', 'No success yet'],
  ];
  for (const [name, mutate, level, label] of cases) {
    const h = jobHealth(job(state(mutate), 'pg'), NOW);
    assert.equal(h.level, level, name);
    assert.equal(h.label, label, name);
  }
  const older = jobHealth(job(state((d) => { d.jobs[0].lastFailureAt = hoursAgo(50); }), 'pg'), NOW);
  assert.equal(older.level, 'ok', 'an old failure followed by a success is fine');
  const fallback = jobHealth(job(state((d) => { d.jobs[0].lastSuccessAt = null; d.jobs[0].backup.task.lastRunAt = hoursAgo(5); }), 'pg'), NOW);
  assert.equal(fallback.level, 'ok', 'a clean task result counts when no status file exists');
});

test('freshness is the share of the allowed age used', () => {
  const f = freshness(job(state((d) => { d.jobs[0].lastSuccessAt = hoursAgo(13); }), 'pg'), NOW);
  assert.equal(Math.round(f.ageHours), 13);
  assert.equal(f.limitHours, 26);
  assert.equal(f.ratio, 0.5);
  assert.equal(freshness(job(state((d) => { d.jobs[0].lastSuccessAt = hoursAgo(90); }), 'pg'), NOW).ratio, 1);
});

test('the summary sentence', () => {
  let v = verdict(state(), NOW, fmt);
  assert.equal(v.level, 'ok');
  assert.equal(v.headline, 'All three backups are current.');
  assert.match(v.detail[0], /^Last good: Postgres 07:30 · MongoDB 07:30 · Files and logs 07:30$/);

  v = verdict(state((d) => { d.jobs[1].backup.task.lastResult = 1; }), NOW, fmt);
  assert.equal(v.headline, 'MongoDB needs attention.');
  v = verdict(state((d) => { d.jobs[1].backup.task.lastResult = 1; d.jobs[2].lastSuccessAt = hoursAgo(40); }), NOW, fmt);
  assert.equal(v.headline, '2 backups need attention.');
  assert.equal(v.detail.length, 2);

  v = verdict(state((d) => { d.jobs[0].check.task.lastResult = 1; d.disks[1].freeBytes = 10 * 1024 ** 3; }), NOW, fmt);
  assert.equal(v.level, 'warn');
  assert.equal(v.headline, 'Backups are current, with 2 warnings.');
  assert.ok(v.detail.some((d) => d.startsWith('F: has 10.0 GB free')));

  v = verdict(state((d) => { d.jobs[2].backup.task.state = 'Running'; }), NOW, fmt);
  assert.equal(v.headline, 'Files and logs running now; the rest are current.');

  const stale = state();
  stale.report.receivedAt = hoursAgo(1);
  v = verdict(stale, NOW, fmt);
  assert.equal(v.level, 'bad');
  assert.equal(v.headline, 'The agent stopped reporting 60 min ago.');

  v = verdict({ ...state(), report: null }, NOW, fmt);
  assert.equal(v.level, 'idle');
});

test('Run-now switches and button availability', () => {
  assert.equal(commandsMode(state()).on, true);
  assert.match(commandsMode(state(() => {}, { commandsEnabledOnPanel: false })).reason, /panel.config.json/);
  assert.match(commandsMode(state((d) => { d.agent.commandsEnabled = false; })).reason, /panel-agent.config.psd1/);

  assert.equal(actionState(state(), action('run-pg-backup'), NOW).enabled, true);
  const cases = [
    ['disabled on server', state((d) => { d.agent.enabledActions = ['run-pg-check']; }), /DisabledActions/],
    ['running', state((d) => { d.jobs[0].backup.task.state = 'Running'; }), /Running now/],
    ['task missing', state((d) => { d.jobs[0].backup.task.found = false; }), /not found/],
    ['already queued', state(() => {}, { commands: [{ id: 'x', action: 'run-pg-backup', status: 'pending', requested_at: hoursAgo(0.01) }] }), /Queued; waiting/],
    ['with the server', state(() => {}, { commands: [{ id: 'x', action: 'run-pg-backup', status: 'sent', requested_at: hoursAgo(0.01) }] }), /agent has it/],
  ];
  for (const [name, s, re] of cases) {
    const st = actionState(s, action('run-pg-backup'), NOW);
    assert.equal(st.enabled, false, name);
    assert.match(st.reason, re, name);
  }
  const stale = state();
  stale.report.receivedAt = hoursAgo(1);
  assert.match(actionState(stale, action('run-pg-backup'), NOW).reason, /not reporting/);
  const done = state(() => {}, { commands: [{ id: 'x', action: 'run-pg-backup', status: 'started', requested_at: hoursAgo(1) }] });
  assert.equal(actionState(done, action('run-pg-backup'), NOW).enabled, true, 'a finished command does not block the button');
});

test('disk forecast from daily free space', () => {
  const GB = 1024 ** 3;
  const days = (n, start, perDay) => Array.from({ length: n }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
    disks: [{ name: 'F:', freeBytes: start - i * perDay }],
  }));
  assert.equal(freeSlope([]), null);
  const metrics = days(20, 300 * GB, 2.5 * GB);
  assert.ok(Math.abs(freeSlope(metrics.map((m) => ({ day: m.day, free: m.disks[0].freeBytes }))) + 2.5 * GB) < 1);
  const disk = { name: 'F:', sizeBytes: 452 * GB, freeBytes: 252.5 * GB };
  const f = diskForecast(disk, metrics, 60 * GB);
  assert.equal(Math.round(f.daysToWarn), 77);
  assert.equal(Math.round(f.daysToFull), 101);
  assert.match(f.text, /2\.5 GB a day/);
  assert.match(diskForecast(disk, days(3, 300 * GB, GB), 60 * GB).text, /four days/);
  assert.match(diskForecast(disk, days(10, 300 * GB, 0), 60 * GB).text, /Steady/);
});

test('formatting', () => {
  assert.equal(resultText(0), 'Success (0x0)');
  assert.equal(resultText(2147946720), 'Refused by an administrator (0x800710E0)');
  assert.equal(resultText(5), 'Result code 0x5');
  assert.equal(duration(45), '45 s');
  assert.equal(duration(600), '10 min');
  assert.equal(duration(3 * 3600), '3.0 h');
  assert.equal(duration(30 * 3600), '30 h');
  assert.equal(duration(5 * 86400), '5 days');
  assert.equal(ago(new Date(NOW + 5000).toISOString(), NOW), 'just now');
  assert.equal(binBytes(72 * 1024 ** 3), '72.0 GB');
  assert.equal(decBytes(64.6e9), '64.60 GB');
  assert.equal(binBytes(undefined), '—');
  assert.equal(fmt.time('2026-11-10T20:30:00Z'), '11 Nov, 02:00');
  assert.equal(fmt.time(null), '—');
});
