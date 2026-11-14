// Run history, 24-hour counts, reminders, error types and log events:
// the server side (store + API) and the pure page functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, call, Clock, makePanel, pageHeaders, sampleReport, signIn } from './helpers.js';
import { metricsFromReport, runsFromReport } from '../src/app.js';
import { dayCounts, errorKind, lastDays, logEvents, parseLogLine, runGrid } from '../public/js/history.js';
import { addMonths, capsInfo, keyRows, practiceRows, validateNoteChange } from '../public/js/reminders.js';
import { makeFormatter } from '../public/js/format.js';

const report = (panel, clock, body) => agent(panel, clock, '/api/agent/report', body);
const note = (panel, clock, body, headers = pageHeaders) => call(panel, clock, 'POST', '/api/notes', { body, headers });

function withRun(job, kind, runAt, result, state = 'Ready') {
  const r = sampleReport();
  const j = r.jobs.find((x) => x.id === job);
  Object.assign(j[kind].task, { lastRunAt: runAt, lastResult: result, state });
  return r;
}

test('each finished run is kept once, with its result', async () => {
  const panel = makePanel();
  const clock = new Clock();
  await report(panel, clock, sampleReport());
  await report(panel, clock, sampleReport());
  let runs = panel.store.listRuns('2000-01-01');
  assert.equal(runs.length, 6, 'one row per task, not per report');
  assert.ok(runs.every((r) => r.runAt === '2026-11-10T20:30:00Z' && r.result === 0));

  await report(panel, clock, withRun('pg', 'backup', '2026-11-11T07:50:00Z', 267009, 'Running'));
  assert.equal(panel.store.listRuns('2000-01-01').length, 6, 'a running task is not a finished run');
  await report(panel, clock, withRun('pg', 'backup', '2026-11-11T07:50:00Z', 1));
  runs = panel.store.listRuns('2026-11-11T00:00:00Z');
  assert.deepEqual(runs.map((r) => [r.job, r.kind, r.result]), [['pg', 'backup', 1]]);
  assert.equal(runsFromReport(withRun('mongo', 'check', null, 0)).length, 5, 'a task that never ran is skipped');
  assert.equal(runsFromReport(withRun('mongo', 'check', '2026-11-11 02:00', 0)).length, 5, 'odd time formats are skipped');

  await signIn(panel, clock);
  const s = (await call(panel, clock, 'GET', '/api/status')).json;
  assert.equal(s.runs.length, 7);
  assert.ok(s.historySince);
  assert.ok(s.loginSetAt, 'the panel knows when the login was set up');
});

test('daily metrics keep listing times and Google Drive totals', () => {
  const r = sampleReport();
  r.backblaze.listMs = 2300;
  r.statusFiles.push(
    { name: 'pg-snapshots.json', content: { kind: 'pg', sets: [{ id: 'pg', provider: 'Google Drive', storedBytes: 100, listMs: 1500 }], drive: { totalBytes: 2e12, usedBytes: 1e11, otherBytes: 1e9 } } },
    { name: 'mongo-snapshots.json', content: { kind: 'mongo', sets: [{ id: 'mongo', provider: 'Google Drive', storedBytes: 50, listMs: 900 }] } },
    { name: 'files-snapshots.json', content: { kind: 'files', sets: [{ id: 'logs', provider: 'Backblaze B2', storedBytes: 7, listMs: 61000 }, { id: 'files', provider: 'Backblaze B2', storedBytes: 8, listMs: 3000, fromEarlierCheck: true }] } },
  );
  const m = metricsFromReport(r);
  assert.equal(m.b2.listMs, 2300);
  assert.deepEqual(m.reads, { pg: { ms: 1500, stored: 100 }, mongo: { ms: 900, stored: 50 }, logs: { ms: 61000, stored: 7 } });
  assert.deepEqual(m.drive, { backupBytes: 150, account: { totalBytes: 2e12, usedBytes: 1.01e11 } });
});

test('reminders: validated, saved, and they start nothing', async () => {
  const panel = makePanel();
  const clock = new Clock();
  await report(panel, clock, sampleReport());
  await signIn(panel, clock);

  assert.equal((await note(panel, clock, { section: 'practice', id: 'pg', date: '2026-11-01' }, { 'Content-Type': 'application/json' })).status, 403, 'needs the page header');
  let r = await note(panel, clock, { section: 'practice', id: 'pg', date: '2026-11-01' });
  assert.equal(r.status, 200);
  assert.equal(r.json.notes.practice.pg, '2026-11-01');
  r = await note(panel, clock, { section: 'keys', id: 'b2', date: '2026-01-15', months: 6 });
  assert.deepEqual(r.json.notes.keys.b2, { date: '2026-01-15', months: 6 });
  r = await note(panel, clock, { section: 'caps', storagePerDay: 0.25, downloadPerDay: 2 });
  assert.deepEqual(r.json.notes.caps, { storagePerDay: 0.25, downloadPerDay: 2 });

  const bad = [
    { section: 'practice', id: 'restore-everything', date: '2026-11-01' },
    { section: 'practice', id: 'pg', date: '2031-01-01' },
    { section: 'practice', id: 'pg', date: '1/11/2026' },
    { section: 'keys', id: 'panel', date: '2026-11-01' },
    { section: 'keys', id: 'b2', months: 7 },
    { section: 'keys', id: 'b2' },
    { section: 'caps', storagePerDay: -1, downloadPerDay: 2 },
    { section: 'caps', storagePerDay: '0.25', downloadPerDay: 2 },
    { section: 'commands', id: 'run-pg-backup' },
    ['practice'],
  ];
  for (const b of bad) assert.equal((await note(panel, clock, b)).status, 400, JSON.stringify(b));
  assert.equal(panel.store.listCommands(10).length, 0, 'no command was queued');
  const s = (await call(panel, clock, 'GET', '/api/status')).json;
  assert.equal(s.notes.practice.pg, '2026-11-01');
  assert.equal(panel.store.listEvents('note', 10).length, 3, 'each change is logged');
  assert.match(panel.store.listEvents('note', 1)[0].message, /from 203\.0\.113\.7/);
});

test('reminder dates turn into due dates', () => {
  const today = '2026-11-14';
  const p = practiceRows({ practice: { pg: '2026-11-01', mongo: '2026-09-01' } }, today);
  assert.deepEqual(p.map((r) => [r.id, r.level]), [['pg', 'ok'], ['mongo', 'due'], ['files', 'never']]);
  assert.equal(p[0].dueOn, '2026-12-02');
  const k = keyRows({ keys: { b2: { date: '2025-10-01', months: 12 }, restic: { date: '2026-06-01', months: 6 } } }, { panel: '2026-11-12T10:00:00Z', agent: null }, today);
  const byId = Object.fromEntries(k.map((r) => [r.id, r]));
  assert.equal(byId.b2.level, 'due');
  assert.equal(byId.restic.dueOn, '2026-12-01');
  assert.equal(byId.panel.last, '2026-11-12');
  assert.equal(byId.panel.level, 'ok');
  assert.equal(byId.agent.level, 'never');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(validateNoteChange({ section: 'practice', id: 'pg', date: null }, today).change.date, null, 'a date can be cleared');
  const c = capsInfo({ caps: { storagePerDay: 0.25, downloadPerDay: 2 } }, 6.9);
  assert.ok(Math.abs(c.perDay - 0.23) < 0.001);
  assert.equal(c.level, 'warn');
  assert.equal(capsInfo({}, 6.9).level, 'idle');
});

test('the 30-day grid and the 24-hour counts', () => {
  const day = makeFormatter('Asia/Kolkata').day;
  const days = lastDays('2026-11-14', 30);
  assert.equal(days.length, 30);
  assert.equal(days[0], '2026-10-16');
  assert.equal(days[29], '2026-11-14');
  const runs = [
    { job: 'pg', kind: 'backup', runAt: '2026-11-11T20:30:00Z', result: 0 },
    { job: 'pg', kind: 'backup', runAt: '2026-11-12T20:30:00Z', result: 1 },
    { job: 'pg', kind: 'backup', runAt: '2026-11-13T09:00:00Z', result: 0 },
  ];
  const grid = runGrid(runs, days, day, '2026-11-12');
  const pg = grid[0];
  const cell = (d) => pg.cells.find((c) => c.day === d);
  assert.equal(cell('2026-11-11').level, 'unknown', 'before the panel recorded');
  assert.equal(cell('2026-11-12').level, 'ok', '02:00 India time on the 12th');
  assert.equal(cell('2026-11-13').level, 'bad', 'one of the two runs on the 13th failed');
  assert.equal(cell('2026-11-14').level, 'later');
  assert.deepEqual(pg.counts, { ok: 1, bad: 1, none: 0 });
  assert.equal(grid[1].cells.find((c) => c.day === '2026-11-13').level, 'none');

  const now = Date.parse('2026-11-13T12:00:00Z');
  const state = { runs, report: { data: { jobs: [{ backup: { task: { state: 'Running' } }, check: { task: { state: 'Ready' } } }] } } };
  assert.deepEqual(dayCounts(state, now), { tasks: 6, running: 1, ok: 1, failed: 1 });
});

test('error messages are sorted into kinds', () => {
  const cases = [
    ['restic: wrong password or no key found', 'auth'],
    ['rclone: couldn\'t fetch token - maybe it has expired? invalid_grant', 'auth'],
    ['HTTP 401: bad_auth_token', 'auth'],
    ['dial tcp: lookup api.backblazeb2.com: no such host', 'unreachable'],
    ['could not reach the heartbeat service (The operation has timed out)', 'unreachable'],
    ['b2_list_file_names: 503 service unavailable', 'server'],
    ['Load(<snapshot/aa>, 0, 0) returned error, retrying after 552ms', 'server'],
    ['[logs] the newest snapshot is 31 hours old (limit 30).', 'backup'],
    ['Today\'s snapshot is missing globals.sql', 'backup'],
    ['something odd', 'other'],
  ];
  for (const [text, kind] of cases) assert.equal(errorKind(text).kind, kind, text);
});

test('log lines become events with a severity filter', () => {
  assert.deepEqual(parseLogLine('2026-11-14 03:30:06 [INFO] ===== File backup start ====='), { time: '2026-11-14 03:30:06', level: 'INFO', message: '===== File backup start =====' });
  assert.equal(parseLogLine('2026-11-12 08:40:53 [ERROR] CHECK FAILED: x').level, 'ERROR');
  assert.equal(parseLogLine('no stamp here').level, 'INFO');
  const logs = [
    { name: 'files-backup.log', tail: ['2026-11-12 08:40:53 [ERROR] CHECK FAILED: x', '2026-11-14 08:16:03 [INFO] Check OK'] },
    { name: 'pg-backup.log', tail: ['2026-11-13 02:00:01 [WARN] slow', '2026-11-13 02:05:00 [INFO] done'] },
  ];
  assert.deepEqual(logEvents(logs).map((e) => e.time), ['2026-11-14 08:16:03', '2026-11-13 02:05:00', '2026-11-13 02:00:01', '2026-11-12 08:40:53']);
  assert.deepEqual(logEvents(logs, 'WARN').map((e) => [e.level, e.source]), [['WARN', 'pg-backup.log'], ['ERROR', 'files-backup.log']]);
  assert.equal(logEvents(logs, 'ERROR').length, 1);
});
