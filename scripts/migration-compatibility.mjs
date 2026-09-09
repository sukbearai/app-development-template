import assert from "node:assert/strict";
import { z } from "zod";
import { sha256 } from "./verification-evidence.mjs";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const migrationHistorySchema = z.strictObject({
  ledgerSha256: hash,
  integrity: z.string(),
});
const observedInstance = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().min(1),
  restarts: z.number().int().nonnegative(),
});
export const migrationAvailabilitySchema = z.strictObject({
  before: z.array(observedInstance).length(2),
  after: z.array(observedInstance).length(2),
  successfulWrites: z.number().int().positive(),
  failedWrites: z.literal(0),
  maxLatencyMs: z.number().nonnegative().max(2000),
  requestTimeoutMs: z.literal(2000),
});
const appliedMigration = z.strictObject({ hash, createdAt: z.number().int().positive() });
export const migrationExecutionSchema = z.strictObject({
  availability: migrationAvailabilitySchema,
  previous: migrationHistorySchema,
  candidate: migrationHistorySchema,
  before: z.array(appliedMigration).min(1),
  after: z.array(appliedMigration).min(1),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  command: z.literal("pnpm --filter @pstack/database db:migrate"),
  exitCode: z.literal(0),
});
const journalEntry = z.strictObject({
  idx: z.number().int().nonnegative(),
  version: z.literal("7"),
  when: z.number().int().positive(),
  tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
  breakpoints: z.boolean(),
});
export function migrationHistory(value) {
  const history = migrationHistorySchema.parse(value);
  assert.equal(sha256(history.integrity), history.ledgerSha256, "MIGRATION_HISTORY_HASH_MISMATCH");
  const integrity = JSON.parse(history.integrity);
  const journal = z.array(journalEntry).min(1).parse(integrity.$journal);
  for (const [index, entry] of journal.entries()) {
    assert.equal(entry.idx, index, "MIGRATION_HISTORY_ORDER_MISMATCH");
    assert.ok(
      index === 0 || entry.when > journal[index - 1].when,
      "MIGRATION_HISTORY_TIME_MISMATCH",
    );
    hash.parse(integrity[`${entry.tag}.sql`]);
  }
  return { integrity, journal };
}
export function verifyMigrationPrefix(previous, candidate) {
  const before = migrationHistory(previous);
  const after = migrationHistory(candidate);
  assert.deepEqual(
    after.journal.slice(0, before.journal.length),
    before.journal,
    "MIGRATION_HISTORY_PREFIX_MISMATCH",
  );
  for (const [file, digest] of Object.entries(before.integrity)) {
    if (file !== "$journal" && file !== "meta/_journal.json")
      assert.equal(after.integrity[file], digest, "MIGRATION_HISTORY_PREFIX_MISMATCH");
  }
  return after;
}
export function expectedApplied(history) {
  const { integrity, journal } = migrationHistory(history);
  return journal.map((entry) => ({ hash: integrity[`${entry.tag}.sql`], createdAt: entry.when }));
}
export function verifyMigrationExecution(value) {
  const execution = migrationExecutionSchema.parse(value);
  assert.deepEqual(
    execution.availability.after,
    execution.availability.before,
    "PREVIOUS_APPLICATION_RESTARTED_DURING_MIGRATION",
  );
  verifyMigrationPrefix(execution.previous, execution.candidate);
  assert.deepEqual(
    execution.before,
    expectedApplied(execution.previous),
    "MIGRATION_BEFORE_MISMATCH",
  );
  assert.deepEqual(
    execution.after,
    expectedApplied(execution.candidate),
    "MIGRATION_AFTER_MISMATCH",
  );
  return execution;
}

// Runs inside an already verified image, and checks actual SQL/metadata through checkMigrations.
export const imageMigrationHistoryCommand = [
  "pnpm",
  "--filter",
  "@pstack/database",
  "exec",
  "node",
  "--input-type=module",
  "-e",
  "const {checkMigrations,migrationFolder}=await import('./scripts/migration-check.mjs');await checkMigrations();const {readFile}=await import('node:fs/promises');process.stdout.write(JSON.stringify(await readFile(migrationFolder+'/integrity.json','utf8')));",
];
export function liveSchemaCommand(expectedLedgerSha256) {
  hash.parse(expectedLedgerSha256);
  return [
    "pnpm",
    "--filter",
    "@pstack/database",
    "exec",
    "node",
    "--input-type=module",
    "-e",
    `
    const {checkMigrations,migrationFolder}=await import('./scripts/migration-check.mjs');
    const {readFile}=await import('node:fs/promises');
    const {createHash}=await import('node:crypto');
    const {default:pg}=await import('pg');
    const digest=x=>createHash('sha256').update(x).digest('hex');
    const journal=await checkMigrations();
    if(digest(await readFile(migrationFolder+'/integrity.json'))!==${JSON.stringify(expectedLedgerSha256)})throw Error('SCHEMA_IMAGE_LEDGER_MISMATCH');
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});
    await client.connect();
    try {
      const rows=(await client.query('select hash,created_at from drizzle.drizzle_migrations order by created_at')).rows;
      const expected=[];
      for(const entry of journal.entries)expected.push({hash:digest(await readFile(migrationFolder+'/'+entry.tag+'.sql')),created_at:entry.when});
      if(rows.length && rows[0].hash!==expected[0].hash){
        const legacy=JSON.parse(await readFile(migrationFolder+'/../meta/_journal.json','utf8'));
        const prefix=[];
        for(const entry of legacy.entries)prefix.push({hash:digest(await readFile(migrationFolder+'/../'+entry.tag+'.sql')),created_at:entry.when});
        prefix.push({hash:digest(await readFile(migrationFolder+'/../legacy-upgrade/0004_safe_template.sql')),created_at:journal.entries[0].when});
        expected.splice(0,1,...prefix);
      }
      if(JSON.stringify(rows.map(r=>({hash:r.hash,created_at:Number(r.created_at)})))!==JSON.stringify(expected))throw Error('LIVE_SCHEMA_LEDGER_MISMATCH');
      process.stdout.write('SCHEMA_LEDGER_VERIFIED');
    } finally {await client.end();}
  `,
  ];
}
