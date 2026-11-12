import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, call, Clock, LOCAL, makePanel, sampleReport, signIn, VIA_NGINX } from './helpers.js';

test('agent endpoints refuse callers without the right token', async () => {
  const panel = makePanel();
  const clock = new Clock();
  let r = await agent(panel, clock, '/api/agent/report', sampleReport(), { headers: {} });
  assert.equal(r.status, 401);
  r = await agent(panel, clock, '/api/agent/report', sampleReport(), { headers: { Authorization: 'Bearer wrong-token-but-long-enough-xyz' } });
  assert.equal(r.status, 401);
  r = await agent(panel, clock, '/api/agent/report', sampleReport(), { headers: { Authorization: 'Basic abc' } });
  assert.equal(r.status, 401);
  r = await call(panel, clock, 'GET', '/api/agent/report', { peer: LOCAL });
  assert.equal(r.status, 405);
  const noHash = makePanel({}, { agentHash: false });
  r = await agent(noHash, clock, '/api/agent/report', sampleReport());
  assert.equal(r.status, 503, 'fails closed until panel-agent-setup.ps1 -NewToken has run');
  assert.match(r.json.error, /-NewToken/);
});

test('the agent API answers only on this machine, never through Nginx', async () => {
  const panel = makePanel();
  const clock = new Clock();
  let r = await agent(panel, clock, '/api/agent/report', sampleReport(), { peer: VIA_NGINX });
  assert.equal(r.status, 403, 'a request relayed by Nginx is refused even with the right token');
  r = await agent(panel, clock, '/api/agent/report', sampleReport(), { peer: { address: '10.0.0.5', forwarded: false, ip: '10.0.0.5' } });
  assert.equal(r.status, 403, 'a request from another machine is refused');
  r = await agent(panel, clock, '/api/agent/report', sampleReport(), { peer: { address: '::1', forwarded: false, ip: '::1' } });
  assert.equal(r.status, 200, 'IPv6 loopback works');
});

test('a new token fingerprint is picked up without a restart', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { sha256Hex } = await import('../src/auth.js');
  const panel = makePanel();
  const clock = new Clock();
  assert.equal((await agent(panel, clock, '/api/agent/report', sampleReport())).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(panel.dir, 'agent.sha256'), sha256Hex('a-brand-new-token-1234567890abcdef'));
  assert.equal((await agent(panel, clock, '/api/agent/report', sampleReport())).status, 401, 'old token stops working');
  const r = await agent(panel, clock, '/api/agent/report', sampleReport(), { headers: { Authorization: 'Bearer a-brand-new-token-1234567890abcdef' } });
  assert.equal(r.status, 200, 'new token works');
});

test('agent report is stored and shown on the status API', async () => {
  const panel = makePanel();
  const clock = new Clock();
  let r = await agent(panel, clock, '/api/agent/report', sampleReport());
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.commands, []);
  clock.advance(30000);
  await signIn(panel, clock);
  r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.report.data.host, 'VPS-TEST');
  assert.equal(r.json.report.ageSeconds, 30);
  assert.equal(r.json.metrics.length, 1);
  assert.equal(r.json.metrics[0].disks[1].name, 'F:');
  assert.equal(r.json.metrics[0].b2.totalBytes, 3e9);
  assert.equal(r.json.actions.length, 6);
  assert.equal(r.json.signIns.length, 1, 'the sign-in is listed');
  assert.equal(r.json.signIns[0].message, '203.0.113.7');
  await agent(panel, clock, '/api/agent/report', sampleReport());
  r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.json.metrics.length, 1, 'same day, same metrics row');
});

test('bad or oversized reports are refused', async () => {
  const panel = makePanel();
  const clock = new Clock();
  assert.equal((await agent(panel, clock, '/api/agent/report', { schema: 2 })).status, 400);
  assert.equal((await agent(panel, clock, '/api/agent/report', '{not json')).status, 400);
  assert.equal((await agent(panel, clock, '/api/agent/report', sampleReport({ jobs: 'x' }))).status, 400);
  const huge = sampleReport({ logs: [{ name: 'x', tail: ['a'.repeat(1100 * 1024)] }] });
  assert.equal((await agent(panel, clock, '/api/agent/report', huge)).status, 413);
});

test('agent errors from failed runs are kept once as events', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const report = sampleReport();
  report.agent.recentErrors = [{ at: '2026-11-11T07:00:00Z', message: 'Panel request failed: timeout' }, { at: 'bad', message: 'x' }];
  await agent(panel, clock, '/api/agent/report', report);
  await agent(panel, clock, '/api/agent/report', report);
  await signIn(panel, clock);
  const r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.json.events.length, 1);
  assert.equal(r.json.events[0].message, 'Panel request failed: timeout');
});

test('result endpoint validates input', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal((await agent(panel, clock, `/api/agent/commands/${id}/result`, { status: 'started' })).status, 409);
  assert.equal((await agent(panel, clock, `/api/agent/commands/${id}/result`, { status: 'done-ish' })).status, 400);
  assert.equal((await agent(panel, clock, '/api/agent/commands/not-a-uuid/result', { status: 'started' })).status, 404);
});
