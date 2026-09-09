import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const migrationFolder = fileURLToPath(new URL("../migrations/template/", import.meta.url));
export function assertMigrationSafety(journal, sqlFiles, sqlByFile) {
  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    !journal.entries.length
  )
    throw new Error("Invalid migration journal");
  const expected = [];
  let lastTime = 0;
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index];
    if (
      entry.idx !== index ||
      entry.version !== "7" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Journal validation checks the literal breakpoint flag at the file boundary.
      typeof entry.breakpoints !== "boolean" ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= lastTime ||
      !new RegExp(`^${String(index).padStart(4, "0")}_[-a-zA-Z0-9_]+$`).test(entry.tag)
    )
      throw new Error(`Invalid migration journal entry ${index}`);
    lastTime = entry.when;
    expected.push(`${entry.tag}.sql`);
  }
  if (JSON.stringify([...sqlFiles].sort()) !== JSON.stringify(expected.sort()))
    throw new Error("Migration SQL files and journal must match exactly");
  for (const file of sqlFiles) {
    const sql = sqlByFile[file].replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    if (/\bDROP\s+(?:TABLE|COLUMN)\b|\bTRUNCATE\b/i.test(sql))
      throw new Error(
        `Destructive DDL requires an explicit migration plan and reviewed gate change: ${file}`,
      );
    if (/\bIF\s+NOT\s+EXISTS\b/i.test(sql))
      throw new Error(`Fallback DDL is not approved: ${file}`);
  }
}
export async function checkMigrations({ update = false } = {}) {
  const journal = JSON.parse(
    await readFile(path.join(migrationFolder, "meta/_journal.json"), "utf8"),
  );
  const files = [
    ...(await readdir(migrationFolder)).filter((file) => file.endsWith(".sql")),
    ...(await readdir(path.join(migrationFolder, "meta")))
      .filter((file) => file.endsWith(".json"))
      .map((file) => `meta/${file}`),
  ].sort();
  const sqlFiles = files.filter((file) => file.endsWith(".sql"));
  const sqlByFile = Object.fromEntries(
    await Promise.all(
      sqlFiles.map(async (file) => [
        file,
        await readFile(path.join(migrationFolder, file), "utf8"),
      ]),
    ),
  );
  assertMigrationSafety(journal, sqlFiles, sqlByFile);
  for (const entry of journal.entries) {
    const snapshot = JSON.parse(
      await readFile(
        path.join(migrationFolder, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`),
        "utf8",
      ),
    );
    if (snapshot.version !== journal.version || snapshot.dialect !== journal.dialect)
      throw new Error(`Snapshot metadata differs for ${entry.tag}`);
  }
  const actual = {};
  for (const file of files)
    actual[file] = createHash("sha256")
      .update(await readFile(path.join(migrationFolder, file)))
      .digest("hex");
  const manifestPath = path.join(migrationFolder, "integrity.json");
  let previous = {};
  try {
    previous = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (!update || error.code !== "ENOENT") throw error;
  }
  const priorJournal = previous.$journal || [];
  if (
    JSON.stringify(journal.entries.slice(0, priorJournal.length)) !== JSON.stringify(priorJournal)
  )
    throw new Error("Immutable migration journal entries changed");
  for (const [file, hash] of Object.entries(previous)) {
    if (file === "$journal") continue;
    if (file === "meta/_journal.json" && update) continue;
    if (actual[file] !== hash) throw new Error(`Immutable migration changed: ${file}`);
  }
  for (const entry of journal.entries)
    if (!actual[`${entry.tag}.sql`]) throw new Error(`Missing migration ${entry.tag}`);
  actual.$journal = journal.entries;
  if (update) await writeFile(manifestPath, `${JSON.stringify(actual, null, 2)}\n`);
  else if (
    JSON.stringify(
      Object.keys(previous)
        .filter((key) => key !== "$journal")
        .sort(),
    ) !== JSON.stringify(files)
  )
    throw new Error("Migration integrity manifest is incomplete");
  const historical = path.resolve(migrationFolder, "..");
  const original = JSON.parse(
    await readFile(path.join(historical, "migration-integrity.json"), "utf8"),
  );
  for (const [file, expected] of Object.entries({
    ...original.migrations,
    ...Object.fromEntries(
      Object.entries(original.snapshots).map(([name, hash]) => [`meta/${name}`, hash]),
    ),
  })) {
    if (
      createHash("sha256")
        .update(await readFile(path.join(historical, file)))
        .digest("hex") !== expected
    )
      throw new Error(`Historical migration changed: ${file}`);
  }
  const upgrade = JSON.parse(
    await readFile(path.join(historical, "legacy-upgrade/integrity.json"), "utf8"),
  );
  for (const [file, expected] of Object.entries(upgrade))
    if (
      createHash("sha256")
        .update(await readFile(path.join(historical, "legacy-upgrade", file)))
        .digest("hex") !== expected
    )
      throw new Error(`Legacy upgrade changed: ${file}`);
  return journal;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkMigrations({ update: process.argv.includes("--update") });
  process.stdout.write("Migration SQL and metadata integrity verified\n");
}
