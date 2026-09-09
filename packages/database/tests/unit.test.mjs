import test from "node:test";
import assert from "node:assert/strict";
import { checkMigrations, assertMigrationSafety } from "../scripts/migration-check.mjs";
import { assertDatabaseSchema } from "../src/schema-check.ts";
test("generated migration history and snapshots are immutable", async () => {
  assert.ok((await checkMigrations()).entries.length > 0);
});
test("schema inspection rejects missing production tables", async () => {
  await assert.rejects(
    assertDatabaseSchema({ query: async () => ({ rows: [] }) }),
    /schema is missing/,
  );
});

test("migration safety rejects destructive or untracked SQL and invalid journals", () => {
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
  };
  const files = ["0000_initial.sql"];
  assert.doesNotThrow(() =>
    assertMigrationSafety(journal, files, {
      "0000_initial.sql": "create table safe(id text);",
    }),
  );
  for (const sql of [
    "drop table users;",
    "alter table users drop column account;",
    "truncate users;",
    "create table if not exists users(id text);",
  ])
    assert.throws(() => assertMigrationSafety(journal, files, { "0000_initial.sql": sql }));
  assert.throws(() => assertMigrationSafety(journal, [...files, "0001_untracked.sql"], {}));
  assert.throws(() =>
    assertMigrationSafety(
      { ...journal, entries: [...journal.entries, ...journal.entries] },
      files,
      {},
    ),
  );
  assert.throws(() =>
    assertMigrationSafety({ ...journal, entries: [{ ...journal.entries[0], idx: 1 }] }, files, {}),
  );
});
