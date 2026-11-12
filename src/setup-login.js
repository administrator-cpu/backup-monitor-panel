// Sets the panel password and authenticator. Run on the server:
//   npm run setup-login               first time, or to replace both
//   npm run setup-login -- --password only change the password
// Restart the panel afterwards (pm2 restart backup-panel) to end old sessions.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { base32Encode, findTotpOffset, hashPassword, matchTotp, newTotpSecret } from './auth.js';
import { loadConfig } from './config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function ask(question, { hidden = false } = {}) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(s);
        else if (s === '\r\n' || s === '\n') process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      done(answer);
    });
  });
}

function human(seconds) {
  const s = Math.abs(seconds);
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${Math.round(s / 60)} minutes`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} hours`;
}

// Says why a code was refused: wrong key, or clocks apart (and by how much).
function explainMismatch(secret, code, now) {
  if (!/^\d{6}$/.test(code)) return 'Type the 6 digits only.';
  const offset = findTotpOffset(secret, code, now);
  const serverTime = `This server's clock: ${new Date(now).toISOString().replace('T', ' ').slice(0, 19)} UTC.`;
  if (offset === null) {
    return [
      'That code does not come from the key shown above.',
      'Most often the app still uses a key from an earlier run of setup-login. Delete every',
      '"Backups panel" entry in the app and add the key shown above. In Microsoft Authenticator',
      'make sure you chose "Other account", and check letters such as B/8 and S/5 in the key.',
    ].join('\n');
  }
  const ahead = offset > 0 ? 'the phone is ahead of this server' : 'this server is ahead of the phone';
  const lines = [`The key is right, but the clocks differ: ${ahead} by about ${human(offset)}.`, serverTime];
  if (Math.abs(Math.abs(offset) - 19800) <= 120) {
    lines.push('That is the India time-zone offset (5 h 30 min): one clock is set to India time while its');
    lines.push('time zone says UTC, or the other way round. On the server, check Get-TimeZone and the time;');
    lines.push('on the phone, switch on automatic date, time and time zone.');
  } else {
    lines.push('Switch on automatic date and time on the phone. On the server, run: w32tm /resync');
  }
  return lines.join('\n');
}

async function choosePassword() {
  for (;;) {
    const a = await ask('New panel password (at least 12 characters, not shown): ', { hidden: true });
    if (a.length < 12) {
      console.log('Too short. Use at least 12 characters; a few random words work well.');
      continue;
    }
    const b = await ask('Type it again: ', { hidden: true });
    if (a === b) return a;
    console.log('The two did not match. Try again.');
  }
}

async function main() {
  const i = process.argv.indexOf('--config');
  const config = loadConfig(i > 0 ? process.argv[i + 1] : join(ROOT, 'panel.config.json'));
  const onlyPassword = process.argv.includes('--password');
  const existing = existsSync(config.loginFile) ? JSON.parse(readFileSync(config.loginFile, 'utf8')) : null;
  if (onlyPassword && !existing) throw new Error('No login yet. Run npm run setup-login without --password first.');

  console.log(`Login file: ${config.loginFile}`);
  const passwordHash = hashPassword(await choosePassword());

  let totpSecret = existing && existing.totpSecret;
  if (!onlyPassword) {
    const secret = newTotpSecret();
    const key = base32Encode(secret);
    console.log('');
    console.log('Add the panel to an authenticator app on your phone. No account or sign-in is needed:');
    console.log('the key below is the whole secret. This run makes a NEW key, so delete any older');
    console.log('"Backups panel" entry in the app first.');
    console.log('');
    console.log('  Google Authenticator   : + > Enter a setup key');
    console.log('  Microsoft Authenticator: + > Other account (Google, Facebook, etc.) > Enter code manually');
    console.log('                           (not "Personal" or "Work or school")');
    console.log('');
    console.log('  Account name : Backups panel');
    console.log(`  Key          : ${key.match(/.{1,4}/g).join(' ')}`);
    console.log(`  (no spaces)  : ${key}`);
    console.log('  Type         : Time based');
    console.log('');
    for (;;) {
      const code = (await ask('Type the 6-digit code the app now shows: ')).replace(/\s/g, '');
      const now = Date.now();
      if (matchTotp(secret, code, now) !== null) break;
      console.log(explainMismatch(secret, code, now));
      console.log('Same key, nothing to re-add: just type the next code from the app.');
      console.log('');
    }
    totpSecret = key;
  }

  mkdirSync(dirname(config.loginFile), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(config.loginFile, JSON.stringify({ version: 1, passwordHash, totpSecret, createdAt: (existing && existing.createdAt) || now, updatedAt: now }, null, 2));
  console.log('');
  console.log('Saved. Restart the panel so old sessions end:  pm2 restart backup-panel');
}

// Exit explicitly: the console input stays open after the last question.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
