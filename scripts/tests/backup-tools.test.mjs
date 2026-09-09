import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { restoreArchive } from "../db-backup.mjs";

test(
  "Docker PostgreSQL tools retain supplementary groups for group-readable TLS keys",
  { skip: !process.getgroups },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "backup-tool-groups-"));
    const capture = path.join(directory, "arguments.json");
    const previous = { ...process.env };
    try {
      await writeFile(
        path.join(directory, "docker"),
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.BACKUP_TOOL_ARGUMENTS, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${directory}${path.delimiter}${process.env.PATH}`;
      process.env.POSTGRES_TOOLS = "docker";
      process.env.BACKUP_TOOL_ARGUMENTS = capture;
      t.mock.method(process, "getuid", () => 4241);
      t.mock.method(process, "getgid", () => 4241);
      t.mock.method(process, "getgroups", () => [4241, 4242, 4242, 4243]);
      await restoreArchive(
        path.join(directory, "archive.dump"),
        "",
        "postgres://app@localhost/backup?sslkey=client.key",
      );
      const args = JSON.parse(await readFile(capture, "utf8"));
      assert.equal(args[args.indexOf("--user") + 1], "4241:4241");
      const groups = args.flatMap((arg, index) => (arg === "--group-add" ? [args[index + 1]] : []));
      assert.deepEqual(groups, ["4241", "4242", "4243"]);
    } finally {
      process.env = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
