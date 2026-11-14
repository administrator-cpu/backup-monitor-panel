// Who may call what:
//  - the owner's browser: password + authenticator code once, then a session
//    cookie (HttpOnly, SameSite=Strict, Secure over HTTPS) for up to 12 hours;
//  - the agent: "Authorization: Bearer <token>" whose SHA-256 matches the
//    fingerprint file written by panel-agent-setup.ps1 -NewToken.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const SESSION_HOURS = 12;
const MAX_SESSIONS = 10;
const FAIL_WINDOW_MS = 15 * 60000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 20;

export const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ password

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, want);
}

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 6 digits, 30 s)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// Returns the matching time step (allowing one step of clock drift) or null.
export function matchTotp(secret, code, nowMs) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = Math.floor(nowMs / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (safeEqual(totpAt(secret, s), code)) return s;
  }
  return null;
}

export const newTotpSecret = () => randomBytes(20);

// For setup only: if the code belongs to this key at all within +-12 hours,
// return how many seconds the phone is ahead of this machine (negative:
// behind). null means the code did not come from this key.
export function findTotpOffset(secret, code, nowMs, maxHours = 12) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = Math.floor(nowMs / 30000);
  for (let d = 0; d <= maxHours * 120; d++) {
    for (const s of d === 0 ? [step] : [step + d, step - d]) {
      if (totpAt(secret, s) === code) return (s - step) * 30;
    }
  }
  return null;
}

// ------------------------------------------------------------------ login, sessions, lockout

export function createAuth({ loginFile, log = console.log }) {
  const sessions = new Map(); // sha256(token) -> { created, ip }
  const fails = []; // { at, ip } within the lockout window; cleared per address on success
  const failLog = []; // timestamps of every failure in the last 24 h, for the page
  let lastStep = -1;

  function loginData() {
    if (!existsSync(loginFile)) return null;
    const d = JSON.parse(readFileSync(loginFile, 'utf8'));
    return d && d.passwordHash && d.totpSecret ? d : null;
  }

  function lockedFor(ip, now) {
    const recent = fails.filter((f) => now - f.at < FAIL_WINDOW_MS);
    fails.splice(0, fails.length, ...recent);
    const mine = recent.filter((f) => f.ip === ip);
    const until = (list) => list[0].at + FAIL_WINDOW_MS - now;
    if (mine.length >= MAX_FAILS_PER_IP) return until(mine.slice(-MAX_FAILS_PER_IP));
    if (recent.length >= MAX_FAILS_TOTAL) return until(recent.slice(-MAX_FAILS_TOTAL));
    return 0;
  }

  return {
    isSetUp: () => loginData() !== null,

    // When setup-login last wrote the password and authenticator key (for the reminders).
    loginSetAt() {
      try {
        return existsSync(loginFile) ? statSync(loginFile).mtime.toISOString() : null;
      } catch {
        return null;
      }
    },

    // { ok, token } | { ok: false, status, error, retryMinutes? }
    login(password, code, ip, now) {
      const data = loginData();
      if (!data) return { ok: false, status: 503, error: 'The login is not set up yet. On the server, run: npm run setup-login' };
      const wait = lockedFor(ip, now);
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60000);
        return { ok: false, status: 429, error: `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryMinutes: minutes };
      }
      // Check both, always, so the answer time does not reveal which was wrong.
      const passOk = verifyPassword(String(password || ''), data.passwordHash);
      const step = matchTotp(base32Decode(data.totpSecret), String(code || '').replace(/\s/g, ''), now);
      const codeOk = step !== null && step > lastStep;
      if (!passOk || !codeOk) {
        fails.push({ at: now, ip });
        failLog.push(now);
        while (failLog.length && now - failLog[0] > 86400000) failLog.shift();
        log(`Sign-in failed from ${ip}`);
        return { ok: false, status: 401, error: 'Wrong password or code.' };
      }
      lastStep = step; // a code works once
      for (let i = fails.length - 1; i >= 0; i--) if (fails[i].ip === ip) fails.splice(i, 1);
      const token = randomBytes(32).toString('base64url');
      sessions.set(sha256Hex(token), { created: now, ip });
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      log(`Signed in from ${ip}`);
      return { ok: true, token };
    },

    session(token, now) {
      if (!token) return null;
      const key = sha256Hex(token);
      const s = sessions.get(key);
      if (!s) return null;
      if (now - s.created > SESSION_HOURS * 3600000) {
        sessions.delete(key);
        return null;
      }
      return s;
    },

    logout(token) {
      if (token) sessions.delete(sha256Hex(token));
    },

    failuresSince(sinceMs) {
      return failLog.filter((t) => t >= sinceMs).length;
    },
  };
}

// ------------------------------------------------------------------ agent token

export function createAgentCheck(hashFile) {
  let cached = { mtime: -1, hash: '' };
  function expected() {
    if (!existsSync(hashFile)) return '';
    const mtime = statSync(hashFile).mtimeMs;
    if (mtime !== cached.mtime) cached = { mtime, hash: readFileSync(hashFile, 'utf8').replace(/^﻿/, '').trim().toLowerCase() };
    return cached.hash;
  }
  return (request) => {
    const want = expected();
    if (!/^[0-9a-f]{64}$/.test(want)) return { status: 503, message: 'No agent token fingerprint yet. On the server, run: .\\panel-agent-setup.ps1 -NewToken' };
    const m = /^Bearer ([A-Za-z0-9_\-.~+/=]{20,200})$/.exec(request.headers.get('Authorization') || '');
    if (!m) return { status: 401, message: 'Missing or malformed agent token.' };
    if (!safeEqual(sha256Hex(m[1]), want)) return { status: 401, message: 'Wrong agent token.' };
    return { ok: true };
  };
}

// ------------------------------------------------------------------ cookies

export function sessionCookieName(secure) {
  return secure ? '__Host-bp_session' : 'bp_session';
}

export function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(name, token, secure) {
  const attrs = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? SESSION_HOURS * 3600 : 0}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
