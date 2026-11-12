// Page sections. Each function takes the render context and returns DOM.
// ctx: { state, now, fmt, open, busy, tab, onRun, onCancel, onTab }

import { h, s, glyph, tag } from './dom.js';
import { ago, binBytes, decBytes, plural, until } from './format.js';
import {
  actionState, b2Estimate, commandsMode, diskForecast, findSize, freshness, isStale,
  jobHealth, lastGoodAt, resultText, successFile, verdict,
} from './health.js';

const agoEl = (iso, now) => h('time', { datetime: iso || '', 'data-ago': iso || '' }, ago(iso, now));

function stamp(iso, ctx) {
  if (!iso) return '—';
  return [ctx.fmt.time(iso), h('span', { class: 'quiet' }, ' · ', agoEl(iso, ctx.now))];
}

function sectionHead(title, meta, id) {
  return h('div', { class: 'section-head' }, h('h2', { id }, title), meta ? h('p', { class: 'section-meta' }, meta) : null);
}

function details(ctx, key, summary, ...body) {
  return h('details', { class: 'fold', 'data-key': key, open: ctx.open.has(key) }, h('summary', null, summary), ...body);
}

function meter(ratio, level, label) {
  const bar = h('i');
  bar.style.width = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
  return h('div', { class: `meter meter-${level}`, role: 'img', 'aria-label': label }, bar);
}

function sparkline(values, label, top) {
  const w = 132;
  const ht = 28;
  const svgEl = s('svg', { class: 'spark', width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, role: 'img', 'aria-label': label });
  if (values.length < 2) return svgEl;
  const max = Math.max(top || 0, ...values) || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 2) + 1, ht - 1 - (v / max) * (ht - 3)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  svgEl.append(s('path', { class: 'spark-fill', d: `${line} L${pts[pts.length - 1][0].toFixed(1)} ${ht} L1 ${ht} Z` }), s('path', { class: 'spark-line', d: line }));
  return svgEl;
}

// ---------------------------------------------------------------- summary

export function summary(ctx) {
  const v = verdict(ctx.state, ctx.now, ctx.fmt);
  return h('section', { class: `summary summary-${v.level}`, 'aria-label': 'Summary' },
    h('div', { class: 'summary-mark' }, glyph(v.level)),
    h('div', null,
      h('p', { class: 'headline' }, v.headline),
      v.detail.length > 1
        ? h('ul', { class: 'summary-list' }, v.detail.map((d) => h('li', null, d)))
        : v.detail.map((d) => h('p', { class: 'summary-detail' }, d))));
}

// ---------------------------------------------------------------- backups

function jobRow(job, ctx) {
  const { state, now, fmt } = ctx;
  const data = state.report.data;
  const health = jobHealth(job, now);
  const fresh = freshness(job, now);
  const bt = (job.backup && job.backup.task) || {};
  const ct = (job.check && job.check.task) || {};
  const okAt = lastGoodAt(job);
  const okIso = okAt === null ? null : new Date(okAt).toISOString();
  const sf = successFile(job, data.statusFiles);
  const size = sf ? findSize(sf.content) : null;
  const log = (data.logs || []).find((l) => l.name === job.logFile);
  const problems = (log && log.problems) || [];
  const mode = commandsMode(state);

  const row = h('article', { class: 'job', 'data-level': health.level, 'aria-labelledby': `job-${job.id}` },
    h('div', { class: 'job-head' },
      h('h3', { id: `job-${job.id}` }, job.label),
      tag(health.level, health.label),
      health.text ? h('p', { class: 'job-why' }, health.text) : null),
    h('div', { class: 'cell' },
      h('p', { class: 'cell-label' }, 'Last good backup'),
      h('p', { class: 'cell-value' }, okIso ? fmt.time(okIso) : 'None yet'),
      meter(fresh.ratio, health.level === 'bad' ? 'bad' : fresh.ratio > 0.8 ? 'warn' : 'ok',
        fresh.ageHours === null ? 'No good backup yet' : `${Math.round(fresh.ageHours)} of ${fresh.limitHours} hours allowed`),
      h('p', { class: 'cell-sub' }, okIso ? [agoEl(okIso, now), ` · limit ${fresh.limitHours} h`] : `Limit ${fresh.limitHours} h`),
      size ? h('p', { class: 'cell-sub' }, `Size ${size}`) : null),
    h('div', { class: 'cell' },
      h('p', { class: 'cell-label' }, 'Last run'),
      h('p', { class: 'cell-value' }, bt.found ? fmt.time(bt.lastRunAt) : '—'),
      h('p', { class: 'cell-sub' }, bt.found ? resultText(bt.lastResult) : 'Task not found'),
      bt.nextRunAt ? h('p', { class: 'cell-sub' }, `Next ${fmt.time(bt.nextRunAt)}`) : null),
    h('div', { class: 'cell' },
      h('p', { class: 'cell-label' }, 'Morning check'),
      h('p', { class: 'cell-value' }, ct.found ? fmt.time(ct.lastRunAt) : '—'),
      h('p', { class: 'cell-sub' }, ct.found ? resultText(ct.lastResult) : 'Task not found')),
    mode.on ? jobActions(job, ctx) : null);

  if (problems.length || (sf && sf.name)) {
    const label = problems.length ? `${plural(problems.length, 'warning line')} in ${job.logFile}` : 'Details';
    row.append(details(ctx, `job:${job.id}`, label,
      h('div', { class: 'fold-body' },
        h('dl', { class: 'pairs' },
          h('dt', null, 'Status files'), h('dd', null, (job.statusFiles || []).join(', ') || '—'),
          h('dt', null, 'Log'), h('dd', null, log && log.found ? [job.logFile, ', changed ', agoEl(log.modifiedAt, now)] : `${job.logFile} not found`)),
        problems.length ? h('ul', { class: 'lines' }, problems.slice().reverse().map((p) => h('li', null, p))) : null)));
  }
  return row;
}

function jobActions(job, ctx) {
  const actions = ['backup', 'check'].map((kind) => ctx.state.actions.find((a) => a.job === job.id && a.kind === kind));
  const reasons = [];
  const stale = isStale(ctx.state, ctx.now);
  const buttons = actions.map((action) => {
    const st = actionState(ctx.state, action, ctx.now);
    // A silent agent is explained once above the list, not on every row.
    if (st.reason && !stale && !reasons.includes(st.reason)) reasons.push(st.reason);
    const busy = ctx.busy === action.id;
    const text = busy ? 'Queuing…' : st.waiting ? 'Queued' : action.kind === 'backup' ? 'Run backup' : 'Run check';
    return h('button', {
      type: 'button',
      class: action.kind === 'backup' ? 'btn' : 'btn btn-quiet',
      disabled: !st.enabled || !!ctx.busy,
      'aria-describedby': st.reason ? `why-${job.id}` : null,
      'data-focus': `run:${action.id}`,
      onclick: () => ctx.onRun(action),
    }, text);
  });
  return h('div', { class: 'job-actions' },
    h('div', { class: 'job-buttons' }, buttons),
    reasons.length ? h('p', { class: 'reason', id: `why-${job.id}` }, reasons.join(' ')) : null);
}

export function backups(ctx) {
  const jobs = ctx.state.report.data.jobs || [];
  const paused = commandsMode(ctx.state).on && isStale(ctx.state, ctx.now);
  return h('section', { class: 'section', 'aria-labelledby': 'h-backups' },
    sectionHead('Backups', `Times in ${ctx.state.timeZone.replace('_', ' ')}`, 'h-backups'),
    paused ? h('p', { class: 'note note-warn ledger-note' }, 'Run-now is paused until the agent reports again.') : null,
    h('div', { class: 'ledger', 'data-actions': String(commandsMode(ctx.state).on) }, jobs.map((j) => jobRow(j, ctx))));
}

// ---------------------------------------------------------------- storage

function diskBlock(d, ctx, data) {
  const warnGB = Number(data.diskWarnFreeGB) || 60;
  const warnBytes = warnGB * 1024 ** 3;
  const used = d.sizeBytes > 0 ? 1 - d.freeBytes / d.sizeBytes : 0;
  const low = d.freeBytes < warnBytes;
  const f = diskForecast(d, ctx.state.metrics, warnBytes);

  const usage = h('div', { class: `usage${low ? ' usage-low' : ''}`, role: 'img', 'aria-label': `${d.name} ${Math.round(used * 100)}% used, ${binBytes(d.freeBytes)} free` }, h('i'));
  usage.firstChild.style.width = `${(Math.min(1, Math.max(0, used)) * 100).toFixed(1)}%`;
  if (d.sizeBytes > warnBytes) {
    const mark = h('b', { title: `${warnGB} GB free` });
    mark.style.left = `${((1 - warnBytes / d.sizeBytes) * 100).toFixed(1)}%`;
    usage.append(mark);
  }

  const forecast = [f.text];
  if (f.daysToWarn > 0) forecast.push(`Below ${warnGB} GB in about ${Math.round(f.daysToWarn)} days (${ctx.fmt.date(ctx.now + f.daysToWarn * 86400000)}).`);
  if (f.daysToFull) forecast.push(`Full in about ${Math.round(f.daysToFull)} days.`);

  return h('div', { class: 'disk' },
    h('div', { class: 'disk-head' },
      h('span', { class: 'disk-name' }, d.name, d.label ? h('span', { class: 'quiet' }, ` ${d.label}`) : null),
      h('span', { class: 'disk-free' }, h('strong', null, binBytes(d.freeBytes)), ` free of ${binBytes(d.sizeBytes)}`)),
    usage,
    h('div', { class: 'disk-trend' },
      f.series.length >= 2 ? sparkline(f.series.map((p) => p.free), `${d.name} free space, last ${f.series.length} days`, d.sizeBytes) : null,
      h('p', null, forecast.join(' '))),
    low ? h('p', { class: 'note note-warn' }, `Below the ${warnGB} GB warning level.`) : null);
}

function disksPanel(ctx) {
  const data = ctx.state.report.data;
  const disks = data.disks || [];
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Disks'), h('p', { class: 'quiet' }, `Warning below ${data.diskWarnFreeGB || 60} GB free`)),
    disks.length ? disks.map((d) => diskBlock(d, ctx, data)) : h('p', { class: 'empty' }, 'The server reported no disks.'));
}

function backblazePanel(ctx) {
  const b = ctx.state.report.data.backblaze;
  const head = h('div', { class: 'panel-head' }, h('h3', null, 'Backblaze B2'));
  if (!b || !b.enabled) {
    head.append(tag('idle', 'Not set up'));
    return h('div', { class: 'panel' }, head,
      h('p', { class: 'empty' }, 'Bucket size and monthly cost appear here once a read-only Backblaze key is added for the agent (setup guide, part 7).'));
  }
  const est = b2Estimate(b);
  head.append(b.lastError ? tag('warn', 'Last check failed') : est ? tag('ok', 'Up to date') : tag('idle', 'Waiting'));
  const series = (ctx.state.metrics || []).filter((m) => m.b2 && typeof m.b2.totalBytes === 'number').map((m) => m.b2.totalBytes);
  return h('div', { class: 'panel' }, head,
    h('p', { class: 'figure' }, est ? decBytes(b.totalBytes) : '—'),
    h('p', { class: 'quiet' }, est
      ? `About $${est.perMonth.toFixed(2)} a month at $${est.price}/TB, first ${est.freeGB} GB free. An estimate, not the bill.`
      : 'Waiting for the first size check.'),
    h('dl', { class: 'pairs' },
      (b.prefixes || []).map((p) => [h('dt', null, String(p.prefix || '').replace(/\/$/, '')),
        h('dd', null, `${decBytes(p.bytes)} in ${plural(p.files, 'file')}${p.complete === false ? ' (listing cut short)' : ''}`)]),
      h('dt', null, 'Checked'), h('dd', null, stamp(b.checkedAt, ctx))),
    series.length >= 2 ? h('div', { class: 'disk-trend' }, sparkline(series, `Bucket size, last ${series.length} days`), h('p', null, `Bucket size over ${series.length} days.`)) : null,
    b.lastError ? h('p', { class: 'note note-warn' }, `Last check failed: ${b.lastError}`) : null);
}

export function storage(ctx) {
  return h('section', { class: 'section', 'aria-labelledby': 'h-storage' },
    sectionHead('Storage', null, 'h-storage'),
    h('div', { class: 'split' }, disksPanel(ctx), backblazePanel(ctx)));
}

// ---------------------------------------------------------------- agent

export function agent(ctx) {
  const { state, now } = ctx;
  const data = state.report.data;
  const a = data.agent || {};
  const stale = isStale(state, now);
  const mode = commandsMode(state);
  const issues = a.collectErrors || [];
  const events = state.events || [];
  return h('section', { class: 'section', 'aria-labelledby': 'h-agent' },
    sectionHead('Server agent', null, 'h-agent'),
    h('div', { class: 'panel panel-row' },
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'Server'), h('dd', null, data.host || '—')),
        h('div', null, h('dt', null, 'Last report'), h('dd', null, stamp(state.report.receivedAt, ctx))),
        h('div', null, h('dt', null, 'Agent'), h('dd', null, `${data.agentVersion || '?'}, PowerShell ${a.psVersion || '?'}`)),
        h('div', null, h('dt', null, 'Run-now'), h('dd', null, mode.on ? `On, ${(a.enabledActions || []).length} of 6 actions` : 'Off'))),
      stale ? tag('bad', 'Not reporting') : issues.length ? tag('warn', 'Partial report') : tag('ok', 'Reporting')),
    issues.length ? h('div', { class: 'panel panel-note' }, h('p', null, 'The agent could not read everything:'), h('ul', { class: 'lines' }, issues.map((e) => h('li', null, e)))) : null,
    events.length ? details(ctx, 'events', `${plural(events.length, 'earlier agent error')} while the panel was unreachable`,
      h('ul', { class: 'lines fold-body' }, events.map((e) => h('li', null, `${ctx.fmt.time(e.at)}  ${e.message}`)))) : null);
}

// ---------------------------------------------------------------- history

const COMMAND_LEVEL = { pending: 'idle', sent: 'run', started: 'ok', rejected: 'warn', failed: 'bad', expired: 'warn', 'no-reply': 'warn', cancelled: 'idle' };
const COMMAND_WORD = { pending: 'Queued', sent: 'With agent', started: 'Started', rejected: 'Refused', failed: 'Failed', expired: 'Expired', 'no-reply': 'No answer', cancelled: 'Cancelled' };

export function history(ctx) {
  const { state } = ctx;
  const rows = state.commands || [];
  const mode = commandsMode(state);
  const tasks = Object.fromEntries(state.actions.map((a) => [a.id, a.task]));
  let body;
  if (!rows.length) {
    body = h('p', { class: 'empty panel' }, mode.on
      ? 'No Run-now requests yet. Requests and what the agent did with them are listed here.'
      : `${mode.reason} When both switches are on (setup guide, part 8), requests and their results are listed here.`);
  } else {
    body = h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Requested', 'Task', 'Status', 'Result', h('span', { class: 'visually-hidden' }, 'Actions')].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map((c) => h('tr', null,
        h('td', { class: 'nowrap', 'data-label': 'Requested' }, ctx.fmt.time(c.requested_at), h('span', { class: 'cell-sub' }, c.requested_by)),
        h('td', { 'data-label': 'Task' }, tasks[c.action] || c.action),
        h('td', { 'data-label': 'Status' }, tag(COMMAND_LEVEL[c.status] || 'idle', COMMAND_WORD[c.status] || c.status)),
        h('td', { 'data-label': 'Result' }, c.message || (c.status === 'pending' ? 'Waiting for the agent to collect it.' : c.status === 'sent' ? 'The agent has it.' : '')),
        h('td', { class: 'nowrap' }, c.status === 'pending'
          ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm', 'data-focus': `cancel:${c.id}`, onclick: () => ctx.onCancel(c) }, 'Cancel')
          : null))))));
  }
  return h('section', { class: 'section', 'aria-labelledby': 'h-history' },
    sectionHead('Run-now history', rows.length ? `Last ${rows.length}` : null, 'h-history'), body);
}

// ---------------------------------------------------------------- raw data

function logList(ctx) {
  const logs = ctx.state.report.data.logs || [];
  return logs.map((l) => {
    const pre = h('pre', { class: 'raw' });
    const problems = new Set(l.problems || []);
    if (!l.found) pre.textContent = 'This log file was not found on the server.';
    else if (!(l.tail || []).length) pre.textContent = l.error || 'The log is empty.';
    else for (const line of l.tail) pre.append(problems.has(line) ? h('mark', null, line) : line, '\n');
    return details(ctx, `log:${l.name}`,
      [h('span', { class: 'fold-name' }, l.name), h('span', { class: 'quiet' }, l.found ? [binBytes(l.sizeBytes), ', changed ', agoEl(l.modifiedAt, ctx.now)] : 'not found')],
      pre);
  });
}

function statusList(ctx) {
  const data = ctx.state.report.data;
  const files = data.statusFiles || [];
  if (!files.length) return [h('p', { class: 'empty' }, 'No status files in the status folder.')];
  const labels = Object.fromEntries((data.jobs || []).map((j) => [j.id, j.label]));
  return files.map((f) => details(ctx, `status:${f.name}`,
    [h('span', { class: 'fold-name' }, f.name), h('span', { class: 'quiet' }, [f.job ? labels[f.job] : 'not matched to a backup', ', changed ', agoEl(f.modifiedAt, ctx.now)])],
    h('pre', { class: 'raw' }, f.error ? f.error : JSON.stringify(f.content, null, 2))));
}

export function raw(ctx) {
  const tabs = [['logs', 'Log tails'], ['status', 'Status files']];
  const list = h('div', { role: 'tablist', 'aria-label': 'Data from the server', class: 'tabs' },
    tabs.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': 'raw-panel', 'aria-selected': String(ctx.tab === id),
      tabindex: ctx.tab === id ? '0' : '-1', 'data-focus': `tab:${id}`, onclick: () => ctx.onTab(id),
    }, label)));
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(([id]) => id === ctx.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    ctx.onTab(next, true);
  });
  return h('section', { class: 'section', 'aria-labelledby': 'h-raw' },
    sectionHead('From the server', 'Secrets are blanked by the agent before sending', 'h-raw'),
    list,
    h('div', { role: 'tabpanel', id: 'raw-panel', 'aria-labelledby': `tab-${ctx.tab}`, class: 'tabpanel' },
      ctx.tab === 'logs' ? logList(ctx) : statusList(ctx)));
}

// ---------------------------------------------------------------- whole-page states

export function loading() {
  const bar = (cls) => h('div', { class: `skeleton ${cls}` });
  return h('div', { class: 'loading', 'aria-hidden': 'true' },
    h('div', { class: 'summary' }, bar('sk-mark'), h('div', null, bar('sk-line sk-wide'), bar('sk-line'))),
    h('div', { class: 'section' }, bar('sk-line sk-head'), h('div', { class: 'ledger' }, [1, 2, 3].map(() => h('div', { class: 'job' }, bar('sk-line'), bar('sk-line'), bar('sk-line'))))));
}

export function signedOut() {
  return h('section', { class: 'standalone', 'aria-labelledby': 'signed-out' },
    h('h2', { id: 'signed-out' }, 'Your session has ended'),
    h('p', null, 'Sessions last 12 hours, and end when you sign out or the panel restarts.'),
    h('a', { class: 'btn', href: '/login' }, 'Sign in again'));
}

export function signIns(ctx) {
  const list = ctx.state.signIns || [];
  const failed = ctx.state.failedSignIns24h || 0;
  return h('section', { class: 'section', 'aria-labelledby': 'h-signins' },
    sectionHead('Sign-ins', failed ? `${plural(failed, 'failed attempt')} in the last 24 h` : 'No failed attempts in the last 24 h', 'h-signins'),
    list.length
      ? h('div', { class: 'panel' }, h('dl', { class: 'pairs' }, list.map((e) => [h('dt', null, stamp(e.at, ctx)), h('dd', null, `from ${e.message}`)])))
      : h('p', { class: 'empty panel' }, 'No sign-ins recorded yet.'));
}

export function refreshError(error, lastIso, retrySeconds, onRetry, ctx) {
  return h('div', { class: 'alert', role: 'alert' },
    h('p', null, h('strong', null, 'Could not refresh. '), error,
      lastIso ? [' Showing the report from ', ctx.fmt.time(lastIso), '.'] : null,
      ` Trying again in ${retrySeconds} s.`),
    h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: onRetry }, 'Try now'));
}

export function nextRunLine(action, ctx) {
  const job = (ctx.state.report.data.jobs || []).find((j) => j.id === action.job);
  const t = (job && job[action.kind] && job[action.kind].task) || {};
  return {
    next: t.nextRunAt ? `${ctx.fmt.time(t.nextRunAt)} (${until(t.nextRunAt, ctx.now)})` : '—',
    last: t.lastRunAt ? `${ctx.fmt.time(t.lastRunAt)} · ${resultText(t.lastResult)}` : '—',
  };
}
