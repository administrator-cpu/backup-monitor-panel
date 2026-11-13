// The gate page. The browser keeps the gate key in a cookie (bp_gate); Nginx
// compares it with the key in conf\backup-panel-gate.conf and lets the browser
// through to the panel's own sign-in only when it matches.

const COOKIE = 'bp_gate';
const DAYS = 30;

const form = document.getElementById('gate-form');
const input = document.getElementById('gate-key');
const show = document.getElementById('gate-show');
const remember = document.getElementById('gate-remember');
const error = document.getElementById('gate-error');
const submit = document.getElementById('gate-submit');

// "abcde fghjk-lmnpq..." -> "ABCDE-FGHJK-LMNPQ-RSTUV"
export function canonicalKey(text) {
  const plain = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (plain.match(/.{1,5}/g) || []).join('-');
}

function setCookie(value, keep) {
  const life = keep ? `; Max-Age=${DAYS * 86400}` : '';
  document.cookie = `${COOKIE}=${value}; Path=/; Secure; SameSite=Strict${life}`;
}

function clearCookie() {
  document.cookie = `${COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
}

const hasCookie = () => document.cookie.split(';').some((c) => c.trim().startsWith(`${COOKIE}=`) && c.trim().length > COOKIE.length + 1);

async function askServer() {
  const res = await fetch('/gate/check', { cache: 'no-store', credentials: 'same-origin' });
  return res.status;
}

function fail(text) {
  error.textContent = text;
  error.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  input.select();
}

const enter = () => window.location.replace('/');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  input.removeAttribute('aria-invalid');
  const key = canonicalKey(input.value);
  if (key.replace(/-/g, '').length !== 20) {
    fail('The key has 20 letters and digits, like ABCDE-FGHJK-LMNPQ-RSTUV.');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Checking…';
  setCookie(key, remember.checked);
  try {
    const status = await askServer();
    if (status === 204) {
      enter();
      return;
    }
    clearCookie();
    if (status === 429) fail('Too many tries. Wait a minute, then try again.');
    else fail('That key is not right.');
  } catch {
    clearCookie();
    fail('The server did not answer. Check the connection and try again.');
  }
  submit.disabled = false;
  submit.textContent = 'Continue';
});

show.addEventListener('click', () => {
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  show.textContent = visible ? 'Show' : 'Hide';
  show.setAttribute('aria-pressed', String(!visible));
  input.focus();
});

// Already let in on this device? Go straight on.
if (hasCookie()) {
  askServer().then((status) => {
    if (status === 204) enter();
    else if (status === 403) clearCookie();
  }).catch(() => {});
}
input.focus();
