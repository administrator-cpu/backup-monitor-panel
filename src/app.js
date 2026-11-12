// Routes.
//   /api/agent/*          the agent, from this machine only (not via Nginx), Bearer token
//   /login, /api/login    sign-in page and form (public)
//   /api/*, the page      owner only, session cookie

import { randomUUID } from 'node:crypto';
import { ACTIONS, findAction, MAX_COMMANDS_PER_HOUR } from './actions.js';
import { readCookie, sessionCookie, sessionCookieName } from './auth.js';
import { fail, htmlMessage, json, readJson, redirect, withSecurityHeaders } from './http.js';
import { iso } from './store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REPORT_BYTES = 1024 * 1024;
const RESULT_STATUSES = ['started', 'rejected', 'failed'];
const PUBLIC_FILES = new Set(['/login', '/js/login.js', '/app.css', '/favicon.svg']);
const VIEWER = 'owner';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateReport(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'Report must be a JSON object';
  if (r.schema !== 1) return 'Unsupported report schema (expected 1)';
  for (const k of ['jobs', 'statusFiles', 'logs', 'disks']) {
    if (!Array.isArray(r[k])) return `Report field "${k}" must be a list`;
  }
  if (!r.agent || typeof r.agent !== 'object') return 'Report field "agent" is missing';
  return null;
}

export function metricsFromReport(r) {
  const disks = r.disks.slice(0, 26).map((d) => ({ name: str(d && d.name, 8), sizeBytes: num(d && d.sizeBytes), freeBytes: num(d && d.freeBytes) }));
  const b = r.backblaze;
  const b2 = b && b.enabled === true && num(b.totalBytes) !== null
    ? {
      totalBytes: num(b.totalBytes),
      checkedAt: str(b.checkedAt, 40),
      prefixes: (Array.isArray(b.prefixes) ? b.prefixes : []).slice(0, 10).map((p) => ({ prefix: str(p && p.prefix, 100), bytes: num(p && p.bytes) })),
    }
    : null;
  return { disks, b2 };
}

function agentEvents(r) {
  const list = Array.isArray(r.agent.recentErrors) ? r.agent.recentErrors : [];
  return list
    .slice(-10)
    .filter((e) => e && typeof e.at === 'string' && /^\d{4}-\d\d-\d\dT/.test(e.at) && typeof e.message === 'string')
    .map((e) => ({ at: e.at.slice(0, 40), kind: 'agent-error', message: e.message.slice(0, 500) }));
}

// Browser POSTs must come from this page: custom header, same origin, JSON.
function checkSameOrigin(request, url) {
  if (request.headers.get('X-Panel-Request') !== '1') return fail(403, 'Missing X-Panel-Request header');
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return fail(403, 'Cross-site request refused');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return fail(403, 'Cross-site request refused');
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return fail(415, 'Use application/json');
  return null;
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export function createApp({ config, store, auth, agentCheck, assets, log = console.log }) {
  const staleMinutes = Number(config.staleAfterMinutes) || 10;

  // ------------------------------------------------------------ agent
  async function agentReport(request, now) {
    const { value, error } = await readJson(request, MAX_REPORT_BYTES);
    if (error) return error;
    const problem = validateReport(value);
    if (problem) return fail(400, problem);
    const nowIso = iso(now);
    store.saveReport({ nowIso, payload: JSON.stringify(value), day: nowIso.slice(0, 10), metrics: metricsFromReport(value), events: agentEvents(value) });
    store.expireCommands(now);
    const commands = [];
    if (config.commandsEnabled && value.agent.commandsEnabled === true) {
      for (const c of store.listPending(3)) {
        if (findAction(c.action) && store.claim(c.id, nowIso)) {
          commands.push({ id: c.id, action: c.action, ageSeconds: Math.max(0, Math.round((now - Date.parse(c.requested_at)) / 1000)), requestedBy: c.requested_by });
        }
      }
    }
    return json({ ok: true, serverTime: nowIso, commands });
  }

  async function agentResult(request, id, now) {
    const { value, error } = await readJson(request, 8192);
    if (error) return error;
    const status = value && value.status;
    if (!RESULT_STATUSES.includes(status)) return fail(400, 'status must be started, rejected or failed');
    const message = typeof value.message === 'string' ? value.message.slice(0, 500) : '';
    if (!store.recordResult(id, status, message, iso(now))) return fail(409, 'No command with this id is waiting for a result');
    return json({ ok: true });
  }

  // ------------------------------------------------------------ page
  function getStatus(now) {
    store.expireCommands(now);
    const latest = store.getLatest();
    return json({
      ok: true,
      viewer: VIEWER,
      now: iso(now),
      timeZone: config.timeZone,
      staleAfterMinutes: staleMinutes,
      commandsEnabledOnPanel: config.commandsEnabled,
      maxCommandsPerHour: MAX_COMMANDS_PER_HOUR,
      actions: ACTIONS,
      report: latest
        ? { receivedAt: latest.received_at, ageSeconds: Math.max(0, Math.round((now - Date.parse(latest.received_at)) / 1000)), data: parsePayload(latest.payload) }
        : null,
      commands: store.listCommands(40),
      metrics: store.listMetrics(iso(now - 180 * 86400000).slice(0, 10)),
      events: store.listEvents('agent-error', 20),
      signIns: store.listEvents('sign-in', 5),
      failedSignIns24h: auth.failuresSince(now - 86400000),
    });
  }

  async function createCommand(request, now) {
    const { value, error } = await readJson(request, 4096);
    if (error) return error;
    const action = findAction(value && value.action);
    if (!action) return fail(400, 'Unknown action');
    if (!config.commandsEnabled) return fail(409, 'Run-now is switched off in the panel settings (commandsEnabled in panel.config.json).');
    const latest = store.getLatest();
    if (!latest) return fail(409, 'The agent has not reported yet.');
    const ageMin = (now - Date.parse(latest.received_at)) / 60000;
    if (ageMin > staleMinutes) return fail(409, `The agent has not reported for ${Math.round(ageMin)} minutes, so it would not pick the command up.`);
    const data = parsePayload(latest.payload) || {};
    const agent = data.agent || {};
    if (agent.commandsEnabled !== true) return fail(409, 'Run-now is switched off in the agent settings (CommandsEnabled in panel-agent.config.psd1).');
    if (!Array.isArray(agent.enabledActions) || !agent.enabledActions.includes(action.id)) return fail(409, 'This button is switched off in the agent settings (DisabledActions).');
    const job = (Array.isArray(data.jobs) ? data.jobs : []).find((j) => j && j.id === action.job);
    const task = job && job[action.kind] && job[action.kind].task;
    if (task && task.state === 'Running') return fail(409, `"${action.task}" is already running.`);
    store.expireCommands(now);
    if (store.activeForAction(action.id)) return fail(409, 'That command is already waiting for the agent.');
    if (store.countSince(iso(now - 3600000)) >= MAX_COMMANDS_PER_HOUR) return fail(429, `At most ${MAX_COMMANDS_PER_HOUR} commands per hour.`);
    const cmd = { id: randomUUID(), action: action.id, status: 'pending', requested_at: iso(now), requested_by: VIEWER };
    try {
      store.insertCommand(cmd);
    } catch (e) {
      if (/UNIQUE/.test(String(e && e.message))) return fail(409, 'That command is already waiting for the agent.');
      throw e;
    }
    log(`Run-now queued: ${action.task}`);
    return json({ ok: true, command: cmd }, 201);
  }

  // ------------------------------------------------------------ sign-in
  async function login(request, url, peer, now) {
    const refused = checkSameOrigin(request, url);
    if (refused) return refused;
    const { value, error } = await readJson(request, 2048);
    if (error) return error;
    const result = auth.login(value && value.password, value && value.code, peer.ip, now);
    if (!result.ok) return fail(result.status, result.error, result.retryMinutes ? { retryMinutes: result.retryMinutes } : {});
    store.addEvent({ at: iso(now), kind: 'sign-in', message: peer.ip });
    const secure = url.protocol === 'https:';
    const res = json({ ok: true });
    res.headers.append('Set-Cookie', sessionCookie(sessionCookieName(secure), result.token, secure));
    return res;
  }

  function logout(request, url) {
    const refused = checkSameOrigin(request, url);
    if (refused) return refused;
    const secure = url.protocol === 'https:';
    const name = sessionCookieName(secure);
    auth.logout(readCookie(request, name));
    const res = json({ ok: true });
    res.headers.append('Set-Cookie', sessionCookie(name, '', secure));
    return res;
  }

  // ------------------------------------------------------------ router
  async function route(request, peer, now) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/agent/')) {
      // The agent talks to 127.0.0.1 directly; anything relayed by Nginx is refused.
      if (!isLoopback(peer.address) || peer.forwarded) return fail(403, 'The agent API only answers on this machine (http://127.0.0.1), not through Nginx.');
      if (request.method !== 'POST') return fail(405, 'Use POST');
      const ok = agentCheck(request);
      if (!ok.ok) return fail(ok.status, ok.message);
      if (path === '/api/agent/report') return agentReport(request, now);
      const m = /^\/api\/agent\/commands\/([^/]+)\/result$/.exec(path);
      if (m && UUID_RE.test(m[1])) return agentResult(request, m[1], now);
      return fail(404, 'Not found');
    }

    if (path === '/api/login' && request.method === 'POST') return login(request, url, peer, now);

    const secure = url.protocol === 'https:';
    const signedIn = auth.session(readCookie(request, sessionCookieName(secure)), now);

    if (path === '/api/logout' && request.method === 'POST') return logout(request, url);

    if (path.startsWith('/api/')) {
      if (!signedIn) return fail(401, 'Please sign in.', { signIn: true });
      if (path === '/api/status' && request.method === 'GET') return getStatus(now);
      if (request.method === 'POST') {
        const refused = checkSameOrigin(request, url);
        if (refused) return refused;
        if (path === '/api/commands') return createCommand(request, now);
        const m = /^\/api\/commands\/([^/]+)\/cancel$/.exec(path);
        if (m && UUID_RE.test(m[1])) {
          if (!store.cancelCommand(m[1], VIEWER, iso(now))) return fail(409, 'Only a command that is still waiting can be cancelled.');
          return json({ ok: true });
        }
      }
      return fail(404, 'Not found');
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');
    if (path === '/login' && signedIn) return redirect('/');
    const isPublic = PUBLIC_FILES.has(path) || path.startsWith('/fonts/');
    if (!isPublic && !signedIn) return path === '/' || path.endsWith('.html') ? redirect('/login') : fail(401, 'Please sign in.', { signIn: true });
    const file = await assets(path === '/login' ? '/login.html' : path);
    if (!file) return htmlMessage(404, 'Not found', 'There is no page at this address.');
    return file;
  }

  return async function handle(request, peer, { now = Date.now() } = {}) {
    const res = await route(request, peer, now);
    return withSecurityHeaders(res, { hsts: new URL(request.url).protocol === 'https:' });
  };
}
