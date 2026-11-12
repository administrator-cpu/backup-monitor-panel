// Response helpers. Security headers are added once, by withSecurityHeaders,
// on the way out of the app.

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Plain message pages carry one inline <style> block, no scripts and only escaped text.
const MESSAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function withSecurityHeaders(response, { hsts = false } = {}) {
  const h = response.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', CSP);
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (hsts) h.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function fail(status, error, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

export function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

const MESSAGE_STYLE = `
:root{color-scheme:light dark;--bg:#f3f1ec;--panel:#fbfaf7;--ink:#1d1c1a;--ink-2:#5f5b53;--rule:#dcd7cc;--accent:#284a73}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--panel:#1b1d20;--ink:#e9e7e2;--ink-2:#a19d94;--rule:#2e3035;--accent:#8db0e0}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 'Segoe UI',system-ui,sans-serif}
main{max-width:34rem;margin:12vh auto 0;padding:24px;background:var(--panel);border:1px solid var(--rule);border-top:3px solid var(--accent);border-radius:6px}
p.k{margin:0 0 6px;font-size:.8rem;color:var(--ink-2)}p.b{margin-top:14px}h1{margin:0 0 10px;font-size:1.2rem}p{margin:0}a{color:var(--accent)}`;

export function htmlMessage(status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${MESSAGE_STYLE}</style></head><body><main><p class="k">Backups · HTTP ${status}</p><h1>${esc(title)}</h1><p>${esc(text)}</p><p class="b"><a href="/">Back to the panel</a></p></main></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': MESSAGE_CSP } });
}

// Read a request body as text, refusing anything larger than maxBytes.
export async function readBody(request, maxBytes) {
  if (Number(request.headers.get('Content-Length') || '0') > maxBytes) return { tooLarge: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

export async function readJson(request, maxBytes) {
  const { text, tooLarge } = await readBody(request, maxBytes);
  if (tooLarge) return { error: fail(413, 'Request body too large') };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: fail(400, 'Body is not valid JSON') };
  }
}
