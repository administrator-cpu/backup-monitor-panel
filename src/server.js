// Backup panel entry point: node src/server.js [--config path]
// Always starts the server, whether run by node directly or by PM2.

import { DEFAULT_CONFIG, log, startPanel } from './panel.js';

const i = process.argv.indexOf('--config');
const configPath = i > 0 ? process.argv[i + 1] : DEFAULT_CONFIG;

log(`Starting backup panel (Node ${process.version}, config ${configPath})`);
startPanel(configPath).catch((e) => {
  // To the error log, and only exit once it is written: on Windows, output to
  // PM2's pipe is asynchronous and an immediate exit would lose the reason.
  process.stderr.write(`${new Date().toISOString()} Could not start: ${e.message}\n`, () => process.exit(1));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
