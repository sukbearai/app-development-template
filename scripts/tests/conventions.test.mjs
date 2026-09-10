import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkConventions, checkSourceConventions } from "../check-conventions.mjs";
import { parseSource } from "../source-analysis.mjs";
import { discoverTests } from "../test-discovery.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("source conventions enforce public responsibilities and placement on actual source trees", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pstack-conventions-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of [
    "scripts",
    "apps/web/app",
    "apps/web/components/ui",
    "apps/web/lib/hooks",
    "packages/contracts/src",
    "packages/database/src",
    "packages/server/src",
    "packages/kafka/src",
    "packages/sdk/src",
    "services/worker/src",
  ])
    await mkdir(path.join(fixture, directory), { recursive: true });
  await copyFile(
    path.join(root, "scripts/source-scope.json"),
    path.join(fixture, "scripts/source-scope.json"),
  );
  await writeFile(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
        paths: {
          "#secret": ["./packages/server/src/modules/identity/credentials.ts"],
          "#public": ["./packages/server/src/modules/identity/service.ts"],
          "#missing": ["./missing.ts"],
          "@/secret": ["./packages/server/src/modules/identity/credentials.ts"],
        },
      },
    }),
  );
  const baseline = {
    "apps/web/app/[projectId]/page.tsx": "export default function Page() { return null; }",
    "apps/web/components/ui/button.tsx": "export function Button() { return null; }",
    "apps/web/lib/hooks/use-ready.ts": "export const useReady = () => true;",
    "packages/contracts/src/async-contracts.ts": "export type Envelope = {};",
    "packages/contracts/src/transport.ts": "export type ApiEnvelope = {};",
    "packages/database/src/row-values.ts": "export const iso = () => null;",
    "packages/database/src/retention.ts": "export const pruneHistory = () => {};",
    "packages/contracts/src/primitives.ts": "export type Id = string;",
    "packages/contracts/src/modules/identity/contracts.ts":
      'export type { Id } from "../../primitives";',
    "packages/database/src/modules/identity/repository.ts":
      'import type { Id } from "@pstack/contracts/modules/identity/contracts"; export const find = () => null;',
    "packages/database/src/modules/identity/rows.ts": "export type Row = {};",
    "packages/server/src/modules/identity/credential-reader.ts":
      'export { secret } from "./credentials";',
    "packages/server/src/modules/identity/credentials.ts":
      "export const secret = 1; export const readSecret = () => secret; export type Secret = {}; export type Setting = number;",
    "packages/server/src/modules/identity/service.ts":
      'import { secret } from "./credentials"; export function verify() { return secret; }',
    "packages/server/src/modules/identity/router.ts":
      'import { verify } from "./service"; export const router = { verify };',
    "packages/server/src/trpc-router.ts":
      'import { router } from "./modules/identity/router"; export type AppRouter = typeof router;',
    "packages/server/src/index.ts": "export {};",
    "packages/server/src/password.ts": "export const hashPassword = () => 1;",
    "packages/server/src/event-service.ts": "export const recordAudit = () => 1;",
    "packages/server/src/upload-admission.ts": "export const admit = () => 1;",
    "packages/server/src/upload-memory-limits.ts": "export const limit = 1;",
    "packages/server/src/runtime-metrics.ts": "export const metrics = 1;",
    "packages/server/src/modules/audit/service.ts":
      'import { verify } from "#public"; export const audit = () => verify();',
    "packages/kafka/src/index.ts": "export {};",
    "packages/sdk/src/index.ts": "export {};",
    "services/worker/src/index.ts": 'import { handle } from "./modules/projects/handler";',
    "services/worker/src/async-task.ts": "export type AsyncConsumerHandler = () => void;",
    "services/worker/src/async-task-store.ts":
      "export const createPostgresAsyncTaskStore = () => ({});",
    "services/worker/src/modules/projects/handler.ts":
      'import type { AsyncConsumerHandler } from "../../async-task"; export const handle: AsyncConsumerHandler = () => {};',
  };
  async function write(file, source) {
    await mkdir(path.dirname(path.join(fixture, file)), { recursive: true });
    await writeFile(path.join(fixture, file), source);
  }
  for (const [file, source] of Object.entries(baseline)) await write(file, source);
  for (const workspace of [
    "apps/web",
    "packages/contracts",
    "packages/database",
    "packages/server",
    "packages/kafka",
    "packages/sdk",
    "services/worker",
  ])
    await write(`${workspace}/package.json`, JSON.stringify({ scripts: {} }));
  const run = async () => (await checkSourceConventions(fixture)).findings;
  assert.deepEqual(await run(), []);
  const cases = [
    [
      "private exported value alias",
      "packages/server/src/modules/identity/service.ts",
      'import {secret} from "./credentials"; const alias = secret; export const value = alias;',
      "private-reexport",
    ],
    [
      "private exported namespace alias",
      "packages/server/src/modules/identity/service.ts",
      'import * as credentials from "./credentials"; export const value = credentials.secret;',
      "private-reexport",
    ],
    [
      "private exported type alias",
      "packages/server/src/modules/identity/service.ts",
      'import type {Secret} from "./credentials"; export type Public = Secret;',
      "private-reexport",
    ],
    [
      "component in lib",
      "apps/web/lib/card.tsx",
      "export function Card() { return <div />; }",
      "component-location",
    ],
    [
      "platform business barrel",
      "packages/server/src/index.ts",
      'export * from "./modules/identity/service";',
      "module-barrel",
    ],
    [
      "worker reverse scheduler",
      "services/worker/src/modules/projects/handler.ts",
      'import "../../index";',
      "worker-direction",
    ],
    [
      "worker handler must use its supplied transaction instead of constructing a store",
      "services/worker/src/modules/projects/handler.ts",
      'import { createPostgresAsyncTaskStore } from "../../async-task-store"; export const handle = () => createPostgresAsyncTaskStore();',
      "worker-direction",
    ],
    [
      "private exported import type",
      "packages/server/src/modules/identity/service.ts",
      'export type Secret = import("./credentials").Secret;',
      "private-reexport",
    ],
    [
      "private exported require",
      "packages/server/src/modules/identity/service.ts",
      'export const secret = require("./credentials");',
      "private-reexport",
    ],
    [
      "private exported dynamic import",
      "packages/server/src/modules/identity/service.ts",
      'export const secret = import("./credentials");',
      "private-reexport",
    ],
    [
      "private require then export",
      "packages/server/src/modules/identity/service.ts",
      'const {secret} = require("./credentials"); export {secret};',
      "private-reexport",
    ],
    ["root business", "packages/server/src/projects-service.ts", "export {};", "source-location"],
    [
      "unclassified infrastructure",
      "packages/server/src/new-infrastructure.ts",
      "export {};",
      "source-location",
    ],
    [
      "wrong role",
      "packages/contracts/src/modules/projects/service.ts",
      "export {};",
      "module-role",
    ],
    ["module index", "packages/server/src/modules/projects/index.ts", "export {};", "module-index"],
    [
      "bad filename",
      "packages/server/src/modules/projects/ProjectThing.ts",
      "export {};",
      "file-name",
    ],
    [
      "miscellaneous module",
      "packages/server/src/modules/helpers/service.ts",
      "export {};",
      "module-name",
    ],
    [
      "default component",
      "apps/web/components/ui/button.tsx",
      "export default () => null;",
      "named-export",
    ],
    [
      "default alias",
      "packages/server/src/modules/audit/service.ts",
      "const foo = 1; export { foo as default };",
      "named-export",
    ],
    [
      "nonreserved app default",
      "apps/web/app/widget.tsx",
      "export default () => null;",
      "named-export",
    ],
    ["root component", "apps/web/components/button.tsx", "export {};", "component-location"],
    [
      "client in components",
      "apps/web/components/projects/api-client.ts",
      "export {};",
      "client-location",
    ],
    [
      "hook in components",
      "apps/web/components/projects/use-project.ts",
      "export {};",
      "client-location",
    ],
    ["shared hook placement", "apps/web/lib/use-ready.ts", "export {};", "hook-location"],
    [
      "module env",
      "packages/server/src/modules/audit/service.ts",
      "export const setting = process.env.VALUE;",
      "module-environment",
    ],
    [
      "computed module env",
      "packages/server/src/modules/audit/service.ts",
      'export const setting = process["env"].VALUE;',
      "module-environment",
    ],
    [
      "package barrel",
      "packages/server/src/modules/audit/service.ts",
      'import "../../index";',
      "module-barrel",
    ],
    [
      "module router import",
      "packages/server/src/modules/audit/service.ts",
      'import "../identity/router";',
      "router-import",
    ],
    [
      "same-domain cross-package private",
      "packages/server/src/modules/identity/service.ts",
      'import type { Row } from "@pstack/database/modules/identity/rows";',
      "private-import",
    ],
    [
      "external worker handler",
      "packages/server/src/modules/audit/service.ts",
      'import "../../../../../services/worker/src/modules/projects/handler";',
      "handler-import",
    ],
    [
      "unresolved alias type",
      "packages/server/src/modules/audit/service.ts",
      'import type { Missing } from "#missing";',
      "unresolved-import",
    ],
    [
      "unresolved ImportType",
      "packages/server/src/modules/audit/service.ts",
      'export type Missing = import("./missing").Missing;',
      "unresolved-import",
    ],
    [
      "unscanned local",
      "packages/server/src/modules/audit/service.ts",
      'import "../../../../../outside";',
      "unscanned-import",
    ],
    [
      "private public reexport",
      "packages/server/src/modules/identity/service.ts",
      'export { secret } from "./credentials";',
      "private-reexport",
    ],
    [
      "private import then reexport",
      "packages/server/src/modules/identity/service.ts",
      'import { secret as value } from "./credentials"; export { value };',
      "private-reexport",
    ],
  ];
  await write("outside.ts", "export {};");
  for (const expression of [
    "secret satisfies number",
    "secret as number",
    "<number>secret",
    "secret!",
    "((secret as number)!) satisfies number",
  ])
    cases.push([
      `transparent private alias ${expression}`,
      "packages/server/src/modules/identity/service.ts",
      `import {secret} from "./credentials"; export const value = ${expression};`,
      "private-reexport",
    ]);
  cases.push([
    "parenthesized private typeof export",
    "packages/server/src/modules/identity/service.ts",
    'import {secret} from "./credentials"; export type Public = (typeof secret);',
    "private-reexport",
  ]);
  cases.push([
    "private typeof export",
    "packages/server/src/modules/identity/service.ts",
    'import {secret} from "./credentials"; export type Public = typeof secret;',
    "private-reexport",
  ]);
  for (const expression of [
    'require("./credentials") as object',
    'require("./credentials") satisfies object',
    'require("./credentials")!',
    '<object>require("./credentials")',
    '(await import("./credentials")) as object',
  ])
    cases.push([
      `transparent imported binding ${expression}`,
      "packages/server/src/modules/identity/service.ts",
      `export const value = ${expression};`,
      "private-reexport",
    ]);
  for (const source of [
    "const {env} = process; export const setting = env.VALUE;",
    "const {env: config} = process; export const setting = config.VALUE;",
    'import {env} from "node:process"; export const setting = env.VALUE;',
    'import {env as config} from "process"; export const setting = config.VALUE;',
    'import runtime from "node:process"; export const setting = runtime.env.VALUE;',
    'import * as runtime from "process"; export const setting = runtime["env"].VALUE;',
    "const runtime = process; const next = runtime; export const setting = next.env.VALUE;",
    'import runtime from "process"; const alias = runtime; const {env} = alias; export const setting = env.VALUE;',
    'const runtime = require("node:process"); export const setting = runtime.env.VALUE;',
    'const {env} = require("process"); export const setting = env.VALUE;',
  ])
    cases.push([
      `environment alias ${source}`,
      "packages/server/src/modules/audit/service.ts",
      source,
      "module-environment",
    ]);
  for (const statement of [
    "for (const item of [1]) { return process.env.VALUE; }",
    "for (const key in {first: 1}) { return process.env.VALUE; }",
    "for (let index = 0; index < 1; index++) { return process.env.VALUE; }",
  ])
    cases.push([
      `loop global environment ${statement}`,
      "packages/server/src/modules/audit/service.ts",
      `export function setting() { ${statement} }`,
      "module-environment",
    ]);
  for (const specifier of [
    "../identity/credentials",
    "@pstack/server/modules/identity/credentials",
    "#secret",
    "@/secret",
  ])
    for (const syntax of [
      `import { secret } from "${specifier}";`,
      `import type { Secret } from "${specifier}";`,
      `import { type Secret } from "${specifier}";`,
      `export type { Secret } from "${specifier}";`,
      `export { type Secret } from "${specifier}";`,
      `export * from "${specifier}";`,
      `import type Secret = require("${specifier}");`,
      `type Secret = import("${specifier}").Secret;`,
      `require("${specifier}");`,
      `import(\`${specifier}\`);`,
    ])
      cases.push([
        `private syntax ${syntax}`,
        "packages/server/src/modules/audit/service.ts",
        syntax,
        "private-import",
      ]);
  for (const [name, file, source, rule] of cases)
    await t.test(name, async () => {
      await write(file, source);
      assert.ok(
        (await run()).some((finding) => finding.file === file && finding.rule === rule),
        `Expected ${rule}: ${JSON.stringify(await run())}`,
      );
      if (Object.hasOwn(baseline, file)) await write(file, baseline[file]);
      else await rm(path.join(fixture, file));
    });
  await t.test(
    "complete checker delegates layout and declared empty suites to discovery",
    async () => {
      await write(
        "packages/server/package.json",
        JSON.stringify({
          scripts: {
            "test:unit": "node ../../scripts/run-tests.mjs unit",
            "test:integration": "node ../../scripts/run-tests.mjs integration web-runtime",
          },
        }),
      );
      assert.deepEqual(
        (await checkConventions(fixture))
          .filter((finding) => finding.rule === "test-empty")
          .map((finding) => finding.file),
        [
          "packages/server/tests/integration",
          "packages/server/tests/unit",
          "packages/server/tests/web-runtime",
        ],
      );
      for (const suite of ["unit", "integration", "web-runtime"])
        await write(
          `packages/server/tests/${suite}/sample.test.mjs`,
          'import test from "node:test"; test("sample", () => {});',
        );
      assert.deepEqual(await checkConventions(fixture), []);
      await write("packages/server/tests/fixtures/hidden.test.mjs", "export {};");
      assert.ok(
        (await checkConventions(fixture)).some(
          (finding) =>
            finding.file === "packages/server/tests/fixtures/hidden.test.mjs" &&
            finding.rule === "test-suite",
        ),
      );
      await rm(path.join(fixture, "packages/server/tests/fixtures/hidden.test.mjs"));
      await write(
        "services/worker/package.json",
        JSON.stringify({ scripts: { "test:integration": "node scripts/test-integration.mjs" } }),
      );
      assert.ok(
        (await checkConventions(fixture)).some(
          (finding) =>
            finding.file === "services/worker/tests/integration" && finding.rule === "test-empty",
        ),
      );
      await write("services/worker/package.json", JSON.stringify({ scripts: {} }));
    },
  );
  await t.test(
    "complete checker rejects suites without default execution and foreign web runtime",
    async () => {
      const workspace = "packages/contracts";
      const manifest = { scripts: { "test:unit": "node ../../scripts/run-tests.mjs unit" } };
      await write(`${workspace}/package.json`, JSON.stringify(manifest));
      await write(`${workspace}/tests/unit/existing.test.mjs`, "export {};");
      await write(`${workspace}/tests/integration/new.test.mjs`, "export {};");
      try {
        assert.ok(
          (await checkConventions(fixture)).some(
            (finding) =>
              finding.rule === "test-unexecuted" &&
              finding.file === `${workspace}/tests/integration`,
          ),
        );
        assert.deepEqual(await discoverTests(path.join(fixture, workspace), "unit"), [
          "tests/unit/existing.test.mjs",
        ]);
        manifest.scripts["test:integration:external"] =
          "node ../../scripts/run-tests.mjs integration";
        await write(`${workspace}/package.json`, JSON.stringify(manifest));
        assert.ok(
          (await checkConventions(fixture)).some(
            (finding) =>
              finding.rule === "test-unexecuted" &&
              finding.file === `${workspace}/tests/integration`,
          ),
        );
        manifest.scripts["test:integration"] = "node ../../scripts/run-tests.mjs integration";
        await write(`${workspace}/package.json`, JSON.stringify(manifest));
        assert.deepEqual(await checkConventions(fixture), []);
        await write(`${workspace}/tests/web-runtime/never-run.test.mjs`, "export {};");
        manifest.scripts["test:integration"] += " web-runtime";
        await write(`${workspace}/package.json`, JSON.stringify(manifest));
        assert.ok(
          (await checkConventions(fixture)).some(
            (finding) =>
              finding.rule === "test-workspace" &&
              finding.file === `${workspace}/tests/web-runtime`,
          ),
        );
      } finally {
        await rm(path.join(fixture, workspace, "tests"), { recursive: true, force: true });
        await write(`${workspace}/package.json`, JSON.stringify({ scripts: {} }));
      }
    },
  );
  await t.test("loop declarations shadow the global process only inside their loop", async (t) => {
    const file = "packages/server/src/modules/audit/service.ts";
    for (const statement of [
      "for (const process of [{env: {VALUE: 1}}]) { return process.env.VALUE; }",
      "for (const process in {first: 1}) { return process.env; }",
      "for (let process = {env: {VALUE: 1}}; process.env.VALUE; process.env.VALUE--) { return process.env.VALUE; }",
    ])
      await t.test(statement, async () => {
        try {
          await write(file, `export function setting() { ${statement} }`);
          assert.deepEqual(await run(), []);
          await write(file, `export function setting() { ${statement} return process.env.VALUE; }`);
          assert.ok((await run()).some((finding) => finding.rule === "module-environment"));
        } finally {
          await write(file, baseline[file]);
        }
      });
  });
  await t.test(
    "private implementation calls and unrelated environment-shaped objects stay legal",
    async () => {
      const file = "packages/server/src/modules/identity/service.ts";
      for (const source of [
        'import {secret} from "./credentials"; export function verify() { return secret + 1; }',
        'import {readSecret} from "./credentials"; export function verify() { return readSecret(); }',
        'import {readSecret} from "./credentials"; export const value = readSecret() satisfies number;',
        'export const setting = 42 satisfies import("./credentials").Setting;',
        'export const setting = 42 as import("./credentials").Setting;',
        'export const setting = <import("./credentials").Setting>42;',
        'import {secret} from "./credentials"; const read = () => secret; export const verify = () => read();',
        "const process = {env: {VALUE: 1}}; export const setting = process.env.VALUE;",
        "export function setting(process: {env: {VALUE: number}}) { return process.env.VALUE; }",
        "const runtime = {env: {VALUE: 1}}; export const setting = runtime.env.VALUE;",
        'import type {env} from "node:process"; export type Configuration = typeof env;',
      ]) {
        await write(file, source);
        assert.deepEqual(await run(), []);
      }
      await write(file, baseline[file]);
    },
  );
  for (const source of [
    '"use client"; import type { AppRouter } from "@pstack/server/trpc-router";',
    '"use client"; export type Router = import("@pstack/server/trpc-router").AppRouter;',
    'import "@pstack/server/password"; import "@pstack/server/event-service"; import "@pstack/server/upload-admission"; import "@pstack/server/upload-memory-limits"; import "@pstack/server/runtime-metrics";',
  ]) {
    await write("apps/web/lib/probe.ts", source);
    assert.deepEqual(await run(), []);
  }
});

test("shared parser retains type-only edges while runtime traversal excludes erased syntax", () => {
  const parsed = parseSource(
    "source.ts",
    `
    import type { A } from "a";
    import { type B } from "b";
    export { type C } from "c";
    export type * from "d";
    import type E = require("e");
    type F = import("f").F;
    import { type G, value } from "g";
    import("h", { with: { type: "json" } });
    require(\`i\`);
    const ordinary = "import('ignored')";
  `,
  );
  assert.deepEqual(
    parsed.edges.filter((edge) => edge.typeOnly).map((edge) => edge.dependency),
    ["a", "b", "c", "d", "e", "f"],
  );
  assert.deepEqual(parsed.imports, ["g", "h", "i"]);
});
