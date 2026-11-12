// Local testing only: writes a known dev login and agent fingerprint into
// .dev-data/ (git-ignored) so `npm run dev` can be signed into at once.
//   node dev/seed-dev-login.js        then   node dev/dev-code.js  for a code
// Never use these values on the server; run npm run setup-login there.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32Encode, hashPassword, sha256Hex } from '../src/auth.js';

export const DEV_PASSWORD = 'local dev password only';
export const DEV_TOTP_SECRET = Buffer.from('dev-only-totp-secret');
export const DEV_AGENT_TOKEN = 'local-test-token-0123456789abcdef';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev-data');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'login.json'), JSON.stringify({ version: 1, passwordHash: hashPassword(DEV_PASSWORD), totpSecret: base32Encode(DEV_TOTP_SECRET) }, null, 2));
writeFileSync(join(dir, 'agent-token.sha256'), `${sha256Hex(DEV_AGENT_TOKEN)}\n`);
console.log(`Dev login written to ${dir}`);
