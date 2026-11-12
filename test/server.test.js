// The real HTTP server on a random port, with files on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { startPanel } from '../src/server.js';
import { openStore } from '../src/store.js';
import { AGENT_TOKEN, sampleReport } from './helpers.js';

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function tempConfig(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-srv-'));
  writeFileSync(join(dir, 'agent.sha256'), sha256Hex(AGENT_TOKEN));
  const cfg = { port: await freePort(), dataFile: 'data/state.json', loginFile: 'login.json', agentTokenHashFile: 'agent.sha256', ...extra };
  const path = join(dir, 'panel.config.json');
  writeFileSync(path, JSON.stringify(cfg));
  return { dir, path };
}

// Raw requests, so paths are sent exactly as written (fetch would normalise ../).
function raw(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('config: unknown or bad settings are refused, paths resolve next to the file', async () => {
  const { dir, path } = await tempConfig();
  const cfg = loadConfig(path);
  assert.equal(cfg.dataFile, join(dir, 'data', 'state.json'));
  writeFileSync(path, JSON.stringify({ comandsEnabled: true }));
  assert.throws(() => loadConfig(path), /Unknown setting/);
  writeFileSync(path, JSON.stringify({ commandsEnabled: 'yes' }));
  assert.throws(() => loadConfig(path), /true or false/);
  writeFileSync(path, JSON.stringify({ timeZone: 'Mars/Olympus' }));
  assert.throws(() => loadConfig(path), /time zone/);
  assert.throws(() => loadConfig(join(dir, 'missing.json')), /Copy panel\.config\.example\.json/);
});

test('the shipped config template is valid and starts read-only', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../panel.config.example.json', import.meta.url)));
  assert.equal(cfg.commandsEnabled, false);
  assert.equal(cfg.port, 7480);
});

test('the server listens on 127.0.0.1, serves files safely and stores data on disk', async (t) => {
  const { dir, path } = await tempConfig();
  const panel = await startPanel(path, { quiet: true });
  t.after(() => panel.close());
  const { address, port } = panel.server.address();
  assert.equal(address, '127.0.0.1');

  let r = await raw(port, 'GET', '/login');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /Authenticator code/);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);

  r = await raw(port, 'GET', '/fonts/ibm-plex-sans-latin-400-normal.woff2');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'font/woff2');

  r = await raw(port, 'GET', '/');
  assert.equal(r.status, 302);

  for (const evil of ['/fonts/../../package.json', '/fonts/..%2f..%2fpackage.json', '/fonts/%2e%2e/%2e%2e/src/auth.js', '/fonts/..\\..\\package.json']) {
    r = await raw(port, 'GET', evil);
    assert.ok([400, 401, 404].includes(r.status), `${evil} -> ${r.status}`);
    assert.doesNotMatch(r.text, /"name": "backup-monitor-panel"|createHash/, `${evil} must not leak files`);
  }

  r = await raw(port, 'HEAD', '/login');
  assert.equal(r.status, 200);
  assert.equal(r.text, '');

  const body = JSON.stringify(sampleReport());
  r = await raw(port, 'POST', '/api/agent/report', { headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
  assert.equal(r.status, 200, r.text);
  r = await raw(port, 'POST', '/api/agent/report', { headers: { Authorization: `Bearer ${AGENT_TOKEN}`, 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.7', 'Content-Length': Buffer.byteLength(body) }, body });
  assert.equal(r.status, 403, 'relayed through Nginx (X-Real-IP set) is refused');

  const big = 'x'.repeat(1200 * 1024);
  r = await raw(port, 'POST', '/api/agent/report', { headers: { 'Content-Length': big.length }, body: big });
  assert.equal(r.status, 413);

  r = await raw(port, 'GET', '/x', { headers: { Host: 'bad host name' } });
  assert.ok(r.status === 400 || r.status === 404, `bad Host -> ${r.status}`);

  const state = JSON.parse(readFileSync(join(dir, 'data', 'state.json'), 'utf8'));
  assert.equal(JSON.parse(state.latest.payload).host, 'VPS-TEST');
  assert.ok(!existsSync(join(dir, 'data', 'state.json.tmp')), 'no temp file left behind');
});

test('the store survives a restart and sets aside an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-store-'));
  const file = join(dir, 'state.json');
  const a = openStore(file, { log: () => {} });
  a.insertCommand({ id: 'x', action: 'run-pg-check', status: 'pending', requested_at: '2026-11-11T08:00:00Z', requested_by: 'owner' });
  const b = openStore(file, { log: () => {} });
  assert.equal(b.listCommands(5)[0].id, 'x');
  writeFileSync(file, '{ half a file');
  const notes = [];
  const c = openStore(file, { log: (m) => notes.push(m) });
  assert.equal(c.listCommands(5).length, 0);
  assert.match(notes[0], /kept it as .*unreadable/);
});
