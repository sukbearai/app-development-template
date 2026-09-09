import { registerProcessCleanup } from "./process-lifecycle";
import { loadEnvironment } from "./environment";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createPgDrizzleClient(pool: Pool) {
  return drizzle(pool, { schema });
}
export type DrizzleClient = ReturnType<typeof createPgDrizzleClient>;
export type TransactionContext = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];
export type DatabaseContext = DrizzleClient | TransactionContext;
loadEnvironment();
let pool: Pool | undefined;
let database: DrizzleClient | undefined;
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      statement_timeout: 15000,
      max: 10,
    });
    registerProcessCleanup(closeDatabase);
    pool.on("error", () =>
      process.stderr.write('{"level":"error","message":"database idle connection failed"}\n'),
    );
  }
  return pool;
}
export function databasePoolSnapshot() {
  return {
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
    max: pool?.options.max ?? 10,
  };
}
export function getDatabase() {
  database ??= createPgDrizzleClient(getPool());
  return database;
}
export function withTransaction<T>(operation: (tx: TransactionContext) => Promise<T>): Promise<T> {
  return getDatabase().transaction(operation);
}
export async function closeDatabase() {
  const current = pool;
  pool = undefined;
  database = undefined;
  await current?.end();
}
