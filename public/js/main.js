// Page controller: polling, rendering, the Run-now dialog and notices.

import { cancelCommand, getStatus, queueCommand, saveNote, signOut, SignedOut } from './api.js';
import { h } from './dom.js';
import { ago, makeFormatter, viewerTimeZone, zoneLabel, zoneOffsetMinutes } from './format.js';
import { commandsMode, isStale } from './health.js';
import * as view from './views.js';

const POLL_MS = 20000;
const POLL_WAITING_MS = 5000;
const TICK_MS = 10000;
const MAX_RETRY_MS = 120000;

const app = document.getElementById('app');
const el = {
  host: document.getElementById('host'),
  freshness: document.getElementById('freshness'),
  freshnessText: document.getElementById('freshness-text'),
  mode: document.getElementById('mode'),
  refresh: document.getElementById('refresh'),
  signout: document.getElementById('signout'),
  dialog: document.getElementById('confirm'),
  notices: document.getElementById('notices'),
};

const SERVER_ZONE_FALLBACK = 'Asia/Kolkata';
const VIEWER_ZONE = viewerTimeZone();

// Remembered per browser: show times in server time (default) or the viewer's own.
function readZoneChoice() {
  try {
    return localStorage.getItem('backup-panel-zone') === 'mine' ? 'mine' : 'server';
  } catch {
    return 'server';
  }
}

const ui = {
  state: null,
  skew: 0,
  zoneChoice: readZoneChoice(),
  fmt: makeFormatter(SERVER_ZONE_FALLBACK),
  points: 'pg',
  pointsFrom: '',
  pointsTo: '',
  pointsAll: false,
  logLevel: 'WARN',
  tab: 'logs',
  busy: null,
  error: null,
  retryMs: POLL_MS,
  signedOut: null,
  signature: '',
  renderedStale: null,
  seen: new Map(),
  timer: 0,
  fetching: false,
};

const now = () => Date.now() + ui.skew;

// ------------------------------------------------------------------ render

const serverZone = () => ui.state?.timeZone || SERVER_ZONE_FALLBACK;
const shownZone = () => (ui.zoneChoice === 'mine' && VIEWER_ZONE ? VIEWER_ZONE : serverZone());

function zoneInfo(t) {
  const server = serverZone();
  let differs = false;
  try {
    differs = !!VIEWER_ZONE && zoneOffsetMinutes(VIEWER_ZONE, t) !== zoneOffsetMinutes(server, t);
  } catch {
    differs = false;
  }
  const mine = differs && ui.zoneChoice === 'mine';
  return {
    differs,
    mine,
    serverLabel: zoneLabel(server, t),
    viewerLabel: differs ? zoneLabel(VIEWER_ZONE, t) : '',
    onToggle: () => {
      ui.zoneChoice = mine ? 'server' : 'mine';
      try {
        localStorage.setItem('backup-panel-zone', ui.zoneChoice);
      } catch {
        // Private windows may refuse storage; the choice then lasts for this page only.
      }
      ui.fmt = makeFormatter(shownZone());
      render();
    },
  };
}

function context() {
  const t = now();
  return {
    state: ui.state,
    now: t,
    fmt: ui.fmt,
    zone: zoneInfo(t),
    open: new Set([...app.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key)),
    busy: ui.busy,
    tab: ui.tab,
    points: { set: ui.points, from: ui.pointsFrom, to: ui.pointsTo, all: ui.pointsAll },
    onPoints: (change, focus) => {
      if ('set' in change) {
        ui.points = change.set;
        ui.pointsAll = false;
      }
      if ('from' in change) ui.pointsFrom = change.from;
      if ('to' in change) ui.pointsTo = change.to;
      if ('all' in change) ui.pointsAll = change.all;
      render();
      if (focus) app.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
    },
    logLevel: ui.logLevel,
    onLogLevel: (level) => {
      ui.logLevel = level;
      render();
      app.querySelector(`[data-focus="level:${level}"]`)?.focus();
    },
    onNote: saveReminder,
    onRun: runAction,
    onCancel: cancel,
    onTab: (tab, focus) => {
      ui.tab = tab;
      render();
      if (focus) app.querySelector(`[data-focus="tab:${tab}"]`)?.focus();
    },
  };
}

function render() {
  const focusKey = document.activeElement?.closest?.('[data-focus]')?.dataset.focus;
  const scrollY = window.scrollY;
  const ctx = context();
  const parts = [];

  if (ui.signedOut) {
    app.replaceChildren(view.signedOut());
    renderMasthead();
    return;
  }
  if (!ui.state) {
    app.replaceChildren(ui.error ? view.refreshError(ui.error, null, Math.round(ui.retryMs / 1000), () => load(), ctx) : view.loading());
    renderMasthead();
    return;
  }
  if (ui.error) parts.push(view.refreshError(ui.error, ui.state.report?.receivedAt, Math.round(ui.retryMs / 1000), () => load(), ctx));
  parts.push(view.summary(ctx));
  if (ui.state.report?.data) {
    parts.push(view.backups(ctx), view.runHistory(ctx), view.restorePoints(ctx), view.storage(ctx), view.reminders(ctx),
      view.history(ctx), view.agent(ctx), view.signIns(ctx), view.raw(ctx));
  } else {
    parts.push(view.history(ctx), view.signIns(ctx));
  }
  app.replaceChildren(...parts);
  ui.renderedStale = isStale(ui.state, ctx.now);
  renderMasthead();

  window.scrollTo(0, scrollY);
  if (focusKey) app.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function renderMasthead() {
  const state = ui.state;
  el.refresh.disabled = ui.fetching;
  el.freshness.classList.toggle('is-fetching', ui.fetching);
  const report = state?.report;
  if (ui.signedOut) {
    el.freshness.dataset.state = 'bad';
    el.freshnessText.textContent = 'Signed out';
  } else if (!report) {
    el.freshness.dataset.state = state ? 'idle' : 'loading';
    el.freshnessText.textContent = state ? 'No report yet' : 'Connecting…';
  } else {
    const stale = isStale(state, now());
    el.freshness.dataset.state = stale ? 'bad' : 'ok';
    el.freshnessText.textContent = `Reported ${ago(report.receivedAt, now())}`;
  }
  el.host.textContent = report?.data?.host || '';
  el.host.hidden = !el.host.textContent;
  el.refresh.hidden = !!ui.signedOut;
  el.signout.hidden = !!ui.signedOut;
  if (state && report?.data && !ui.signedOut) {
    const mode = commandsMode(state);
    el.mode.hidden = false;
    el.mode.textContent = mode.on ? 'Run-now on' : 'Read-only';
    el.mode.dataset.on = String(mode.on);
    el.mode.title = mode.on ? 'The Run-now buttons can start the six backup and check tasks.' : mode.reason;
  } else {
    el.mode.hidden = true;
  }
}

// Relative times ("12 min ago") move on without rebuilding the page.
function tick() {
  if (!ui.state) return;
  const t = now();
  if (isStale(ui.state, t) !== ui.renderedStale) {
    render();
    return;
  }
  for (const node of app.querySelectorAll('[data-ago]')) node.textContent = ago(node.dataset.ago, t);
  renderMasthead();
}

// Only rebuild when the data changed, so focus and open sections stay put.
function signatureOf(state) {
  const { now: _now, report, ...rest } = state;
  return JSON.stringify({ ...rest, report: report && { receivedAt: report.receivedAt, data: report.data } });
}

// ------------------------------------------------------------------ data

async function load() {
  if (ui.fetching) return;
  clearTimeout(ui.timer);
  ui.fetching = true;
  renderMasthead();
  let changed = false;
  try {
    const state = await getStatus();
    ui.skew = Date.parse(state.now) - Date.now();
    ui.fmt = makeFormatter(ui.zoneChoice === 'mine' && VIEWER_ZONE ? VIEWER_ZONE : state.timeZone || SERVER_ZONE_FALLBACK);
    noticeTransitions(state);
    const sig = signatureOf(state);
    changed = sig !== ui.signature || ui.error !== null;
    ui.signature = sig;
    ui.state = state;
    ui.error = null;
    ui.retryMs = POLL_MS;
  } catch (e) {
    if (e instanceof SignedOut) {
      ui.signedOut = { reason: e.message };
      ui.fetching = false;
      render();
      return;
    }
    ui.error = e.message;
    ui.retryMs = Math.min(MAX_RETRY_MS, ui.retryMs * 2);
    changed = true;
  } finally {
    ui.fetching = false;
  }
  if (changed) render();
  else tick();
  schedule();
}

function schedule() {
  clearTimeout(ui.timer);
  const waiting = (ui.state?.commands || []).some((c) => c.status === 'pending' || c.status === 'sent');
  const delay = ui.error ? ui.retryMs : waiting ? POLL_WAITING_MS : POLL_MS;
  ui.timer = setTimeout(() => {
    if (document.visibilityState === 'visible') load();
    else schedule();
  }, delay);
}

// ------------------------------------------------------------------ notices

const sentence = (m) => (m && !/[.!?]$/.test(m) ? `${m}.` : m);

const OUTCOME = {
  started: ['ok', (t) => `${t} started on the server.`],
  rejected: ['warn', (t, m) => `${t} was not started. ${sentence(m)}`],
  failed: ['bad', (t, m) => `${t} could not be started. ${sentence(m)}`],
  expired: ['warn', (t) => `${t} expired: the agent did not collect it within 15 minutes.`],
  'no-reply': ['warn', (t) => `${t}: the agent took the request but did not say what happened.`],
};

function noticeTransitions(state) {
  const tasks = Object.fromEntries((state.actions || []).map((a) => [a.id, a.task]));
  for (const c of state.commands || []) {
    const before = ui.seen.get(c.id);
    if (before && before !== c.status && OUTCOME[c.status]) {
      const [level, text] = OUTCOME[c.status];
      notify(level, text(tasks[c.action] || c.action, c.message || ''));
    }
    ui.seen.set(c.id, c.status);
  }
}

function notify(level, text) {
  const item = h('div', { class: `notice notice-${level}` },
    h('p', null, text),
    h('button', { type: 'button', class: 'notice-close', 'aria-label': 'Dismiss', onclick: () => item.remove() }, '×'));
  el.notices.append(item);
  setTimeout(() => item.remove(), level === 'ok' ? 6000 : 12000);
}

// ------------------------------------------------------------------ Run-now

function confirmRun(action) {
  const d = el.dialog;
  const { next, last } = view.nextRunLine(action, context());
  d.querySelector('#confirm-title').textContent = `Start “${action.task}” now?`;
  d.querySelector('#confirm-what').textContent = action.kind === 'backup'
    ? 'It runs exactly like the nightly job: the same script, Windows user and e-mails.'
    : 'It runs the same check as every morning and e-mails you if it finds a problem.';
  d.querySelector('#confirm-next').textContent = next;
  d.querySelector('#confirm-last').textContent = last;
  d.querySelector('#confirm-extra').textContent = action.id === 'run-files-backup'
    ? 'On Sundays this job also runs the weekly prune and check, which take much longer.'
    : '';
  const ok = d.querySelector('#confirm-ok');
  const no = d.querySelector('[data-close="cancel"]');
  ok.textContent = action.kind === 'backup' ? 'Start backup' : 'Start check';
  // Settle straight from the buttons and Escape; the dialog's own close event
  // is only a fallback (some browsers deliver it late, e.g. in background tabs).
  return new Promise((resolve) => {
    let settled = false;
    const finish = (yes) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener('click', onOk);
      no.removeEventListener('click', onNo);
      d.removeEventListener('cancel', onNo);
      d.removeEventListener('close', onClose);
      if (d.open) d.close();
      resolve(yes);
    };
    const onOk = () => finish(true);
    const onNo = () => finish(false);
    const onClose = () => finish(false);
    ok.addEventListener('click', onOk);
    no.addEventListener('click', onNo);
    d.addEventListener('cancel', onNo);
    d.addEventListener('close', onClose);
    d.showModal();
    no.focus(); // the safe choice is the default
  });
}

async function runAction(action) {
  if (!(await confirmRun(action))) return;
  ui.busy = action.id;
  render();
  try {
    const res = await queueCommand(action.id);
    ui.seen.set(res.command.id, 'pending');
    notify('run', `Queued ${action.task}. The agent collects it within about a minute.`);
  } catch (e) {
    if (e instanceof SignedOut) ui.signedOut = { reason: e.message };
    else notify('bad', `Not queued: ${e.message}`);
  }
  ui.busy = null;
  await load();
}

// Reminders: save one change, then show the panel's answer.
async function saveReminder(change, focusKey) {
  try {
    const res = await saveNote(change);
    if (ui.state) ui.state = { ...ui.state, notes: res.notes };
    notify('ok', 'Saved.');
  } catch (e) {
    if (e instanceof SignedOut) ui.signedOut = { reason: e.message };
    else notify('bad', `Not saved: ${e.message}`);
  }
  await load();
  if (focusKey) app.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
}

async function cancel(command) {
  const task = ui.state.actions.find((a) => a.id === command.action)?.task || command.action;
  try {
    await cancelCommand(command.id);
    ui.seen.set(command.id, 'cancelled');
    notify('idle', `Cancelled ${task}.`);
  } catch (e) {
    notify('warn', e.message);
  }
  await load();
}

// ------------------------------------------------------------------ start

el.refresh.addEventListener('click', () => load());
el.signout.addEventListener('click', async () => {
  try {
    await signOut();
  } finally {
    window.location.assign('/login');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});
setInterval(tick, TICK_MS);
render();
load();
