import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getPool, closeDatabase, withTransaction } from '../src/client.ts';
import { getFileAssetPage, revokeSession, revokeUserSessions, runRetention } from '../src/repository.ts';
import { assertDatabaseSchema } from '../src/schema-check.ts';
import { filePageQuerySchema } from '@pstack/contracts';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
test('file pages and opt-in session retention on owned PostgreSQL', { timeout: 120000 }, async (suite) => {
  const name = `pstack-data-${randomUUID()}`;
  docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=isolated-test-only', '-e', 'POSTGRES_DB=data_test', '-p', '127.0.0.1::5432', 'postgres:17-bullseye');
  process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${docker('port', name, '5432/tcp').split(':').at(-1)}/data_test`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await getPool().query('select 1'); break; }
      catch (error) { if (attempt >= 40) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    execFileSync('pnpm', ['--filter', '@pstack/database', 'db:migrate'], { env: process.env, stdio: 'pipe' });
    await suite.test('live index checks distinguish direction, null ordering and retention expression', async () => {
      const indexes = [
        { name: 'app_file_assets_page_idx', table: 'app_file_assets', correct: 'uploaded_at DESC NULLS LAST,id DESC NULLS LAST', wrong: ['uploaded_at ASC NULLS LAST,id DESC NULLS LAST', 'uploaded_at DESC NULLS FIRST,id DESC NULLS LAST'] },
        { name: 'app_user_sessions_retention_idx', table: 'app_user_sessions', correct: 'least(expires_at,revoked_at),id', wrong: ['greatest(expires_at,revoked_at),id'] },
      ];
      for (const index of indexes) {
        for (const columns of index.wrong) {
          await getPool().query(`drop index ${index.name}; create index ${index.name} on ${index.table} (${columns})`);
          try { await assert.rejects(assertDatabaseSchema(getPool()), new RegExp(`index ${index.name}`)); }
          finally { await getPool().query(`drop index ${index.name}; create index ${index.name} on ${index.table} (${index.correct})`); }
          await assertDatabaseSchema(getPool());
        }
      }
      execFileSync('pnpm', ['--filter', '@pstack/database', 'db:migrate'], { env: process.env, stdio: 'pipe' });
    });
    await suite.test('237 files traverse tied microsecond timestamps without omissions after newer insert', async () => {
      await getPool().query(`insert into app_file_assets(id,file_name,mime_type,size_bytes,storage_key,uploaded_at)
        select 'file_'||lpad(n::text,3,'0'),'file-'||n,'text/plain',1,'key-'||n,
          '2026-01-01'::timestamptz + (n%3)*interval '1 microsecond' from generate_series(1,237) n`);
      const planClient = await getPool().connect();
      try {
        await planClient.query('begin');
        await planClient.query('set local enable_seqscan=off; set local enable_bitmapscan=off');
        const plan = await planClient.query(`explain (format json) select id from app_file_assets
          where (uploaded_at,id) < ('2026-01-01T00:00:00.000001Z','file_001')
          order by uploaded_at desc nulls last,id desc nulls last limit 101`);
        assert.match(JSON.stringify(plan.rows), /app_file_assets_page_idx/);
        assert.doesNotMatch(JSON.stringify(plan.rows), /"Node Type":"Sort"/);
        const sessionPlan = await planClient.query(`explain (format json) select id from app_user_sessions
          where least(expires_at,revoked_at) < '2025-01-01' and least(expires_at,revoked_at) < now()
          order by least(expires_at,revoked_at),id limit 100 for update skip locked`);
        assert.match(JSON.stringify(sessionPlan.rows), /app_user_sessions_retention_idx/);
        assert.doesNotMatch(JSON.stringify(sessionPlan.rows), /"Node Type":"Sort"/);
      } finally { await planClient.query('rollback'); planClient.release(); }
      const expected = (await getPool().query('select id from app_file_assets order by uploaded_at desc,id desc')).rows.map(row => row.id);
      const first = await getFileAssetPage(filePageQuerySchema.parse({}));
      assert.equal(first.items.length, 100);
      assert.match(first.nextCursor.uploadedAt, /\.000001Z$/);
      await getPool().query("insert into app_file_assets(id,file_name,mime_type,size_bytes,storage_key,uploaded_at) values('new','new-file','text/plain',1,'new-key','2026-01-02')");
      const second = await getFileAssetPage(filePageQuerySchema.parse({ cursor: JSON.stringify(first.nextCursor) }));
      const third = await getFileAssetPage(filePageQuerySchema.parse({ cursor: JSON.stringify(second.nextCursor) }));
      assert.equal(second.items.length, 100);
      assert.equal(third.items.length, 37);
      assert.equal(third.nextCursor, null);
      assert.deepEqual([...first.items, ...second.items, ...third.items].map(file => file.id), expected);
      assert.equal((await getFileAssetPage(filePageQuerySchema.parse({ limit: '1' }))).items[0].id, 'new');
    });
    await getPool().query("insert into app_users(id,account,display_name,password_hash) values('user','user','User','unused')");
    const options = { before: new Date('2025-01-01'), sessionBefore: new Date('2025-01-01'), batchSize: 2, dryRun: true };
    const seed = async () => {
      await getPool().query('delete from app_user_sessions');
      await getPool().query(`insert into app_user_sessions(id,user_id,secret_hash,expires_at,revoked_at) values
        ('expired','user','unused','2020-01-01',null),
        ('revoked','user','unused',now()+interval '1 day','2020-02-01'),
        ('both','user','unused','2020-03-01',now()),
        ('recent-expiry','user','unused',now()-interval '1 minute',null),
        ('recent-revoke','user','unused',now()+interval '1 day',now()-interval '1 minute'),
        ('active','user','unused',now()+interval '1 day',null)`);
    };
    await suite.test('default output unchanged, dry run, bounded deletion and idempotence', async () => {
      await seed();
      const { sessionBefore, ...legacy } = options;
      assert.ok(sessionBefore);
      assert.equal('sessions' in await runRetention({ ...legacy, dryRun: false }), false);
      assert.equal((await runRetention(options)).sessions, 2);
      assert.equal((await getPool().query('select count(*) from app_user_sessions')).rows[0].count, '6');
      assert.equal((await runRetention({ ...options, dryRun: false })).sessions, 2);
      assert.equal((await runRetention({ ...options, dryRun: false })).sessions, 1);
      assert.equal((await runRetention({ ...options, dryRun: false })).sessions, 0);
      assert.deepEqual((await getPool().query('select id from app_user_sessions order by id')).rows.map(row => row.id), ['active', 'recent-expiry', 'recent-revoke']);
    });
    await suite.test('revocation preserves first invalidation and excludes expired sessions at transaction time', async () => {
      await seed();
      await withTransaction(async tx => {
        await revokeSession('revoked', tx);
        await revokeUserSessions('user', tx);
      });
      const sessions = (await getPool().query('select id,revoked_at from app_user_sessions')).rows;
      assert.equal(sessions.find(row => row.id === 'revoked').revoked_at.toISOString(), '2020-02-01T00:00:00.000Z');
      assert.equal(sessions.find(row => row.id === 'expired').revoked_at, null);
      assert.equal(sessions.find(row => row.id === 'recent-expiry').revoked_at, null);
      const first = sessions.find(row => row.id === 'active').revoked_at.toISOString();
      await withTransaction(tx => revokeUserSessions('user', tx));
      assert.equal((await getPool().query("select revoked_at from app_user_sessions where id='active'")).rows[0].revoked_at.toISOString(), first);
      await getPool().query("insert into app_user_sessions(id,user_id,secret_hash,expires_at) values('boundary','user','unused',now()+interval '1 day')");
      const { sql } = await import('drizzle-orm');
      await withTransaction(async tx => {
        await tx.execute(sql`update app_user_sessions set expires_at=now() where id='boundary'`);
        await revokeSession('boundary', tx);
      });
      assert.equal((await getPool().query("select revoked_at from app_user_sessions where id='boundary'")).rows[0].revoked_at, null);
    });
    await suite.test('concurrent prune skips locked eligible rows and never exceeds one session batch', async () => {
      await seed();
      const lock = await getPool().connect();
      try {
        await lock.query('begin');
        await lock.query("select id from app_user_sessions where id='expired' for update");
        const counts = await Promise.all([runRetention({ ...options, dryRun: false }), runRetention({ ...options, dryRun: false })]);
        assert.equal(counts.reduce((sum, result) => sum + result.sessions, 0), 2);
        assert.ok(counts.every(result => result.sessions <= 2));
        assert.equal((await getPool().query("select count(*) from app_user_sessions where id='expired'")).rows[0].count, '1');
      } finally { await lock.query('rollback'); lock.release(); }
      assert.equal((await runRetention({ ...options, dryRun: false })).sessions, 1);
    });
    await suite.test('session delete failure rolls back preceding history deletion', async () => {
      await seed();
      await getPool().query("insert into app_telemetry_events(id,event,trace_id,occurred_at) values('rollback-probe','test','test','2020-01-01')");
      await getPool().query(`create function reject_session_delete() returns trigger language plpgsql as $$ begin raise exception 'retention rollback probe'; end $$;
        create trigger reject_session_delete before delete on app_user_sessions for each row execute function reject_session_delete()`);
      try {
        await assert.rejects(runRetention({ ...options, dryRun: false }));
        assert.equal((await getPool().query("select count(*) from app_telemetry_events where id='rollback-probe'")).rows[0].count, '1');
        assert.equal((await getPool().query('select count(*) from app_user_sessions')).rows[0].count, '6');
      } finally { await getPool().query('drop trigger reject_session_delete on app_user_sessions; drop function reject_session_delete()'); }
    });
    await suite.test('runtime rejects unsafe retention options', async () => {
      for (const invalid of [0, 1001, 1.5, NaN]) await assert.rejects(runRetention({ ...options, batchSize: invalid }));
      for (const invalid of [new Date(NaN), new Date(Date.now() + 86400000), null]) await assert.rejects(runRetention({ ...options, sessionBefore: invalid }));
      for (const invalid of [undefined, 'false', null]) await assert.rejects(runRetention({ ...options, dryRun: invalid }));
    });
  } finally { await closeDatabase(); docker('rm', '-f', '-v', name); }
});
