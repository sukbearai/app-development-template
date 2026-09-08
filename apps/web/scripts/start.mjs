import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadDotenv } from 'vinext/internal/config/dotenv';
import { createWebLifecycle, runWebProcess } from './process-lifecycle.mjs';

const { values } = parseArgs({ options: {
  hostname: { type: 'string', short: 'H' },
  port: { type: 'string', short: 'p' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  process.stdout.write('Usage: start [--hostname HOST] [--port PORT]\n');
  process.exit(0);
}
loadDotenv({ root: process.cwd(), mode: 'production' });
const port = Number(values.port ?? process.env.PORT ?? '3000');
const timeoutMs = Number(process.env.WEB_SHUTDOWN_TIMEOUT_MS ?? '30000');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Web port');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
  throw new Error('WEB_SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 300000');
const lifecycle = createWebLifecycle();
process.pstackWebLifecycle = lifecycle;
await runWebProcess({ lifecycle, timeoutMs, start: async () => {
  const { startProdServer } = await import('vinext/server/prod-server');
  const { server } = await startProdServer({
    port, host: values.hostname ?? '0.0.0.0', outDir: path.resolve('dist'),
  });
  return server;
} });
