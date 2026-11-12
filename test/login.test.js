import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hashPassword, matchTotp, totpAt, verifyPassword } from '../src/auth.js';
import { call, Clock, code, makePanel, pageHeaders, PASSWORD, signIn, TOTP_SECRET } from './helpers.js';

const login = (panel, clock, body, extra = {}) => call(panel, clock, 'POST', '/api/login', { headers: pageHeaders, body, cookie: null, ...extra });

test('TOTP matches the RFC 6238 test vectors', () => {
  // RFC 6238 appendix B (SHA-1), last 6 of the 8 published digits.
  for (const [t, want] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(totpAt(TOTP_SECRET, Math.floor(t / 30)), want, `T=${t}`);
  }
  assert.deepEqual(base32Decode(base32Encode(TOTP_SECRET)), TOTP_SECRET);
  assert.equal(matchTotp(TOTP_SECRET, '287082', 59000), 1);
  assert.equal(matchTotp(TOTP_SECRET, '287082', 59000 + 30000), 1, 'one step of clock drift is allowed');
  assert.equal(matchTotp(TOTP_SECRET, '287082', 59000 + 90000), null, 'older codes are not');
  assert.equal(matchTotp(TOTP_SECRET, '28708', 59000), null);
});

test('passwords are stored as scrypt hashes', () => {
  const h = hashPassword('hunter2 but longer');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!h.includes('hunter2'));
  assert.equal(verifyPassword('hunter2 but longer', h), true);
  assert.equal(verifyPassword('hunter2 but longe', h), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
});

test('signing in sets a strict session cookie and opens the panel', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const r = await signIn(panel, clock);
  const cookie = r.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-bp_session=[A-Za-z0-9_-]{40,};/);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(cookie.includes(attr), attr);
  assert.equal((await call(panel, clock, 'GET', '/api/status')).status, 200);
  assert.equal((await call(panel, clock, 'GET', '/')).text, 'asset /');
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000');
});

test('plain http (inside RDP) gets a non-Secure cookie without the __Host- prefix', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const r = await login(panel, clock, { password: PASSWORD, code: code(clock) }, { origin: 'http://127.0.0.1:7480', headers: { ...pageHeaders, Origin: 'http://127.0.0.1:7480' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Set-Cookie'), /^bp_session=/);
  assert.ok(!r.headers.get('Set-Cookie').includes('Secure'));
});

test('wrong password or code: one vague answer, then a lockout', async () => {
  const panel = makePanel();
  const clock = new Clock();
  let r = await login(panel, clock, { password: 'nope', code: code(clock) });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'Wrong password or code.');
  assert.equal(r.headers.get('Set-Cookie'), null);
  r = await login(panel, clock, { password: PASSWORD, code: '000000' });
  assert.equal(r.json.error, 'Wrong password or code.', 'the same answer, so it does not say which was wrong');
  for (let i = 0; i < 3; i++) await login(panel, clock, { password: 'nope', code: '123456' });
  r = await login(panel, clock, { password: PASSWORD, code: code(clock) });
  assert.equal(r.status, 429, 'locked after 5 failures, even with the right details');
  assert.match(r.json.error, /Try again in 15 minutes/);
  const other = { ...pageHeaders };
  r = await login(panel, clock, { password: PASSWORD, code: code(clock) }, { headers: other, peer: { address: '127.0.0.1', forwarded: true, ip: '198.51.100.9' } });
  assert.equal(r.status, 200, 'the lock is per address');
  clock.advance(15 * 60000 + 1000);
  r = await login(panel, clock, { password: PASSWORD, code: code(clock) });
  assert.equal(r.status, 200, 'unlocked after 15 minutes');
});

test('failed attempts stay counted for 24 hours, even after a good sign-in', async () => {
  const panel = makePanel();
  const clock = new Clock();
  await login(panel, clock, { password: PASSWORD, code: '000000' });
  await signIn(panel, clock);
  assert.equal((await call(panel, clock, 'GET', '/api/status')).json.failedSignIns24h, 1);
  clock.advance(25 * 3600000);
  await signIn(panel, clock);
  assert.equal((await call(panel, clock, 'GET', '/api/status')).json.failedSignIns24h, 0);
});

test('many failures from many addresses lock sign-in for everyone', async () => {
  const panel = makePanel();
  const clock = new Clock();
  for (let i = 0; i < 20; i++) {
    await login(panel, clock, { password: 'x', code: '111111' }, { peer: { address: '127.0.0.1', forwarded: true, ip: `198.51.100.${i}` } });
  }
  const r = await login(panel, clock, { password: PASSWORD, code: code(clock) }, { peer: { address: '127.0.0.1', forwarded: true, ip: '192.0.2.1' } });
  assert.equal(r.status, 429);
});

test('a code works only once', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const c = code(clock);
  assert.equal((await login(panel, clock, { password: PASSWORD, code: c })).status, 200);
  assert.equal((await login(panel, clock, { password: PASSWORD, code: c })).status, 401, 'replayed code refused');
  clock.advance(30000);
  assert.equal((await login(panel, clock, { password: PASSWORD, code: code(clock) })).status, 200, 'the next code works');
});

test('sessions end after 12 hours, on sign-out, and do not survive a forged cookie', async () => {
  const panel = makePanel();
  const clock = new Clock();
  await signIn(panel, clock);
  clock.advance(11 * 3600000);
  assert.equal((await call(panel, clock, 'GET', '/api/status')).status, 200);
  clock.advance(1.5 * 3600000);
  const r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.status, 401);
  assert.equal(r.json.signIn, true);

  clock.advance(60000);
  await signIn(panel, clock);
  const out = await call(panel, clock, 'POST', '/api/logout', { headers: pageHeaders, body: {} });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await call(panel, clock, 'GET', '/api/status')).status, 401, 'old cookie is dead after sign-out');
  assert.equal((await call(panel, clock, 'GET', '/api/status', { cookie: '__Host-bp_session=forged-value-1234567890' })).status, 401);
});

test('without a session: page redirects to /login, API says sign in, sign-in files stay public', async () => {
  const panel = makePanel();
  const clock = new Clock();
  let r = await call(panel, clock, 'GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/login');
  r = await call(panel, clock, 'GET', '/api/status');
  assert.equal(r.status, 401);
  assert.equal(r.json.signIn, true);
  assert.equal((await call(panel, clock, 'GET', '/js/main.js')).status, 401, 'the panel code needs a session');
  for (const path of ['/login', '/js/login.js', '/app.css']) {
    assert.equal((await call(panel, clock, 'GET', path)).status, 200, path);
  }
  await signIn(panel, clock);
  r = await call(panel, clock, 'GET', '/login');
  assert.equal(r.status, 302, 'signed in: /login goes to the panel');
});

test('the sign-in form refuses cross-site posts', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const body = { password: PASSWORD, code: code(clock) };
  assert.equal((await login(panel, clock, body, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await login(panel, clock, body, { headers: { ...pageHeaders, Origin: 'https://evil.example' } })).status, 403);
});

test('before setup-login has run, sign-in explains what to do', async () => {
  const panel = makePanel({}, { loginSetUp: false });
  const clock = new Clock();
  const r = await login(panel, clock, { password: PASSWORD, code: code(clock) });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /npm run setup-login/);
});

test('every response carries the security headers', async () => {
  const panel = makePanel();
  const clock = new Clock();
  const r = await call(panel, clock, 'GET', '/login');
  assert.match(r.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  const api = await call(panel, clock, 'GET', '/api/status');
  assert.equal(api.headers.get('Cache-Control'), 'no-store');
});
