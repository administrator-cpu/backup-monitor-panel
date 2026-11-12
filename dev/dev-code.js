// Prints the current authenticator code for the dev login (local testing only).
import { totpAt } from '../src/auth.js';

const DEV_TOTP_SECRET = Buffer.from('dev-only-totp-secret');
console.log(totpAt(DEV_TOTP_SECRET, Math.floor(Date.now() / 30000)));
