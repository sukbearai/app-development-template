import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanupRehearsal,
  rehearsalCommand,
  rehearsalDiagnostic,
  rehearsalOptions,
  verifyRehearsalPair,
} from "../published-deployment-support.mjs";
import { trustedFetch } from "../published-deployment-target.mjs";

const args = [
  "--repo",
  "owner/project",
  "--previous",
  "v0.1.1",
  "--candidate",
  "v0.1.2",
  "--output",
  "artifacts/rehearsal",
];
test(
  "Linux child subreaper joins detached descendants before returning",
  { skip: process.platform !== "linux" },
  () => {
    execFileSync(
      "python3",
      [fileURLToPath(new URL("./rehearsal-process.test.py", import.meta.url))],
      { timeout: 15000 },
    );
  },
);
test("published rehearsal rejects ambiguous or executable release input", () => {
  assert.equal(rehearsalOptions(args).candidate, "v0.1.2");
  for (const invalid of [
    [...args, "--skip-signatures"],
    args.slice(0, -2),
    args.map((value) => (value === "v0.1.2" ? "v0.1.1" : value)),
    args.map((value) => (value === "v0.1.2" ? "v0.1.2;echo unsafe" : value)),
    args.map((value) => (value === "owner/project" ? "../project" : value)),
  ])
    assert.throws(() => rehearsalOptions(invalid));
});

test("a changed migration ledger fails before deployment or rollback proof loading", async () => {
  const bundle = (sha, ledger) => ({
    release: { source: { gitSha: sha }, compatibility: { migrationLedgerSha256: ledger } },
  });
  await assert.rejects(
    verifyRehearsalPair(bundle("old", "one"), bundle("new", "two")),
    /equal migration ledgers/,
  );
  await assert.rejects(
    verifyRehearsalPair(bundle("same", "one"), bundle("same", "one")),
    /successor source revision/,
  );
});

test("cleanup scopes every inventory and still removes other owned resources after a failure", async () => {
  const project = "pstack-published-0123456789abcdef";
  const inventories = new Map([
    ["ps", ["owned-container"]],
    ["volume", ["owned-volume"]],
    ["network", ["owned-network"]],
  ]);
  const deleted = [];
  const errors = await cleanupRehearsal(project, async (command, options) => {
    assert.equal(options.cleanup, true);
    if (command.includes("--filter")) {
      assert.equal(command.at(-1), `label=com.docker.compose.project=${project}`);
      return inventories.get(command[0]).join("\n");
    }
    assert.ok(!command.includes("foreign-resource"));
    if (command[0] === "rm") throw new Error("container removal failed");
    deleted.push(command.at(-1));
    inventories.set(command[0], []);
    return "";
  });
  assert.deepEqual(deleted, ["owned-volume", "owned-network"]);
  assert.deepEqual(errors, [
    "Failed to remove owned containers",
    "Owned resource cleanup did not reach a stable empty inventory",
  ]);
  await assert.rejects(
    cleanupRehearsal("shared-production", async () => assert.fail()),
    /pstack-published/,
  );
});

test("command cancellation stops owned processes and allows cleanup commands", async () => {
  const controller = new AbortController();
  const command = rehearsalCommand(controller.signal);
  const running = command(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  controller.abort();
  await assert.rejects(running, /REHEARSAL_COMMAND_FAILED/);
  await assert.rejects(command(process.execPath, ["-e", "process.exit(0)"]));
  assert.equal(
    await command(process.execPath, ["-e", "process.stdout.write('cleaned')"], { cleanup: true }),
    "cleaned",
  );
});

test(
  "Linux command timeout joins a detached grandchild before cleanup",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pstack-timeout-proof-"));
    const marker = path.join(directory, "escaped");
    try {
      const late = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),700)`;
      const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(late)}],{detached:true});setInterval(()=>{},1000)`;
      const command = rehearsalCommand(new AbortController().signal);
      await assert.rejects(
        command(process.execPath, ["-e", parent], { timeout: 200 }),
        /REHEARSAL_COMMAND_FAILED/,
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("diagnostics keep the failure and redact generated, environment and URL credentials before truncation", async () => {
  const secret = "private-rehearsal-value";
  const message = `connection refused\n${secret}\npostgres://operator:database-secret@localhost/app\nTOKEN=hidden\n-----BEGIN PRIVATE KEY-----\nkey-material\n-----END PRIVATE KEY-----`;
  const safe = rehearsalDiagnostic(message, [secret]);
  assert.match(safe, /connection refused/);
  for (const value of [secret, "database-secret", "hidden", "key-material"])
    assert.ok(!safe.includes(value));
  assert.equal(rehearsalDiagnostic("x".repeat(5000)).length, 4096);
  const command = rehearsalCommand(new AbortController().signal, [secret]);
  await assert.rejects(
    command(process.execPath, [
      "-e",
      `process.stderr.write('connection refused ${secret}');process.exit(1)`,
    ]),
    (error) => error.message.includes("connection refused") && !error.message.includes(secret),
  );
});

test("HTTPS transport accepts the explicit CA and rejects an unrelated CA", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pstack-rehearsal-tls-"));
  let server;
  try {
    for (const name of ["trusted", "unrelated"])
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          path.join(directory, `${name}.key`),
          "-out",
          path.join(directory, `${name}.crt`),
        ],
        { stdio: "ignore" },
      );
    const ca = await readFile(path.join(directory, "trusted.crt"));
    server = https.createServer(
      { key: await readFile(path.join(directory, "trusted.key")), cert: ca },
      (request, response) => {
        if (request.url === "/empty") {
          response.writeHead(204);
          response.end();
          return;
        }
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          response.setHeader("content-type", "text/plain");
          response.end(Buffer.concat(chunks));
        });
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${server.address().port}`;
    const response = await trustedFetch(ca)(url, {
      method: "POST",
      body: "persisted",
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(await response.text(), "persisted");
    const empty = await trustedFetch(ca)(`${url}/empty`, { signal: AbortSignal.timeout(3000) });
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "");
    const wrong = trustedFetch(await readFile(path.join(directory, "unrelated.crt")));
    await assert.rejects(
      wrong(url, { signal: AbortSignal.timeout(3000) }),
      /self.signed|certificate|issuer/i,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed CLI diagnostics retain only deployment operation fields", async () => {
  const operation = {
    phase: "failed",
    resumePhase: "checking",
    errorCode: "DEPLOYMENT_FAILED",
    restored: false,
  };
  const envelope = {
    errorCode: "DEPLOYMENT_FAILED",
    data: {
      state: {
        operation: { ...operation, desired: { root: "private-path" }, password: "secret-value" },
      },
      Config: { Env: ["SECRET=secret-value"] },
    },
  };
  const command = rehearsalCommand(new AbortController().signal);
  await assert.rejects(
    command(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});process.exit(1)`,
    ]),
    (error) => {
      assert.deepEqual(error.operation, operation);
      assert.ok(!JSON.stringify(error).includes("secret-value"));
      assert.ok(!JSON.stringify(error).includes("private-path"));
      return true;
    },
  );
});

test("failure snapshots report configuration drift without container environment or health output", async () => {
  const { rehearsalFailureSnapshot } = await import("../published-deployment-checks.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "pstack-failure-snapshot-"));
  try {
    const snapshot = await rehearsalFailureSnapshot(
      { stateDirectory: directory },
      {
        inspectContainers: async () => [
          {
            Id: "a".repeat(64),
            Image: "image-id",
            Config: {
              Image: "image-ref",
              Env: ["SECRET=secret-value"],
              Labels: {
                "com.docker.compose.service": "web",
                "com.docker.compose.config-hash": "b".repeat(64),
              },
            },
            State: {
              Status: "running",
              Running: true,
              ExitCode: 0,
              Health: { Status: "unhealthy", Log: [{ Output: "secret-value" }] },
            },
          },
        ],
        command: async () => `web ${"c".repeat(64)}`,
      },
      [{ images: { web: { id: "image-id", reference: "image-ref" } } }],
    );
    assert.equal(snapshot.containers[0].health, "unhealthy");
    assert.equal(snapshot.containers[0].expectedConfigHash, "c".repeat(64));
    assert.ok(snapshot.observationErrors.includes("COMPOSE_CONFIGURATION_DRIFT:web"));
    assert.ok(!JSON.stringify(snapshot).includes("secret-value"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "generated rehearsal target matches live Compose hashes and still rejects changed environment",
  { skip: process.env.PSTACK_REHEARSAL_COMPOSE_TEST !== "1", timeout: 180000 },
  async () => {
    const { realpath, writeFile } = await import("node:fs/promises");
    const { randomBytes } = await import("node:crypto");
    const { createRehearsalTarget } = await import("../published-deployment-target.mjs");
    const { composeTarget } = await import("../deployment-compose.mjs");
    const { toolchain } = await import("../toolchain.mjs");
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "pstack-rehearsal-compose-")),
    );
    const project = `pstack-published-${randomBytes(8).toString("hex")}`;
    const secrets = [];
    const command = rehearsalCommand(new AbortController().signal, secrets);
    const docker = (args, options) => command("docker", ["--context", "default", ...args], options);
    try {
      const reference = toolchain.images.node;
      await docker(["pull", reference]);
      const [image] = JSON.parse(await docker(["image", "inspect", reference]));
      const setup = await createRehearsalTarget(
        directory,
        project,
        "owner/project",
        `${image.Os}/${image.Architecture}`,
        docker,
        command,
        secrets,
      );
      const release = {
        images: Object.fromEntries(
          ["web", "worker"].map((role) => [role, { id: image.Id, reference }]),
        ),
      };
      const runtime = composeTarget(setup.target, (args, env) => command("docker", args, { env }));
      const original = await readFile(setup.target.composeFiles[0], "utf8");
      const broken = JSON.parse(original);
      for (const role of ["web", "worker"]) {
        delete broken.services[role].environment;
        broken.services[role].env_file = [setup.target.envFile];
      }
      await writeFile(setup.target.composeFiles[0], JSON.stringify(broken));
      await runtime.apply(release);
      await assert.rejects(runtime.observe([release]), /COMPOSE_CONFIGURATION_DRIFT/);
      await writeFile(setup.target.composeFiles[0], original);
      await runtime.apply(release);
      assert.equal((await runtime.observe([release])).length, 2);
      const environment = await readFile(setup.target.envFile, "utf8");
      await writeFile(
        setup.target.envFile,
        environment.replace("APP_NAME=Published release rehearsal", "APP_NAME=Changed rehearsal"),
      );
      await assert.rejects(runtime.observe([release]), /COMPOSE_CONFIGURATION_DRIFT/);
    } finally {
      assert.deepEqual(await cleanupRehearsal(project, docker), []);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
