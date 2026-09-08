import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, realpathSync } from 'node:fs';
import { buildSha256, processIdentity, sourceSha256 } from '../.agents/skills/verify-pstack-x/scripts/identity.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { verifyWebShutdown } from './web-shutdown-scenarios.mjs';
import { acquireProductionLock, capacityPreflight, verificationOptions } from './capacity-options.mjs';
import { runCapacityWorkload } from './capacity-workload.mjs';

const options = verificationOptions(process.argv.slice(2));
const { mode, production } = options;
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const webRoot = path.join(root, 'apps/web');
const vinextCLI = realpathSync(path.join(webRoot, 'node_modules/vinext/dist/cli.js'));
const outputRoot = path.join(root, '.verification', 'app');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'run-'));
const containerName = `pstack-x-verify-${randomBytes(6).toString('hex')}`;
const pgPassword = randomBytes(24).toString('hex');
const adminPassword = randomBytes(24).toString('base64url');
const log = createWriteStream(path.join(output, 'run.log'));
let containerCreated = false;
let server;
let serverOutput = '';
let interrupted = false;
const interruption = new AbortController();
let releaseProductionLock;
let capacityResult;
let monitoringCheck = false;
let failure;
let result;
let verificationStage = 'preflight';
const commands = new Set();
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (/^(PSTACK_VERIFY_|PG[A-Z_]*$|DATABASE_|E2E_|UI_FLOW_|APP_|SESSION_|RATE_LIMIT_|LOGIN_RATE_|REDIS_|KAFKA_|OUTBOX_|ASYNC_|UPLOAD_|OBJECT_STORAGE_|CLICKHOUSE_|BOOTSTRAP_|MONITOR_|METRICS_|SERVICE_|WEB_|SMOKE_|VITE_|PORT$|NODE_OPTIONS$)/.test(key)) delete childEnv[key];
}
Object.assign(childEnv, {
  APP_NAME: 'pstack-x', APP_ENV: 'test', NODE_ENV: 'test', RATE_LIMIT_DRIVER: 'memory',
  UPLOAD_STORAGE_DRIVER: 'local', UPLOAD_STORAGE_DIR: path.join(output, 'uploads'),
  OUTBOX_PUBLISHER: 'disabled', LOG_LEVEL: 'warn', SESSION_COOKIE_SECURE: 'false',
  BOOTSTRAP_ADMIN_ACCOUNT: 'admin', BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
  BOOTSTRAP_ADMIN_DISPLAY_NAME: 'Test administrator',
  UI_FLOW_ADMIN_ACCOUNT: 'admin', UI_FLOW_ADMIN_PASSWORD: adminPassword,
  SERVICE_TOKEN: randomBytes(32).toString('hex'),
  METRICS_TOKEN: randomBytes(32).toString('base64url'),
  WEB_REPLICAS: '1',
});

if (mode === 'capacity') Object.assign(childEnv, {
  UPLOAD_MAX_CONCURRENT: '2', UPLOAD_MAX_BYTES: String(10 * 1024 * 1024),
  UPLOAD_STORAGE_SHARED: 'false', LOGIN_RATE_LIMIT_MAX: String(options.capacity.requests + 10),
  LOGIN_RATE_LIMIT_GLOBAL_MAX: String(options.capacity.requests + 10),
});

function command(program, args, { env = childEnv, capture = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error("Verification interrupted");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    commands.add(child);
    child.once('close', () => commands.delete(child));
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (!capture) { process.stdout.write(chunk); log.write(chunk); } });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${program} ${args[0]} failed (${code ?? signal})`)));
  });
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Assert the TCP address variant returned by the ephemeral listener before reading its port.
  assert.ok(address && typeof address === 'object');
  await new Promise(resolve => socket.close(resolve));
  return address.port;
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const timer = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }, 10_000);
  try { await exited; } finally { clearTimeout(timer); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  interruption.abort();
  for (const child of commands) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  void stopServer();
  process.exitCode = 1;
});
console.log(`Evidence: ${output}`);
try {
  if (mode === 'capacity') await capacityPreflight(root);
  verificationStage = 'ownership_lock';
  if (production) releaseProductionLock = await acquireProductionLock(root);
  verificationStage = 'postgres_start';
  await command('docker', ['run', '-d', '--name', containerName, '--label', 'pstack-x.test=app', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=pstack_test', '-p', '127.0.0.1::5432', process.env.PSTACK_TEST_POSTGRES_IMAGE || 'postgres:17-bullseye'], { capture: true, env: { ...childEnv, POSTGRES_PASSWORD: pgPassword } });
  containerCreated = true;
  const mapped = await command('docker', ['port', containerName, '5432/tcp'], { capture: true });
  const pgPort = Number(mapped.split(':').at(-1));
  childEnv.DATABASE_URL = `postgresql://postgres:${pgPassword}@127.0.0.1:${pgPort}/pstack_test`;
  for (let attempt = 0; ; attempt++) {
    try { await command('docker', ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'pstack_test'], { capture: true }); break; }
    catch (error) { if (attempt === 60) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  verificationStage = 'database_setup';
  await command('pnpm', ['--filter', '@pstack/database', 'db:migrate']);
  await command('pnpm', ['--filter', '@pstack/server', 'admin:bootstrap']);
  await command('pnpm', ['--filter', '@pstack/database', 'db:integration']);
  const port = await freePort();
  childEnv.APP_ORIGIN = `http://127.0.0.1:${port}`;
  childEnv.SMOKE_BASE_URL = childEnv.APP_ORIGIN;
  childEnv.PSTACK_VERIFY_PORT = String(port);
  if (mode === 'ui' && !production) {
    await command('bash', ['.agents/skills/verify-pstack-x/scripts/run.sh']);
  } else {
    let buildIdentity;
    if (production) {
      verificationStage = 'build';
      const source = sourceSha256(root);
      await command('pnpm', ['build'], { env: { ...childEnv, NODE_ENV: 'production', APP_ENV: 'production' } });
      assert.equal(sourceSha256(root), source, 'Source changed during production build');
      buildIdentity = { sourceSha256: source, buildSha256: buildSha256(root) };
    }
    let launch = 0;
    async function launchServer(overrides = {}) {
      serverOutput = '';
      const startedAt = Date.now();
      const serverEnv = { ...childEnv, WEB_SHUTDOWN_TIMEOUT_MS: '5000', ...overrides };
      if (production) Object.assign(serverEnv, { NODE_ENV: 'production', APP_ENV: 'production' });
      server = spawn(process.execPath, [...(production ? [path.join(webRoot, 'scripts/start.mjs')] : [vinextCLI, 'dev']), '--hostname', '127.0.0.1', '--port', String(port)], { cwd: webRoot, env: serverEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout.on('data', chunk => { serverOutput += chunk; log.write(chunk); });
      server.stderr.on('data', chunk => { serverOutput += chunk; log.write(chunk); });
      const deadline = Date.now() + 60_000;
      while (true) {
        if (interrupted) throw new Error('Verification interrupted');
        if (server.exitCode !== null || server.signalCode !== null) throw new Error('Web server exited before readiness; inspect run.log');
        try {
          const response = await fetch(new URL('/api/hello', childEnv.APP_ORIGIN), { signal: AbortSignal.timeout(1000) });
          if (response.ok) break;
        } catch {}
        if (Date.now() > deadline) throw new Error('Web server readiness timed out');
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (production) {
        const identity = processIdentity(server.pid);
        assert.equal(identity.ppid, process.pid);
        assert.equal(identity.pgid, server.pid);
        childEnv.PSTACK_VERIFY_MODE = 'production';
        childEnv.PSTACK_VERIFY_STARTED_MS = String(startedAt);
        childEnv.PSTACK_VERIFY_OWNER = path.join(output, `production-owner-${++launch}.json`);
        await writeFile(childEnv.PSTACK_VERIFY_OWNER, JSON.stringify({
          mode: 'production', root, cwd: webRoot, hostname: '127.0.0.1', port,
          baseURL: childEnv.APP_ORIGIN, harnessPid: process.pid, pid: server.pid,
          pgid: identity.pgid, processStarted: identity.processStarted, startedAt, ...buildIdentity,
        }, null, 2), { flag: 'wx' });
        await command('node', ['.agents/skills/verify-pstack-x/scripts/doctor.mjs']);
      }
      return server;
    }
    verificationStage = 'server_launch';
    if (mode === 'capacity') await capacityPreflight(root);
    await launchServer();
    if (mode === 'capacity') {
      verificationStage = 'workload';
      capacityResult = await runCapacityWorkload({ env: childEnv, options: options.capacity, signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(300_000)]) });
      verificationStage = 'final_ownership';
      await capacityPreflight(root);
      await command('node', ['.agents/skills/verify-pstack-x/scripts/doctor.mjs']);
      if (capacityResult.status !== 'passed') throw new Error(capacityResult.error);
      verificationStage = 'monitoring';
      await command('node', ['scripts/monitor-check.mjs'], { env: { ...childEnv, METRICS_URL: new URL('/api/system/metrics', childEnv.APP_ORIGIN).href } });
      monitoringCheck = true;
      capacityResult.monitoringCheck = true;
    } else {
      await command('node', ['apps/web/scripts/smoke.mjs']);
      if (mode === 'ui') await command('bash', ['.agents/skills/verify-pstack-x/scripts/run.sh']);
      if (production) {
        const failures = serverOutput.split('\n').flatMap(line => {
          try {
            const entry = JSON.parse(line);
            return entry.message === 'http request failed' ? [entry] : [];
          } catch { return []; }
        });
        assert.ok(failures.some(entry => entry.fields?.error?.frames?.some(frame => /^(?:apps\/web\/)?dist\/server\//.test(frame.file))), 'Production HTTP failures must retain application bundle source locations');
        await stopServer();
        childEnv.POSTGRES_TOOLS = 'docker';
        childEnv.POSTGRES_TOOL_IMAGE = process.env.PSTACK_TEST_POSTGRES_IMAGE || 'postgres:17-bullseye';
        const backupPath = path.join(output, 'backup');
        await command('node', ['scripts/db-backup.mjs', 'create', '--id', 'app', '--output', backupPath]);
        const control = new Client({ connectionString: childEnv.DATABASE_URL });
        await control.connect();
        try { await control.query('CREATE DATABASE pstack_restored'); } finally { await control.end(); }
        const restored = new URL(childEnv.DATABASE_URL);
        restored.pathname = '/pstack_restored';
        childEnv.DATABASE_URL = restored.href;
        await command('node', ['scripts/db-backup.mjs', 'restore', '--file', path.join(backupPath, 'app.dump'), '--confirm']);
        await command('pnpm', ['--filter', '@pstack/database', 'db:migrate']);
        await command('pnpm', ['--filter', '@pstack/database', 'db:integration']);
        await launchServer();
        await command('node', ['apps/web/scripts/smoke.mjs']);
        if (mode === 'ui') await command('bash', ['.agents/skills/verify-pstack-x/scripts/run.sh']);
        await stopServer();
        await verifyWebShutdown({ launch: launchServer, env: childEnv, output });
      }
    }

  }
  result = {
    status: 'passed', mode, production, containerName,
    databaseRestore: production && mode !== 'capacity',
    browserRuns: mode === 'ui' ? (production ? 2 : 1) : 0,
    webShutdown: production && mode !== 'capacity',
    monitoringCheck,
    boundary: mode === 'capacity'
      ? 'Bounded local production-artifact HTTP workload with owned PostgreSQL and local uploads. No browser, restore, optional middleware, deployment capacity or SLA claim. Latencies include response body parsing; peaks are sampled, not exhaustive.'
      : 'Owned ephemeral PostgreSQL and real application. Production verification restores the database and exercises Web shutdown. UI mode runs Playwright on each database. Object backups and optional middleware are verified separately.',
  };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  try { await stopServer(); } catch { cleanupErrors.push('server_cleanup_failed'); }
  try {
    if (containerCreated) await command('docker', ['rm', '-f', '-v', containerName], { capture: true, cleanup: true });
    else {
      const owned = await command('docker', ['ps', '-aq', '--filter', `name=^/${containerName}$`, '--filter', 'label=pstack-x.test=app'], { capture: true, cleanup: true });
      if (owned) await command('docker', ['rm', '-f', '-v', owned], { capture: true, cleanup: true });
    }
  } catch { cleanupErrors.push('container_cleanup_failed'); }
  try { await releaseProductionLock?.(); } catch { cleanupErrors.push('production_lock_cleanup_failed'); }
  if (interrupted && !failure) failure = new Error('Verification interrupted');
  if (cleanupErrors.length && !failure) failure = new Error('Verification cleanup failed');
  if (capacityResult) await writeFile(path.join(output, 'capacity.json'), JSON.stringify({ ...capacityResult, status: failure ? 'failed' : capacityResult.status, cleanupErrors }, null, 2));
  await writeFile(path.join(output, 'result.json'), JSON.stringify(failure
    ? { status: 'failed', mode, production, error: mode === 'capacity' ? (capacityResult?.error ?? `capacity_${verificationStage}_failed`) : failure.message, cleanupErrors }
    : { ...result, cleanupErrors }, null, 2));
  await new Promise(resolve => log.end(resolve));
  console.log(`Evidence retained: ${output}`);
}
if (failure) throw mode === 'capacity' ? new Error(capacityResult?.error ?? `Capacity ${verificationStage} failed; inspect retained evidence`) : failure;
