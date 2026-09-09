import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("package boundaries cover runtime syntax, aliases and every production layer", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), "pstack-boundaries-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of [
    "scripts",
    "apps/web/app",
    "apps/web/components",
    "apps/web/lib",
    "packages/contracts/src",
    "packages/database/src",
    "packages/server/src",
    "packages/kafka/src",
    "packages/sdk/src",
    "services/worker/src",
  ])
    await mkdir(path.join(fixture, directory), { recursive: true });
  for (const filename of ["check-boundaries.mjs", "source-scope.mjs", "source-scope.json"])
    await copyFile(path.join(root, "scripts", filename), path.join(fixture, "scripts", filename));
  await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
  await writeFile(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
        paths: {
          "#worker": ["./services/worker/src/index.ts"],
          "#server": ["./packages/server/src/index.ts"],
          "#sdk": ["./packages/sdk/src/index.ts"],
          "@/sensitive": ["./packages/server/src/index.ts"],
          "#missing": ["./missing.ts"],
          "#postgres": ["./node_modules/pg/lib/index.js"],
          "#react": [path.join(root, "apps/web/node_modules/react/index.js")],
        },
      },
    }),
  );
  const baseline = {
    "apps/web/app/page.tsx": "export default function Page() { return null; }",
    "apps/web/lib/helper.ts": "export {};",
    "apps/web/sensitive.ts": "export {};",
    "packages/contracts/src/index.ts": "export {};",
    "packages/database/src/index.ts": "export {};",
    "packages/server/src/index.ts": "export {};",
    "packages/server/src/trpc-router.ts":
      "export type AppRouter = {}; export const appRouter = {};",
    "packages/kafka/src/index.ts": "export {};",
    "packages/sdk/src/index.ts": 'export * from "@pstack/contracts";',
    "services/worker/src/index.ts": "export {};",
  };
  for (const [file, source] of Object.entries(baseline))
    await writeFile(path.join(fixture, file), source);
  const run = () =>
    execFileSync(process.execPath, [path.join(fixture, "scripts/check-boundaries.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run(), /boundaries verified/);
  for (const directory of [
    "packages/new/src",
    "services/new/src",
    "apps/new/app",
    "apps/web/src",
  ]) {
    await mkdir(path.join(fixture, directory), { recursive: true });
    assert.throws(run, /Unclassified production root:/);
    await rm(
      path.join(fixture, directory === "apps/web/src" ? directory : path.dirname(directory)),
      { recursive: true },
    );
  }
  const cases = [
    [
      "contracts builtin",
      "packages/contracts/src/index.ts",
      'import "fs";',
      /contracts imports Node/,
    ],
    ["SDK builtin", "packages/sdk/src/index.ts", 'import "node:fs";', /sdk imports Node/],
    [
      "contracts relative",
      "packages/contracts/src/index.ts",
      'import "../../kafka/src/index.js";',
      /contracts imports/,
    ],
    [
      "SDK resolved PostgreSQL alias",
      "packages/sdk/src/index.ts",
      'import "#postgres";',
      /sdk imports Node/,
    ],
    [
      "browser resolved PostgreSQL alias",
      "apps/web/components/probe.tsx",
      '"use client"; import "#postgres";',
      /browser imports Node/,
    ],
    [
      "worker resolved framework alias",
      "services/worker/src/index.ts",
      'import "#react";',
      /worker imports Web/,
    ],
    [
      "SDK runtime server",
      "packages/sdk/src/index.ts",
      'export * from "@pstack/server";',
      /sdk imports/,
    ],
    [
      "database worker alias",
      "packages/database/src/index.ts",
      'import "#worker";',
      /database imports/,
    ],
    [
      "kafka server relative",
      "packages/kafka/src/index.ts",
      'import "../../server/src/index";',
      /kafka imports/,
    ],
    [
      "server Web relative",
      "packages/server/src/index.ts",
      'import "../../../apps/web/app/page";',
      /server imports/,
    ],
    [
      "server worker relative",
      "packages/server/src/index.ts",
      'import "../../../services/worker/src/index";',
      /server imports/,
    ],
    ["server worker alias", "packages/server/src/index.ts", 'import "#worker";', /server imports/],
    [
      "worker Web",
      "services/worker/src/index.ts",
      'import "../../../apps/web/lib/helper";',
      /worker imports/,
    ],
    ["worker SDK", "services/worker/src/index.ts", 'import "@pstack/sdk";', /worker imports/],
    ["worker framework", "services/worker/src/index.ts", 'import "react";', /worker imports Web/],
    [
      "worker browser directive",
      "services/worker/src/index.ts",
      '"use client";',
      /worker cannot be a browser/,
    ],
    [
      "browser value",
      "apps/web/components/probe.tsx",
      '"use client"; import { appRouter } from "@pstack/server/trpc-router";',
      /browser imports/,
    ],
    [
      "browser relative emitted extension",
      "apps/web/components/probe.tsx",
      '"use client"; import "../../../packages/server/src/index.js";',
      /browser imports/,
    ],
    [
      "browser alias",
      "apps/web/components/probe.tsx",
      '"use client"; import "#server";',
      /browser imports/,
    ],
    [
      "browser overridden Web alias",
      "apps/web/components/probe.tsx",
      '"use client"; import "@/sensitive";',
      /browser imports/,
    ],
    [
      "browser unresolved configured alias",
      "apps/web/components/probe.tsx",
      '"use client"; import "#missing";',
      /unresolved local/,
    ],
    [
      "browser require",
      "apps/web/components/probe.cjs",
      '"use client"; require("node:fs");',
      /browser imports Node/,
    ],
    [
      "browser import equals",
      "apps/web/components/probe.cts",
      '"use client"; import server = require("@pstack/server");',
      /browser imports/,
    ],
    [
      "browser dynamic template",
      "apps/web/components/probe.mjs",
      '"use client"; import(`node:fs`);',
      /browser imports Node/,
    ],
    [
      "browser dynamic options",
      "apps/web/components/probe.mts",
      '"use client"; import("@pstack/server", { with: { type: "json" } });',
      /browser imports/,
    ],
    [
      "browser re-export",
      "apps/web/components/probe.jsx",
      '"use client"; export * from "@pstack/kafka";',
      /browser imports/,
    ],
    [
      "browser unresolved relative",
      "apps/web/components/probe.js",
      '"use client"; import "../lib/missing";',
      /unresolved local/,
    ],
  ];
  for (const [name, file, source, diagnostic] of cases)
    await t.test(name, async () => {
      await writeFile(path.join(fixture, file), source);
      assert.throws(run, diagnostic);
      if (file in baseline) await writeFile(path.join(fixture, file), baseline[file]);
      else await rm(path.join(fixture, file));
    });
  const client = path.join(fixture, "apps/web/components/client.tsx");
  for (const source of [
    '"use client"; import type { AppRouter } from "@pstack/server/trpc-router";',
    '"use client"; import { type AppRouter } from "@pstack/server/trpc-router";',
    '"use client"; export type { AppRouter } from "@pstack/server/trpc-router";',
    '"use client"; export { type AppRouter } from "@pstack/server/trpc-router";',
    '"use client"; import "@pstack/sdk";',
    '"use client"; import "#sdk";',
  ]) {
    await writeFile(client, source);
    assert.match(run(), /boundaries verified/);
  }
  await writeFile(path.join(fixture, "packages/sdk/src/index.ts"), 'export * from "./nested.js";');
  await writeFile(path.join(fixture, "packages/sdk/src/nested.ts"), 'export * from "node:fs";');
  assert.throws(run, /browser imports Node/);
  await rm(path.join(fixture, "packages/sdk/src/nested.ts"));
  await writeFile(
    path.join(fixture, "packages/sdk/src/index.ts"),
    baseline["packages/sdk/src/index.ts"],
  );
  await writeFile(client, '"use client"; import "@/lib/helper";');
  await writeFile(
    path.join(fixture, "apps/web/lib/helper.ts"),
    'export * from "@pstack/database";',
  );
  assert.throws(run, /browser imports/);
  await writeFile(path.join(fixture, "apps/web/lib/helper.ts"), baseline["apps/web/lib/helper.ts"]);
  await writeFile(
    path.join(fixture, "services/worker/src/index.ts"),
    'import "node:fs"; import "@pstack/contracts"; import "@pstack/database"; import "@pstack/kafka"; import "@pstack/server";',
  );
  assert.match(run(), /boundaries verified/);
});
