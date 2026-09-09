import { getPool, closeDatabase } from "../src/client";
import { assertDatabaseSchema } from "../src/schema-check";
try {
  await assertDatabaseSchema(getPool());
  const result = await getPool().query("select count(*) from drizzle.drizzle_migrations");
  if (!Number(result.rows[0].count)) throw new Error("Migration ledger is empty");
  process.stdout.write("Database schema and migration ledger verified without writes\n");
} finally {
  await closeDatabase();
}
