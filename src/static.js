// Serves files from public/. Only plain paths inside that folder are served.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createAssets(root) {
  const base = normalize(root + sep);
  return async function asset(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(decoded)) return null;
    const type = TYPES[extname(decoded).toLowerCase()];
    if (!type) return null;
    const file = normalize(join(base, decoded));
    if (!file.startsWith(base)) return null;
    try {
      if (!(await stat(file)).isFile()) return null;
      return new Response(await readFile(file), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      return null;
    }
  };
}
