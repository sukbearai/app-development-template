import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

export async function verifyWebShutdown({ launch, env, output }) {
  const checks = [];
  const base = env.APP_ORIGIN;
  const address = new URL(base);
  const control = new Client({ connectionString: env.DATABASE_URL });
  const lock = new Client({ connectionString: env.DATABASE_URL });
  await control.connect();
  await lock.connect();
  async function waitForLock(table) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`insert into "${table}"%`]);
      if (result.rows[0].n > 0) return;
      await delay(50);
    }
    throw new Error(`Web never reached the blocked ${table} insert`);
  }
  async function incompleteBody() {
    const client = net.connect(Number(address.port), address.hostname);
    client.on('error', () => {});
    let response = '';
    client.on('data', bytes => { response += bytes; });
    const closed = new Promise(resolve => client.once('close', resolve));
    await once(client, 'connect');
    const body = '{"account":""}';
    client.write(`POST /api/auth/login HTTP/1.1\r\nHost: ${address.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body.slice(0, 5)}`);
    await delay(250);
    return { client, body, closed, response: () => response };
  }
  function exitResult(server) {
    return new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })));
  }
  async function stopWhileBlocked(server) {
    const exited = exitResult(server);
    server.kill('SIGTERM');
    await delay(150);
    assert.equal(server.exitCode, null, 'Web exited while admitted work was still blocked');
    assert.equal(server.signalCode, null);
    return { exited };
  }
  try {
    let server = await launch();
    const request = await incompleteBody();
    const { exited } = await stopWhileBlocked(server);
    server.kill('SIGINT');
    const admission = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(500) }).then(response => response.status, () => 'closed');
    assert.ok(admission === 'closed' || admission === 503, `New admission during drain: ${admission}`);
    request.client.write(request.body.slice(5) + `GET /api/hello HTTP/1.1\r\nHost: ${address.host}\r\nConnection: close\r\n\r\n`);
    assert.deepEqual(await exited, { code: 0, signal: null });
    await request.closed;
    assert.match(request.response(), /HTTP\/1.1 400/);
    assert.doesNotMatch(request.response(), /Hello from vinext/);
    assert.match(request.response(), /HTTP\/1.1 503/);
    checks.push('slow request body completes; repeated signals do not cut drain short; new connections and pipelined requests are rejected');

    server = await launch();
    const trace = `shutdown_${randomUUID()}`;
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE app_telemetry_events IN ACCESS EXCLUSIVE MODE');
    const recorded = fetch(`${base}/api/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': trace }, body: JSON.stringify({ event: 'shutdown.proof' }), signal: AbortSignal.timeout(10000) });
    await waitForLock('app_telemetry_events');
    const telemetryStop = await stopWhileBlocked(server);
    await lock.query('COMMIT');
    const telemetryResponse = await recorded;
    assert.equal(telemetryResponse.status, 201);
    await telemetryResponse.text();
    assert.deepEqual(await telemetryStop.exited, { code: 0, signal: null });
    assert.equal((await control.query('SELECT count(*)::int AS n FROM app_telemetry_events WHERE trace_id=$1', [trace])).rows[0].n, 1);
    assert.equal((await control.query('SELECT count(*)::int AS n FROM app_outbox_events WHERE trace_id=$1', [trace])).rows[0].n, 1);
    checks.push('SIGTERM waits for the actual PostgreSQL transaction and returns the complete 201 response');

    server = await launch();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: env.UI_FLOW_ADMIN_ACCOUNT, password: env.UI_FLOW_ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).data.token;
    const filename = `shutdown-${randomUUID()}.txt`;
    const bytes = 'upload committed after client disconnect';
    const form = new FormData();
    form.set('file', new File([bytes], filename, { type: 'text/plain' }));
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE app_file_assets IN ACCESS EXCLUSIVE MODE');
    const abort = new AbortController();
    const uploaded = fetch(`${base}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: abort.signal }).then(response => response.status, () => 'disconnected');
    await waitForLock('app_file_assets');
    abort.abort();
    assert.equal(await uploaded, 'disconnected');
    await delay(100);
    const uploadStop = await stopWhileBlocked(server);
    await lock.query('COMMIT');
    assert.deepEqual(await uploadStop.exited, { code: 0, signal: null });
    const files = await control.query('SELECT id, storage_key FROM app_file_assets WHERE file_name=$1', [filename]);
    assert.equal(files.rows.length, 1);
    const file = files.rows[0];
    assert.equal(await readFile(path.join(env.UPLOAD_STORAGE_DIR, file.storage_key), 'utf8'), bytes);
    assert.equal((await control.query("SELECT state FROM app_upload_intents WHERE storage_key=$1", [file.storage_key])).rows[0].state, 'committed');
    assert.equal((await control.query("SELECT count(*)::int AS n FROM app_outbox_events WHERE payload->>'fileId'=$1", [file.id])).rows[0].n, 1);
    checks.push('client disconnect cannot release the upload business work; local bytes, file row, committed intent and outbox survive SIGTERM');

    server = await launch({ WEB_SHUTDOWN_TIMEOUT_MS: '1200' });
    const hung = await incompleteBody();
    const hungExit = exitResult(server);
    const started = Date.now();
    server.kill('SIGTERM');
    await delay(800);
    server.kill('SIGTERM');
    assert.deepEqual(await hungExit, { code: 1, signal: null });
    assert.ok(Date.now() - started >= 1100 && Date.now() - started < 1900, 'Repeated signal must not extend the single deadline');
    await hung.closed;
    checks.push('hung request exits 1 within the configured absolute deadline; repeated SIGTERM does not reset it');
    server = await launch();
    const idleExit = exitResult(server);
    server.kill('SIGINT');
    assert.deepEqual(await idleExit, { code: 0, signal: null });
    checks.push('SIGINT initiates a clean idle shutdown');
    await writeFile(path.join(output, 'web-shutdown.json'), JSON.stringify({ status: 'passed', checks }, null, 2) + '\n');
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    await lock.end();
    await control.end();
  }
}
