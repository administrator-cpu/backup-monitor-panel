// Sets the panel password and authenticator. Run on the server:
//   npm run setup-login               first time, or to replace both
//   npm run setup-login -- --password only change the password
// Restart the panel afterwards (pm2 restart backup-panel) to end old sessions.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { base32Decode, base32Encode, hashPassword, matchTotp, newTotpSecret } from './auth.js';
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
    console.log('Add the panel to your authenticator app (Google Authenticator, Microsoft Authenticator, ...):');
    console.log('  Add account > Enter a setup key');
    console.log('  Account name : Backups panel');
    console.log(`  Key          : ${key.match(/.{1,4}/g).join(' ')}`);
    console.log('  Type         : Time based');
    console.log('');
    for (;;) {
      const code = (await ask('Type the 6-digit code the app now shows: ')).replace(/\s/g, '');
      if (matchTotp(base32Decode(key), code, Date.now()) !== null) break;
      console.log('That code does not match. Check the key was typed exactly, and that the server clock is right.');
    }
    totpSecret = key;
  }

  mkdirSync(dirname(config.loginFile), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(config.loginFile, JSON.stringify({ version: 1, passwordHash, totpSecret, createdAt: (existing && existing.createdAt) || now, updatedAt: now }, null, 2));
  console.log('');
  console.log('Saved. Restart the panel so old sessions end:  pm2 restart backup-panel');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
