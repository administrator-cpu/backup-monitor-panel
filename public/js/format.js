// Formatting helpers. Pure: no DOM, no clock (callers pass `now`).

export function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function makeFormatter(timeZone) {
  const stamp = new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const clock = new Intl.DateTimeFormat('en-IN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const date = new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return {
    time: (iso) => {
      const t = parseTime(iso);
      return t === null ? '—' : stamp.format(t);
    },
    clock: (iso) => {
      const t = parseTime(iso);
      return t === null ? '—' : clock.format(t);
    },
    date: (ms) => date.format(ms),
    // 'YYYY-MM-DD' of a moment, in this time zone (for date filters).
    day: (iso) => {
      const t = parseTime(iso);
      return t === null ? null : isoDay.format(t);
    },
  };
}

// A calendar day such as '2026-11-12' (a Drive folder name) as '12 Nov 2026'. No time zone shift.
const DAY_LABEL = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
export function dayLabel(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(day)) return '—';
  return DAY_LABEL.format(Date.parse(`${day}T00:00:00Z`));
}

// The viewer's own time zone as the browser reports it, or null.
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// Minutes ahead of UTC in a time zone at a given moment (India: 330).
export function zoneOffsetMinutes(timeZone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

// "Kolkata, UTC+05:30"
export function zoneLabel(timeZone, ms) {
  const off = zoneOffsetMinutes(timeZone, ms);
  const a = Math.abs(off);
  const utc = `UTC${off < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  const city = timeZone.split('/').pop().replace(/_/g, ' ');
  return city && city !== timeZone.replace(/_/g, ' ') ? `${city}, ${utc}` : `${timeZone}, ${utc}`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const min = s / 60;
  if (min < 90) return `${Math.round(min)} min`;
  const hr = min / 60;
  if (hr < 48) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} h`;
  return `${Math.round(hr / 24)} days`;
}

export function ago(iso, now) {
  const t = parseTime(iso);
  if (t === null) return '';
  if (now - t < 0) return 'just now';
  return `${duration((now - t) / 1000)} ago`;
}

export function until(iso, now) {
  const t = parseTime(iso);
  if (t === null) return '';
  return t <= now ? 'due now' : `in ${duration((t - now) / 1000)}`;
}

function scale(n, base, digitsFromGB) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${i >= 3 ? v.toFixed(digitsFromGB) : Math.round(v)} ${units[i]}`;
}

// Disks: binary units, matching Windows and the PowerShell scripts (1 GB = 1024^3 bytes).
export const binBytes = (n) => scale(n, 1024, 1);

// Backblaze: decimal units, matching how Backblaze bills (1 GB = 10^9 bytes).
export const decBytes = (n) => scale(n, 1000, 2);

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
