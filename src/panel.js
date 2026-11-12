// The panel's HTTP server. Started by src/server.js; the tests import it directly.
// Listens on 127.0.0.1 only; Nginx serves it to the internet over HTTPS.

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createAgentCheck, createAuth } from './auth.js';
import { LISTEN_HOST, loadConfig } from './config.js';
import { createAssets } from './static.js';
import { openStore } from './store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 1024 * 1024 + 4096;
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'proxy-connection', 'te', 'trailer']);

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function readNodeBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolveBody(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

// Node request -> Fetch Request (+ who sent it) -> app -> Node response.
export function createHttpServer(handle) {
  return createServer(async (req, res) => {
    try {
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = req.headers.host || `${LISTEN_HOST}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body: hasBody ? await readNodeBody(req) : undefined });
      const forwarded = Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
      const peer = { address: req.socket.remoteAddress, forwarded, ip: String(req.headers['x-real-ip'] || req.socket.remoteAddress) };
      const response = await handle(request, peer);
      const out = {};
      response.headers.forEach((v, k) => {
        out[k] = v;
      });
      res.writeHead(response.status, out);
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      const status = e && e.status === 413 ? 413 : e instanceof TypeError ? 400 : 500;
      if (status === 500) log(`Error: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 413 ? 'Request body too large' : status === 400 ? 'Bad request' : 'Internal error');
    }
  });
}

export async function startPanel(configPath, { quiet = false } = {}) {
  const config = loadConfig(configPath);
  const say = quiet ? () => {} : log;
  const store = openStore(config.dataFile, { log: say });
  const auth = createAuth({ loginFile: config.loginFile, log: say });
  const handle = createApp({ config, store, auth, agentCheck: createAgentCheck(config.agentTokenHashFile), assets: createAssets(join(ROOT, 'public')), log: say });
  const server = createHttpServer(handle);

  const housekeeping = () => {
    try {
      store.expireCommands(Date.now());
      store.cleanup(Date.now());
    } catch (e) {
      say(`Housekeeping failed: ${e.message}`);
    }
  };
  const timer = setInterval(housekeeping, 3600000);
  timer.unref();

  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(config.port, LISTEN_HOST, () => {
      say(`Backup panel listening on http://${LISTEN_HOST}:${server.address().port} (Run-now ${config.commandsEnabled ? 'on' : 'off'}, login ${auth.isSetUp() ? 'set up' : 'NOT set up: run npm run setup-login'})`);
      resolveStart({ server, config, store, auth, close: () => new Promise((r) => { clearInterval(timer); server.close(() => r()); }) });
    });
  });
}

export const DEFAULT_CONFIG = join(ROOT, 'panel.config.json');
export { log };
