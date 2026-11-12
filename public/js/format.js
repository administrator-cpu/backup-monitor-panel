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
  };
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
