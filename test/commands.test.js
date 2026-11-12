import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, call, Clock, makePanel, pageHeaders, sampleReport, signIn } from './helpers.js';

async function ready(configOverrides = {}, report = sampleReport()) {
  const panel = makePanel(configOverrides);
  const clock = new Clock();
  await agent(panel, clock, '/api/agent/report', report);
  await signIn(panel, clock);
  return { panel, clock };
}
const queue = (panel, clock, action, headers = pageHeaders) => call(panel, clock, 'POST', '/api/commands', { body: { action }, headers });
const report = (panel, clock, body = sampleReport()) => agent(panel, clock, '/api/agent/report', body);
const cancel = (panel, clock, id) => call(panel, clock, 'POST', `/api/commands/${id}/cancel`, { body: {}, headers: pageHeaders });

test('full Run-now flow: queue, hand out once, record result', async () => {
  const { panel, clock } = await ready();
  let r = await queue(panel, clock, 'run-pg-backup');
  assert.equal(r.status, 201);
  const id = r.json.command.id;
  assert.match(id, /^[0-9a-f-]{36}$/);

  clock.advance(42000);
  r = await report(panel, clock);
  assert.deepEqual(r.json.commands, [{ id, action: 'run-pg-backup', ageSeconds: 42, requestedBy: 'owner' }]);
  r = await report(panel, clock);
  assert.equal(r.json.commands.length, 0, 'a command is handed out only once');

  r = await agent(panel, clock, `/api/agent/commands/${id}/result`, { status: 'started', message: "Started scheduled task 'Postgres Nightly Backup'" });
  assert.equal(r.status, 200);
  r = await agent(panel, clock, `/api/agent/commands/${id}/result`, { status: 'failed' });
  assert.equal(r.status, 409, 'a result cannot be overwritten');

  r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.json.commands[0].status, 'started');
  assert.match(r.json.commands[0].message, /Started scheduled task/);
});

test('only allowlisted actions can be queued', async () => {
  const { panel, clock } = await ready();
  for (const bad of ['run-restore', 'RUN-PG-BACKUP', 'cmd /c del', '', null, 42, ['run-pg-backup']]) {
    const r = await call(panel, clock, 'POST', '/api/commands', { body: { action: bad }, headers: pageHeaders });
    assert.equal(r.status, 400, `refuses ${JSON.stringify(bad)}`);
  }
  assert.equal(panel.store.listCommands(10).length, 0);
});

test('page POSTs need the custom header, same origin and JSON', async () => {
  const { panel, clock } = await ready();
  assert.equal((await queue(panel, clock, 'run-pg-backup', { 'Content-Type': 'application/json' })).status, 403, 'no X-Panel-Request');
  assert.equal((await queue(panel, clock, 'run-pg-backup', { ...pageHeaders, Origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await queue(panel, clock, 'run-pg-backup', { ...pageHeaders, 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site');
  assert.equal((await queue(panel, clock, 'run-pg-backup', { ...pageHeaders, 'Content-Type': 'text/plain' })).status, 415, 'form-style body');
});

test('switches: panel off, agent off, action disabled in the agent settings', async () => {
  let { panel, clock } = await ready({ commandsEnabled: false });
  let r = await queue(panel, clock, 'run-pg-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /panel\.config\.json/);
  assert.equal(r.json.signIn, undefined, 'a settings refusal is not a sign-in problem');

  const off = sampleReport();
  off.agent.commandsEnabled = false;
  off.agent.enabledActions = [];
  ({ panel, clock } = await ready({}, off));
  r = await queue(panel, clock, 'run-pg-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /CommandsEnabled/);

  const partial = sampleReport();
  partial.agent.enabledActions = ['run-pg-check'];
  ({ panel, clock } = await ready({}, partial));
  r = await queue(panel, clock, 'run-pg-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /DisabledActions/);
  assert.equal((await queue(panel, clock, 'run-pg-check')).status, 201);
});

test('commands are not handed to an agent that has Run-now switched off', async () => {
  const { panel, clock } = await ready();
  await queue(panel, clock, 'run-pg-backup');
  const off = sampleReport();
  off.agent.commandsEnabled = false;
  assert.equal((await report(panel, clock, off)).json.commands.length, 0);
  assert.equal((await report(panel, clock)).json.commands.length, 1);
});

test('panel switched off after queueing: nothing is handed out', async () => {
  const { panel, clock } = await ready();
  await queue(panel, clock, 'run-pg-backup');
  panel.config.commandsEnabled = false;
  assert.equal((await report(panel, clock)).json.commands.length, 0);
});

test('no duplicates, no queueing while running, no queueing when stale', async () => {
  let { panel, clock } = await ready();
  assert.equal((await queue(panel, clock, 'run-files-backup')).status, 201);
  let r = await queue(panel, clock, 'run-files-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already waiting/);

  const running = sampleReport();
  running.jobs[1].backup.task.state = 'Running';
  ({ panel, clock } = await ready({}, running));
  r = await queue(panel, clock, 'run-mongo-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already running/);
  assert.equal((await queue(panel, clock, 'run-mongo-check')).status, 201, 'the check can still run');

  ({ panel, clock } = await ready());
  clock.advance(11 * 60000);
  r = await queue(panel, clock, 'run-pg-backup');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /has not reported/);
});

test('the store itself refuses a second waiting command for the same action', () => {
  const panel = makePanel();
  const base = { action: 'run-pg-backup', requested_at: '2026-11-11T08:00:00Z', requested_by: 'owner' };
  panel.store.insertCommand({ ...base, id: 'a', status: 'pending' });
  assert.throws(() => panel.store.insertCommand({ ...base, id: 'b', status: 'pending' }), /UNIQUE/);
  panel.store.insertCommand({ ...base, id: 'c', status: 'started' });
});

test('rate limit: at most 10 commands per hour', async () => {
  const { panel, clock } = await ready();
  const actions = ['run-pg-backup', 'run-pg-check', 'run-mongo-backup', 'run-mongo-check', 'run-files-backup', 'run-files-check'];
  let made = 0;
  for (let round = 0; round < 2; round++) {
    for (const a of actions) {
      const r = await queue(panel, clock, a);
      if (r.status === 201) {
        made++;
        await cancel(panel, clock, r.json.command.id);
      } else {
        assert.equal(r.status, 429);
      }
      clock.advance(1000);
      await report(panel, clock);
    }
  }
  assert.equal(made, 10);
  clock.advance(3600000);
  await report(panel, clock);
  assert.equal((await queue(panel, clock, 'run-pg-backup')).status, 201, 'allowed again an hour later');
});

test('pending commands expire after 15 minutes; unanswered ones become no-reply', async () => {
  const { panel, clock } = await ready();
  const a = (await queue(panel, clock, 'run-pg-backup')).json.command.id;
  clock.advance(16 * 60000);
  assert.equal((await report(panel, clock)).json.commands.length, 0, 'an expired command is never handed out');
  let r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.json.commands.find((c) => c.id === a).status, 'expired');

  const b = (await queue(panel, clock, 'run-pg-backup')).json.command.id;
  assert.equal((await report(panel, clock)).json.commands[0].id, b);
  clock.advance(16 * 60000);
  await report(panel, clock);
  r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.json.commands.find((c) => c.id === b).status, 'no-reply');
  r = await agent(panel, clock, `/api/agent/commands/${b}/result`, { status: 'started', message: 'late' });
  assert.equal(r.status, 200, 'a late answer is still recorded');
});

test('cancel works only while pending', async () => {
  const { panel, clock } = await ready();
  const id = (await queue(panel, clock, 'run-pg-backup')).json.command.id;
  await report(panel, clock);
  assert.equal((await cancel(panel, clock, id)).status, 409, 'already with the agent');
  const id2 = (await queue(panel, clock, 'run-pg-check')).json.command.id;
  assert.equal((await cancel(panel, clock, id2)).status, 200);
  assert.equal((await report(panel, clock)).json.commands.length, 0, 'a cancelled command is never handed out');
});

test('at most three commands per report', async () => {
  const { panel, clock } = await ready();
  for (const a of ['run-pg-backup', 'run-pg-check', 'run-mongo-backup', 'run-mongo-check']) await queue(panel, clock, a);
  assert.equal((await report(panel, clock)).json.commands.length, 3);
  assert.equal((await report(panel, clock)).json.commands.length, 1);
});
