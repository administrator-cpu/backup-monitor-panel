// Test helpers: the real app with an in-memory store, a temporary login file,
// a fixed clock and helpers to sign in or act as the agent.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { base32Encode, createAgentCheck, createAuth, hashPassword, sha256Hex, totpAt } from '../src/auth.js';
import { openStore } from '../src/store.js';

export const AGENT_TOKEN = 'test-agent-token-abcdefghijklmnopqrstuvwxyz012345';
export const PASSWORD = 'correct horse battery staple';
export const TOTP_SECRET = Buffer.from('12345678901234567890');
export const ORIGIN = 'https://backups.example.com';
export const LOCAL = { address: '127.0.0.1', forwarded: false, ip: '127.0.0.1' };
export const VIA_NGINX = { address: '127.0.0.1', forwarded: true, ip: '203.0.113.7' };

const PASSWORD_HASH = hashPassword(PASSWORD); // scrypt is slow; hash once

export class Clock {
  constructor(start = Date.parse('2026-11-11T08:00:00Z')) {
    this.t = start;
  }
  now = () => this.t;
  advance(ms) {
    this.t += ms;
  }
}

export function code(clock, offsetSteps = 0) {
  return totpAt(TOTP_SECRET, Math.floor(clock.now() / 30000) + offsetSteps);
}

export function makePanel(configOverrides = {}, { loginSetUp = true, agentHash = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-test-'));
  const loginFile = join(dir, 'login.json');
  const hashFile = join(dir, 'agent.sha256');
  if (loginSetUp) writeFileSync(loginFile, JSON.stringify({ version: 1, passwordHash: PASSWORD_HASH, totpSecret: base32Encode(TOTP_SECRET) }));
  if (agentHash) writeFileSync(hashFile, `${sha256Hex(AGENT_TOKEN)}\r\n`);
  const config = { port: 7480, commandsEnabled: true, timeZone: 'Asia/Kolkata', staleAfterMinutes: 10, dataFile: null, loginFile, agentTokenHashFile: hashFile, ...configOverrides };
  const store = openStore(null, { log: () => {} });
  const auth = createAuth({ loginFile, log: () => {} });
  const assets = async (path) => (['/index.html', '/login.html', '/app.css', '/js/login.js', '/js/main.js'].includes(path === '/' ? '/index.html' : path)
    ? new Response(`asset ${path}`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' } })
    : null);
  const handle = createApp({ config, store, auth, agentCheck: createAgentCheck(hashFile), assets, log: () => {} });
  return { config, store, auth, handle, dir, cookie: null };
}

export async function call(panel, clock, method, path, { headers = {}, body, peer = VIA_NGINX, origin = ORIGIN, cookie = panel.cookie } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }
  const res = await panel.handle(new Request(origin + path, init), peer, { now: clock.now() });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

export const pageHeaders = { 'X-Panel-Request': '1', Origin: ORIGIN, 'Content-Type': 'application/json' };

export async function signIn(panel, clock, { offsetSteps = 0 } = {}) {
  const r = await call(panel, clock, 'POST', '/api/login', { headers: pageHeaders, body: { password: PASSWORD, code: code(clock, offsetSteps) }, cookie: null });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${r.text}`);
  panel.cookie = r.headers.get('Set-Cookie').split(';')[0];
  return r;
}

export const agent = (panel, clock, path, body, extra = {}) =>
  call(panel, clock, 'POST', path, { body, headers: { Authorization: `Bearer ${AGENT_TOKEN}` }, peer: LOCAL, origin: 'http://127.0.0.1:7480', cookie: null, ...extra });

export function sampleReport(overrides = {}) {
  const task = (name, extra = {}) => ({ name, found: true, path: '\\', state: 'Ready', lastRunAt: '2026-11-10T20:30:00Z', lastResult: 0, nextRunAt: '2026-11-11T20:30:00Z', missedRuns: 0, error: null, ...extra });
  const job = (id, label, b, c) => ({
    id, label, maxAgeHours: 26, logFile: `${id}-backup.log`, statusFiles: [`${id}-last-success.json`],
    lastSuccessAt: '2026-11-10T20:35:00Z', lastFailureAt: null,
    backup: { action: `run-${id}-backup`, task: task(b) },
    check: { action: `run-${id}-check`, task: task(c) },
  });
  const r = {
    schema: 1,
    agentVersion: '1.0.0',
    host: 'VPS-TEST',
    generatedAt: '2026-11-11T08:00:00Z',
    utcOffsetMinutes: 330,
    agent: {
      commandsEnabled: true,
      enabledActions: ['run-pg-backup', 'run-pg-check', 'run-mongo-backup', 'run-mongo-check', 'run-files-backup', 'run-files-check'],
      psVersion: '5.1.17763.1',
      recentErrors: [],
      collectErrors: [],
    },
    diskWarnFreeGB: 60,
    jobs: [
      job('pg', 'Postgres', 'Postgres Nightly Backup', 'Postgres Backup Check'),
      job('mongo', 'MongoDB', 'MongoDB Nightly Backup', 'MongoDB Backup Check'),
      job('files', 'Files and logs', 'Files Nightly Backup', 'Files Backup Check'),
    ],
    statusFiles: [{ name: 'pg-last-success.json', job: 'pg', modifiedAt: '2026-11-10T20:35:00Z', sizeBytes: 100, content: { sizeBytes: 123456 }, error: null }],
    logs: [{ name: 'pg-backup.log', job: 'pg', found: true, modifiedAt: '2026-11-10T20:35:00Z', sizeBytes: 2000, tail: ['ok'], problems: [], error: null }],
    disks: [
      { name: 'C:', label: '', sizeBytes: 200e9, freeBytes: 80e9 },
      { name: 'F:', label: 'Data', sizeBytes: 452e9, freeBytes: 289e9 },
    ],
    backblaze: { enabled: true, checkedAt: '2026-11-11T06:00:00Z', bucket: 'b', prefixes: [{ prefix: 'restic-logs/', bytes: 3e9, files: 200, complete: true }], totalBytes: 3e9, pricePerTBMonth: 6.95, freeGB: 10 },
  };
  return { ...r, ...overrides };
}
