// Page sections. Each function takes the render context and returns DOM.
// ctx: { state, now, fmt, open, busy, tab, onRun, onCancel, onTab }

import { h, s, glyph, tag } from './dom.js';
import { ago, binBytes, dayLabel, decBytes, plural, until } from './format.js';
import {
  actionState, b2Estimate, commandsMode, diskForecast, findSize, freshness, isStale,
  jobHealth, lastGoodAt, resultText, successFile, verdict,
} from './health.js';
import {
  coverageOf, driveTotals, filterPoints, historyGoal, restoreSets, SUMMARY_STALE_HOURS, summaryAgeHours,
} from './points.js';
import { dayCounts, errorKind, lastDays, logEvents, runGrid } from './history.js';
import { capsInfo, daysBetween, KEY_MONTHS, keyRows, practiceRows } from './reminders.js';

const KIND_LEVEL = { auth: 'bad', unreachable: 'warn', server: 'warn', backup: 'bad', other: 'warn' };

// An error message with a tag saying what kind of problem it is.
function problemLine(text) {
  const k = errorKind(text);
  return h('li', { class: 'problem' }, tag(KIND_LEVEL[k.kind], k.label), h('span', null, text));
}

const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s` : '—');

// Daily values from the metrics rows, oldest first.
function metricSeries(ctx, pick) {
  return (ctx.state.metrics || []).map(pick).filter((v) => typeof v === 'number');
}

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

function countsLine(ctx) {
  if (!ctx.state.report || !ctx.state.report.data) return null;
  const c = dayCounts(ctx.state, ctx.now);
  const item = (n, text, level) => h('li', { 'data-level': level }, h('strong', null, String(n)), ` ${text}`);
  return h('ul', { class: 'counts', 'aria-label': 'Tasks in the last 24 hours' },
    item(c.tasks, 'tasks watched', 'idle'),
    item(c.running, 'running now', c.running ? 'run' : 'idle'),
    item(c.ok, 'finished OK in 24 h', c.ok ? 'ok' : 'idle'),
    item(c.failed, 'failed in 24 h', c.failed ? 'bad' : 'idle'));
}

export function summary(ctx) {
  const v = verdict(ctx.state, ctx.now, ctx.fmt);
  return h('section', { class: `summary summary-${v.level}`, 'aria-label': 'Summary' },
    h('div', { class: 'summary-mark' }, glyph(v.level)),
    h('div', null,
      h('p', { class: 'headline' }, v.headline),
      v.detail.length > 1
        ? h('ul', { class: 'summary-list' }, v.detail.map((d) => h('li', null, d)))
        : v.detail.map((d) => h('p', { class: 'summary-detail' }, d)),
      countsLine(ctx)));
}

// ---------------------------------------------------------------- run history

const RUN_WORD = { ok: 'OK', bad: 'Failed', none: 'No run', later: 'Not run yet today', unknown: 'Before the panel recorded' };

export function runHistory(ctx) {
  const today = ctx.fmt.day(new Date(ctx.now).toISOString());
  const days = lastDays(today, 30);
  const since = ctx.state.historySince ? ctx.fmt.day(ctx.state.historySince) : today;
  const rows = runGrid(ctx.state.runs || [], days, ctx.fmt.day, since);
  const dayName = (d) => ctx.fmt.date(Date.parse(`${d}T12:00:00Z`));
  const grid = h('div', { class: 'runs' },
    rows.map((r) => {
      const label = `${r.label}: ${r.counts.ok} OK, ${r.counts.bad} failed, ${r.counts.none} days without a run`;
      return h('div', { class: 'runs-row' },
        h('span', { class: 'runs-label' }, r.label),
        h('span', { class: 'runs-cells', role: 'img', 'aria-label': label },
          r.cells.map((c) => {
            const detail = c.runs.map((x) => `${ctx.fmt.clock(x.runAt)} ${resultText(x.result)}`).join(', ');
            return h('i', { 'data-level': c.level, title: `${dayName(c.day)}: ${detail || RUN_WORD[c.level]}` });
          })));
    }));
  const legend = h('ul', { class: 'runs-legend', 'aria-hidden': 'true' },
    ['ok', 'bad', 'none', 'unknown'].map((l) => h('li', null, h('i', { 'data-level': l }), RUN_WORD[l])));
  return h('section', { class: 'section', 'aria-labelledby': 'h-runs' },
    sectionHead('Last 30 days', ctx.state.historySince ? `Recorded since ${ctx.fmt.date(Date.parse(ctx.state.historySince))} · point at a square for details` : 'Fills in as the tasks run', 'h-runs'),
    h('div', { class: 'panel' }, grid,
      h('div', { class: 'runs-foot' }, h('span', { class: 'quiet' }, dayName(days[0])), legend, h('span', { class: 'quiet' }, 'Today'))));
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

// "Times in server time (Kolkata, UTC+05:30) · Show my time" when the viewer is elsewhere.
function zoneMeta(ctx) {
  const z = ctx.zone;
  if (!z || !z.differs) return `Times in ${z ? z.serverLabel : ctx.state.timeZone}`;
  return [
    z.mine ? `Times in your time (${z.viewerLabel})` : `Times in server time (${z.serverLabel})`,
    ' · ',
    h('button', { type: 'button', class: 'link-btn', 'data-focus': 'zone', onclick: z.onToggle },
      z.mine ? 'Show server time' : `Show my time (${z.viewerLabel})`),
  ];
}

export function backups(ctx) {
  const jobs = ctx.state.report.data.jobs || [];
  const paused = commandsMode(ctx.state).on && isStale(ctx.state, ctx.now);
  return h('section', { class: 'section', 'aria-labelledby': 'h-backups' },
    sectionHead('Backups', zoneMeta(ctx), 'h-backups'),
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
  const listTimes = metricSeries(ctx, (m) => m.b2 && m.b2.listMs);
  return h('div', { class: 'panel' }, head,
    h('p', { class: 'figure' }, est ? decBytes(b.totalBytes) : '—'),
    h('p', { class: 'quiet' }, est
      ? `About $${est.perMonth.toFixed(2)} a month at $${est.price}/TB, first ${est.freeGB} GB free. An estimate, not the bill.`
      : 'Waiting for the first size check.'),
    h('dl', { class: 'pairs' },
      (b.prefixes || []).map((p) => [h('dt', null, String(p.prefix || '').replace(/\/$/, '')),
        h('dd', null, `${decBytes(p.bytes)} in ${plural(p.files, 'file')}${p.complete === false ? ' (listing cut short)' : ''}`)]),
      h('dt', null, 'Checked'), h('dd', null, stamp(b.checkedAt, ctx)),
      typeof b.listMs === 'number' ? [h('dt', null, 'Listing took'), h('dd', null, seconds(b.listMs))] : null),
    series.length >= 2 ? h('div', { class: 'disk-trend' }, sparkline(series, `Bucket size, last ${series.length} days`), h('p', null, `Bucket size over ${series.length} days.`)) : null,
    listTimes.length >= 2 ? h('div', { class: 'disk-trend' }, sparkline(listTimes, `Listing time, last ${listTimes.length} days`), h('p', null, `Listing time over ${listTimes.length} days.`)) : null,
    b.lastError ? h('ul', { class: 'lines problems' }, problemLine(`Last check failed: ${b.lastError}`)) : null,
    capsBlock(ctx, est));
}

// Backblaze caps (set on the Backblaze website), kept here as a note next to the estimate.
function capsBlock(ctx, est) {
  const c = capsInfo(ctx.state.notes, est ? est.perMonth : null);
  const money = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : 'not noted');
  const summaryText = c.storage === null && c.download === null
    ? 'Caps set at Backblaze: not noted yet'
    : `Caps set at Backblaze: storage ${money(c.storage)} a day, download ${money(c.download)} a day`;
  const input = (id, label, value) => h('label', { class: 'field' }, h('span', null, label),
    h('input', { type: 'number', min: '0', max: '1000', step: '0.01', inputmode: 'decimal', id, value: typeof value === 'number' ? String(value) : '' }));
  const form = h('form', { class: 'filters', novalidate: true },
    input('cap-storage', 'Storage, $ a day', c.storage),
    input('cap-download', 'Download, $ a day', c.download),
    h('button', { type: 'submit', class: 'btn btn-sm', 'data-focus': 'caps:save' }, 'Save'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const read = (id) => {
      const v = form.querySelector(`#${id}`).value.trim();
      return v === '' ? null : Number(v);
    };
    ctx.onNote({ section: 'caps', storagePerDay: read('cap-storage'), downloadPerDay: read('cap-download') }, 'caps:save');
  });
  return details(ctx, 'caps', summaryText,
    h('div', { class: 'fold-body' },
      c.ratio !== null ? h('p', { class: c.level === 'warn' ? 'note note-warn' : 'note quiet' },
        `Storage now costs about $${c.perDay.toFixed(2)} a day: ${Math.round(c.ratio * 100)}% of the cap.${c.level === 'warn' ? ' Raise the cap at Backblaze before uploads stop.' : ''}`) : null,
      h('p', { class: 'quiet note' }, 'Copy the numbers from Backblaze, Caps & Alerts. A restore downloads data and counts against the download cap.'),
      form));
}

function drivePanel(ctx) {
  const d = driveTotals(ctx.state.report.data);
  const head = h('div', { class: 'panel-head' }, h('h3', null, 'Google Drive'));
  if (!d) {
    head.append(tag('idle', 'Waiting'));
    return h('div', { class: 'panel' }, head,
      h('p', { class: 'empty' }, 'The size of the database backups appears here after the 08:00 Postgres check has run with panel-status.ps1 (setup guide, part 11).'));
  }
  head.append(tag('ok', 'Included in your plan'));
  const { space } = d;
  const usage = space ? h('div', { class: 'usage', role: 'img', 'aria-label': `Google account ${Math.round((d.accountUsed / space.totalBytes) * 100)}% used` }, h('i')) : null;
  if (usage) usage.firstChild.style.width = `${(Math.min(1, d.accountUsed / space.totalBytes) * 100).toFixed(1)}%`;
  return h('div', { class: 'panel' }, head,
    h('p', { class: 'figure' }, binBytes(d.backupBytes)),
    h('p', { class: 'quiet' }, 'Database backups in Drive, before encryption. No extra cost: the space comes with your Google plan.'),
    h('dl', { class: 'pairs' },
      d.backups.map((b) => [h('dt', null, b.label), h('dd', null, `${binBytes(b.bytes)} in ${plural(b.count, 'night')}`)]),
      space ? [h('dt', null, 'Google account'), h('dd', null, `${binBytes(d.accountUsed)} used of ${binBytes(space.totalBytes)}, ${binBytes(space.freeBytes)} free`)] : null),
    usage,
    space ? h('p', { class: 'quiet note' }, 'The account figure includes Gmail and Google Photos.') : null,
    (() => {
      const series = metricSeries(ctx, (m) => m.drive && m.drive.backupBytes);
      return series.length >= 2 ? h('div', { class: 'disk-trend' }, sparkline(series, `Backups in Drive, last ${series.length} days`), h('p', null, `Backups in Drive over ${series.length} days.`)) : null;
    })());
}

export function storage(ctx) {
  return h('section', { class: 'section', 'aria-labelledby': 'h-storage' },
    sectionHead('Storage', null, 'h-storage'),
    h('div', { class: 'split' }, disksPanel(ctx), backblazePanel(ctx), drivePanel(ctx)));
}

// ---------------------------------------------------------------- restore points

const PAGE_POINTS = 30;

function pointWhen(p, def, ctx) {
  return def.kind === 'drive' ? dayLabel(p.date || p.id) : ctx.fmt.time(p.time);
}

function setWhen(value, def, ctx) {
  if (!value) return '—';
  return def.kind === 'drive' ? dayLabel(value) : ctx.fmt.time(value);
}

function goalLine(row, ctx) {
  const g = historyGoal(row.set, row.def.goalYears, ctx.now);
  if (!g) return null;
  const pct = Math.round(g.ratio * 100);
  const text = g.met
    ? `The history reaches back ${Math.round(g.ageDays)} days: the ${row.def.goalYears}-year goal is met.`
    : `The history reaches back ${Math.round(g.ageDays)} of ${Math.round(g.goalDays)} days (${pct}%) of the ${row.def.goalYears}-year goal. It is met on ${ctx.fmt.date(g.metAt)} if every monthly snapshot is kept.`;
  return h('div', { class: 'goal' },
    h('p', { class: 'cell-label' }, `${row.def.goalYears}-year log history`),
    meter(g.ratio, g.met ? 'ok' : 'warn', `${pct}% of the ${row.def.goalYears}-year goal`),
    h('p', { class: 'cell-sub' }, text));
}

function pointsTable(row, ctx) {
  const { def, set } = row;
  const all = (set && Array.isArray(set.points)) ? set.points : [];
  const shown = filterPoints(all, ctx.points, ctx.fmt.day);
  const page = ctx.points.all ? shown : shown.slice(0, PAGE_POINTS);
  const filtered = !!(ctx.points.from || ctx.points.to);
  const dateInput = (key, label, value) => h('label', { class: 'field' }, h('span', null, label),
    h('input', { type: 'date', value: value || '', 'data-focus': `points:${key}`, onchange: (e) => ctx.onPoints({ [key]: e.target.value }, `points:${key}`) }));

  const filters = h('div', { class: 'filters' },
    dateInput('from', 'From', ctx.points.from),
    dateInput('to', 'To', ctx.points.to),
    filtered ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm', 'data-focus': 'points:clear', onclick: () => ctx.onPoints({ from: '', to: '' }, 'points:from') }, 'Clear') : null,
    h('p', { class: 'quiet', 'aria-live': 'polite' }, filtered ? `${plural(shown.length, 'restore point')} of ${all.length} in this range` : `${plural(all.length, 'restore point')} listed${set && set.count > all.length ? ` (newest ${all.length} of ${set.count})` : ''}`));

  if (!all.length) return [filters, h('p', { class: 'empty' }, 'No restore points in this set yet.')];
  if (!shown.length) return [filters, h('p', { class: 'empty' }, 'No restore points in this date range.')];
  const last = def.kind === 'restic' ? 'Uploaded' : 'Files';
  // restic: the snapshot ID restore-files.ps1 -Snapshot takes. Drive: the folder the restore scripts read.
  const idHead = def.kind === 'restic' ? 'Snapshot ID' : 'Folder';
  const idOf = (p) => (def.kind === 'restic' ? p.id : `${set.location}/${p.date || p.id}`);
  const table = h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['When', idHead, 'Size', last].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, page.map((p) => h('tr', null,
      h('td', { class: 'nowrap', 'data-label': 'When' }, pointWhen(p, def, ctx)),
      h('td', { class: 'mono', 'data-label': idHead }, idOf(p) || '—'),
      h('td', { class: 'nowrap', 'data-label': 'Size' }, typeof p.bytes === 'number' ? binBytes(p.bytes) : '—'),
      h('td', { class: 'nowrap', 'data-label': last }, def.kind === 'restic'
        ? (typeof p.added === 'number' ? binBytes(p.added) : '—')
        : (typeof p.files === 'number' ? String(p.files) : '—')))))));
  const more = shown.length > page.length
    ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm more', 'data-focus': 'points:all', onclick: () => ctx.onPoints({ all: true }, 'points:all') }, `Show all ${shown.length}`)
    : null;
  return [filters, table, more];
}

function pointsPanel(row, ctx) {
  const { def, summary, set } = row;
  if (!summary) {
    return h('div', { class: 'panel' }, h('p', { class: 'empty' },
      `Nothing from the ${def.checkAt} ${def.label === 'Server logs' || def.label === 'Files' ? 'file' : def.label} check yet. The list appears after that check has run with panel-status.ps1 (setup guide, part 11).`));
  }
  const check = summary.check || {};
  const age = summaryAgeHours(summary, ctx.now);
  const notes = [];
  if (age !== null && age > SUMMARY_STALE_HOURS) notes.push(h('p', { class: 'note note-warn' }, `This list was last updated ${ago(summary.checkedAt, ctx.now)}; this morning's check did not refresh it.`));
  if (set && set.fromEarlierCheck) notes.push(h('p', { class: 'note note-warn' }, 'The last check could not read this set, so the list is from an earlier check.'));
  if (!set) notes.push(h('p', { class: 'note note-warn' }, 'The last check could not list this set.'));
  if (check.ok === false && Array.isArray(check.problems) && check.problems.length) {
    notes.push(h('div', { class: 'panel-note' }, h('p', { class: 'note note-warn' }, 'The morning check found problems:'),
      h('ul', { class: 'lines problems' }, check.problems.map((p) => problemLine(p)))));
  }
  if (Array.isArray(summary.notes) && summary.notes.length) {
    notes.push(h('div', { class: 'panel-note' }, h('p', { class: 'note note-warn' }, 'Could not list everything this time:'),
      h('ul', { class: 'lines problems' }, summary.notes.map((p) => problemLine(String(p))))));
  }
  if (set && set.retries > 0) {
    notes.push(h('p', { class: 'note note-warn' }, `Backblaze was slow this morning: restic had to retry ${plural(set.retries, 'time')}.`));
  }
  return h('div', { class: 'panel' },
    h('dl', { class: 'facts' },
      h('div', null, h('dt', null, 'Stored in'), h('dd', null, set ? `${set.provider} · ${set.location}` : '—')),
      h('div', null, h('dt', null, 'Encryption'), h('dd', null, def.encryption)),
      h('div', null, h('dt', null, 'Kept'), h('dd', null, def.kept)),
      h('div', null, h('dt', null, 'Restore points'), h('dd', null, set ? String(set.count) : '—')),
      h('div', null, h('dt', null, 'Oldest'), h('dd', null, set ? setWhen(set.oldest, def, ctx) : '—')),
      h('div', null, h('dt', null, 'Newest'), h('dd', null, set ? setWhen(set.newest, def, ctx) : '—')),
      h('div', null, h('dt', null, def.kind === 'restic' ? 'In Backblaze' : 'Total size'), h('dd', null, set && typeof set.storedBytes === 'number' ? binBytes(set.storedBytes) : '—')),
      h('div', null, h('dt', null, 'Morning check'), h('dd', null, check.ok === false ? 'Found problems' : 'OK', h('span', { class: 'quiet' }, ' · ', agoEl(summary.checkedAt, ctx.now)))),
      h('div', null, h('dt', null, 'Listing took'), h('dd', null, set ? seconds(set.listMs) : '—'))),
    def.goalYears && set ? goalLine(row, ctx) : null,
    set ? trendsLine(row, ctx) : null,
    notes,
    pointsTable(row, ctx));
}

// Per night: uploaded (restic) or dump size (Drive), and how long the listing took.
function trendsLine(row, ctx) {
  const { def, set } = row;
  const pts = (Array.isArray(set.points) ? set.points : []).slice(0, 30).reverse();
  const values = pts.map((p) => (def.kind === 'restic' ? p.added : p.bytes)).filter((v) => typeof v === 'number');
  const times = metricSeries(ctx, (m) => m.reads && m.reads[def.id] && m.reads[def.id].ms);
  const parts = [];
  if (values.length >= 2) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const what = def.kind === 'restic' ? 'Uploaded' : 'Dump size';
    parts.push(h('div', { class: 'disk-trend' }, sparkline(values, `${what} per night, last ${values.length}`),
      h('p', null, `${what} per night: last ${binBytes(values[values.length - 1])}, average ${binBytes(avg)} over ${values.length} nights.`)));
  }
  if (times.length >= 2) {
    parts.push(h('div', { class: 'disk-trend' }, sparkline(times, `Listing time, last ${times.length} days`),
      h('p', null, `Listing time over ${times.length} days (longer means Backblaze or Drive was slow).`)));
  }
  return parts.length ? h('div', { class: 'trends' }, parts) : null;
}

function coveragePanel(rows, ctx) {
  const blocks = rows.filter((r) => r.summary).map((r) => {
    const c = coverageOf(r);
    const list = c.items.map(String);
    const head = h('p', { class: 'cell-label' }, `${r.def.label}: ${plural(list.length, c.what === 'databases' ? 'database' : 'folder')}`);
    const top = list.slice(0, 8);
    const rest = list.slice(8);
    return h('div', { class: 'cover' }, head,
      list.length ? h('ul', { class: 'lines' }, top.map((x) => h('li', null, x))) : h('p', { class: 'empty' }, '—'),
      rest.length ? details(ctx, `cover:${r.def.id}`, `${rest.length} more`, h('ul', { class: 'lines fold-body' }, rest.map((x) => h('li', null, x)))) : null,
      c.missing.length ? h('p', { class: 'note note-warn' }, `No dump in the newest backup: ${c.missing.join(', ')}`) : null);
  });
  if (!blocks.length) return null;
  return h('div', { class: 'panel panel-cover' },
    h('div', { class: 'panel-head' }, h('h3', null, 'What is backed up'), h('p', { class: 'quiet' }, 'From the newest restore point of each set. Anything not listed is not backed up.')),
    h('div', { class: 'cover-grid' }, blocks));
}

export function restorePoints(ctx) {
  const rows = restoreSets(ctx.state.report.data);
  const any = rows.some((r) => r.summary);
  const headEl = sectionHead('Restore points', any ? 'Listed by the morning checks · read-only; restores are done on the server' : null, 'h-points');
  if (!any) {
    return h('section', { class: 'section', 'aria-labelledby': 'h-points' }, headEl,
      h('p', { class: 'empty panel' }, 'The list of backups you can restore from appears here after the morning checks have run with panel-status.ps1 (setup guide, part 11).'));
  }
  const sel = rows.find((r) => r.def.id === ctx.points.set) || rows[0];
  const ids = rows.map((r) => r.def.id);
  const list = h('div', { role: 'tablist', 'aria-label': 'Backup sets', class: 'tabs' },
    rows.map((r) => h('button', {
      type: 'button', role: 'tab', id: `ptab-${r.def.id}`, 'aria-controls': 'points-panel', 'aria-selected': String(r === sel),
      tabindex: r === sel ? '0' : '-1', 'data-focus': `ptab:${r.def.id}`, onclick: () => ctx.onPoints({ set: r.def.id }),
    }, r.def.label, r.set ? h('span', { class: 'tab-count' }, String(r.set.count)) : null)));
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = ids.indexOf(sel.def.id);
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    ctx.onPoints({ set: next }, `ptab:${next}`);
  });
  return h('section', { class: 'section', 'aria-labelledby': 'h-points' }, headEl,
    list,
    h('div', { role: 'tabpanel', id: 'points-panel', 'aria-labelledby': `ptab-${sel.def.id}`, class: 'tabpanel' }, pointsPanel(sel, ctx)),
    coveragePanel(rows, ctx));
}

// ---------------------------------------------------------------- reminders

const REMINDER_TAG = {
  ok: (row) => tag('ok', row.months ? 'Up to date' : 'Done'),
  due: () => tag('warn', 'Due'),
  never: () => tag('idle', 'Not noted'),
};

function dayText(day, today) {
  if (!day) return '—';
  const n = daysBetween(day, today);
  return [dayLabel(day), h('span', { class: 'quiet' }, n <= 0 ? ' · today' : ` · ${plural(n, 'day')} ago`)];
}

function dateInput(ctx, key, value, today, label, onPick) {
  return h('input', {
    type: 'date', class: 'date-sm', value: value || '', max: today, 'aria-label': label, 'data-focus': key,
    onchange: (e) => { if (e.target.value) onPick(e.target.value); },
  });
}

export function reminders(ctx) {
  const today = ctx.fmt.day(new Date(ctx.now).toISOString());
  const data = ctx.state.report && ctx.state.report.data;
  const auto = { panel: ctx.state.loginSetAt || null, agent: (data && data.agent && data.agent.tokenSetAt) || null };
  const practice = practiceRows(ctx.state.notes, today);
  const keys = keyRows(ctx.state.notes, auto, today);

  const practicePanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Practice restores'), h('p', { class: 'quiet' }, 'Once a month each')),
    h('div', { class: 'remind-list' }, practice.map((r) => h('div', { class: 'remind' },
      h('div', { class: 'remind-main' },
        h('p', { class: 'remind-name' }, r.label, ' ', REMINDER_TAG[r.level](r)),
        h('p', { class: 'cell-sub' }, r.last ? ['Last: ', dayText(r.last, today)] : 'No practice restore noted yet.'),
        h('p', { class: 'cell-sub' }, `On the server: ${r.how}.`)),
      h('div', { class: 'remind-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet btn-sm', 'data-focus': `practice:${r.id}:today`, onclick: () => ctx.onNote({ section: 'practice', id: r.id, date: today }, `practice:${r.id}:today`) }, 'Done today'),
        dateInput(ctx, `practice:${r.id}:date`, r.last, today, `Date of the last ${r.label} practice restore`, (d) => ctx.onNote({ section: 'practice', id: r.id, date: d }, `practice:${r.id}:date`)))))),
    h('p', { class: 'quiet note' }, 'Always restore into a new name or folder; the restore scripts never overwrite the originals.'));

  const keysPanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h3', null, 'Keys and passwords'), h('p', { class: 'quiet' }, 'When each was last changed')),
    h('div', { class: 'remind-list' }, keys.map((r) => h('div', { class: 'remind' },
      h('div', { class: 'remind-main' },
        h('p', { class: 'remind-name' }, r.label, ' ', REMINDER_TAG[r.level](r)),
        h('p', { class: 'cell-sub' }, r.last ? ['Changed: ', dayText(r.last, today), r.manual ? '' : h('span', { class: 'quiet' }, ' (read from the server)')] : r.manual ? 'Not noted yet.' : 'Not known yet.'),
        r.dueOn ? h('p', { class: 'cell-sub' }, `Next change due ${dayLabel(r.dueOn)}`) : null),
      h('div', { class: 'remind-actions' },
        r.manual ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm', 'data-focus': `key:${r.id}:today`, onclick: () => ctx.onNote({ section: 'keys', id: r.id, date: today }, `key:${r.id}:today`) }, 'Changed today') : null,
        r.manual ? dateInput(ctx, `key:${r.id}:date`, r.last, today, `Date ${r.label} was last changed`, (d) => ctx.onNote({ section: 'keys', id: r.id, date: d }, `key:${r.id}:date`)) : null,
        r.manual ? h('select', {
          class: 'date-sm', 'aria-label': `How often to change ${r.label}`, 'data-focus': `key:${r.id}:months`,
          onchange: (e) => ctx.onNote({ section: 'keys', id: r.id, months: Number(e.target.value) }, `key:${r.id}:months`),
        }, KEY_MONTHS.map((m) => h('option', { value: String(m), selected: m === r.months }, `every ${m} months`))) : null)))),
    h('p', { class: 'quiet note' }, 'Only dates are kept here, never the keys themselves.'));

  return h('section', { class: 'section', 'aria-labelledby': 'h-remind' },
    sectionHead('Reminders', 'Dates you note here; the panel turns them into due dates', 'h-remind'),
    h('div', { class: 'split' }, practicePanel, keysPanel));
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
  const hb = a.heartbeat || null;
  const hbText = !hb || !hb.enabled
    ? 'Not set up'
    : hb.lastError ? 'Last ping failed' : hb.lastPingAt ? ['On · pinged ', agoEl(hb.lastPingAt, now)] : 'On, first ping soon';
  return h('section', { class: 'section', 'aria-labelledby': 'h-agent' },
    sectionHead('Server agent', null, 'h-agent'),
    h('div', { class: 'panel panel-row' },
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'Server'), h('dd', null, data.host || '—')),
        h('div', null, h('dt', null, 'Last report'), h('dd', null, stamp(state.report.receivedAt, ctx))),
        h('div', null, h('dt', null, 'Agent'), h('dd', null, `${data.agentVersion || '?'}, PowerShell ${a.psVersion || '?'}`)),
        h('div', null, h('dt', null, 'Run-now'), h('dd', null, mode.on ? `On, ${(a.enabledActions || []).length} of 6 actions` : 'Off')),
        h('div', null, h('dt', null, 'Outside alert'), h('dd', null, hbText))),
      stale ? tag('bad', 'Not reporting') : issues.length ? tag('warn', 'Partial report') : tag('ok', 'Reporting')),
    hb && hb.enabled && hb.lastError ? h('p', { class: 'note note-warn' }, `The outside alert service could not be reached: ${hb.lastError}. If this goes on, it will e-mail you that the server is quiet.`) : null,
    !hb || !hb.enabled ? h('p', { class: 'note quiet' }, 'Nobody is told when this server goes quiet until the outside alert is set up (setup guide, part 10).') : null,
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
        h('td', { class: 'nowrap', 'data-label': 'Requested' }, ctx.fmt.time(c.requested_at), h('span', { class: 'cell-sub' }, c.requested_ip ? `${c.requested_by} · ${c.requested_ip}` : c.requested_by)),
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

const LEVEL_TAG = { ERROR: 'bad', WARN: 'warn', INFO: 'idle' };
const LEVEL_FILTERS = [['INFO', 'All lines'], ['WARN', 'Warnings and errors'], ['ERROR', 'Errors only']];

// Every log's last lines as one list, newest first, with a severity filter.
function eventsList(ctx) {
  const level = ctx.logLevel || 'INFO';
  const events = logEvents(ctx.state.report.data.logs || [], level);
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
    LEVEL_FILTERS.map(([id, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(level === id), 'data-focus': `level:${id}`,
      onclick: () => ctx.onLogLevel(id),
    }, label)));
  const body = events.length
    ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Time', 'Level', 'Log', 'Message'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, events.slice(0, 200).map((e) => h('tr', null,
        h('td', { class: 'nowrap mono', 'data-label': 'Time' }, e.time || '—'),
        h('td', { 'data-label': 'Level' }, tag(LEVEL_TAG[e.level], e.level)),
        h('td', { class: 'nowrap', 'data-label': 'Log' }, e.source),
        h('td', { class: 'mono msg', 'data-label': 'Message' }, e.message))))))
    : h('p', { class: 'empty panel' }, level === 'INFO' ? 'No log lines were sent.' : 'Nothing at this level in the last lines of the logs.');
  return [filters, h('p', { class: 'quiet note' }, 'The last 40 lines of each log, as the agent sends them. Times are the server\'s own.'), body];
}

export function raw(ctx) {
  const tabs = [['logs', 'Log tails'], ['events', 'Events'], ['status', 'Status files']];
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
      ctx.tab === 'logs' ? logList(ctx) : ctx.tab === 'events' ? eventsList(ctx) : statusList(ctx)));
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
