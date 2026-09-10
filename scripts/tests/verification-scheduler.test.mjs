import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm, access, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduleVerification, withVerificationLock } from "../verification-scheduler.mjs";
import {
  gateCommand,
  gateScheduling,
  TEMPLATE_GATES,
  CORE_GATES,
  FULL_GATES,
  RELEASE_GATES,
} from "../verification-plan.mjs";
import { parseArguments, verificationPlan, failVerificationEvidence } from "../pr-verify.mjs";

const passed = { status: "passed" };

test("template keeps historical coverage and PR profiles retain their build and E2E gates", () => {
  assert.deepEqual(TEMPLATE_GATES, [
    "format:check",
    "sdk:check",
    "lint",
    "duplication:check",
    "boundary:check",
    "conventions:check",
    "dependency:check",
    "supply-chain:check",
    "security:audit",
    "typecheck",
    "contract:check",
    "migration:check",
    "version:check",
    "docs:check",
    "test:tools",
    "test:unit",
    "test:integration",
    "test:ui:production",
    "test:ui",
    "test:app-backup",
    "test:async-recovery",
    "test:kafka-security",
    "storybook:test",
    "storybook:smoke",
    "test:tracing-collector",
    "test:monitor-collector",
    "test:deployment",
    "test:deployment:slots",
  ]);
  assert.deepEqual(verificationPlan([], { full: true }), [...CORE_GATES, ...FULL_GATES]);
  assert.deepEqual(verificationPlan([], { release: true }), [...RELEASE_GATES]);
  assert.deepEqual(gateCommand("sdk:check"), {
    command: process.execPath,
    args: ["scripts/generate-sdk.mjs", "--check"],
  });
  assert.equal(parseArguments([]).concurrency, 2);
  assert.equal(parseArguments(["--concurrency", "1"]).concurrency, 1);
  for (const value of ["0", "5", "2.5", "-1", "Infinity", "1e0", "", "--full"])
    assert.throws(() => parseArguments(["--concurrency", value]));
  assert.throws(() => parseArguments(["--template", "--full"]));
});

const phases = [
  [
    "format:check",
    "sdk:check",
    "lint",
    "duplication:check",
    "boundary:check",
    "conventions:check",
    "dependency:check",
    "supply-chain:check",
    "security:audit",
    "typecheck",
    "contract:check",
    "migration:check",
    "version:check",
    "docs:check",
  ],
  ["test:tools"],
  ["test:unit"],
  [
    "test:integration",
    "build",
    "storybook:test",
    "storybook:smoke",
    "test:tracing-collector",
    "test:monitor-collector",
    "test:deployment",
    "test:deployment:slots",
    "db:integration",
    "test:e2e",
    "test:ui",
    "test:ui:production",
    "test:async-recovery",
    "test:kafka-security",
    "test:capacity",
    "test:backup",
    "test:app-backup",
    "test:containers",
  ],
];
const webGates = new Set([
  "build",
  "test:e2e",
  "test:ui",
  "test:ui:production",
  "test:capacity",
  "storybook:test",
  "storybook:smoke",
]);
const databaseGates = new Set(["test:integration", "db:integration"]);

test("scheduler barriers and resource locks hold even when plan order changes", async () => {
  for (const concurrency of [1, 2, 4]) {
    for (const plan of [RELEASE_GATES, [...RELEASE_GATES].reverse()]) {
      const active = new Set();
      const completed = new Set();
      const maxima = [0, 0, 0, 0];
      const result = await scheduleVerification(
        plan,
        async (gate) => {
          const phase = phases.findIndex((gates) => gates.includes(gate));
          assert.notEqual(phase, -1, `Missing test expectations for ${gate}`);
          for (const earlier of phases.slice(0, phase).flat())
            assert.ok(completed.has(earlier), `${gate} started before ${earlier} completed`);
          if (gate === "sdk:check") assert.ok(completed.has("contract:check"));
          for (const running of active) {
            assert.notEqual(gate, "test:capacity");
            assert.notEqual(running, "test:capacity");
            for (const group of [webGates, databaseGates])
              assert.ok(!group.has(gate) || !group.has(running), `${gate} overlaps ${running}`);
          }
          active.add(gate);
          maxima[phase] = Math.max(maxima[phase], active.size);
          await setImmediate();
          active.delete(gate);
          completed.add(gate);
          return passed;
        },
        { concurrency },
      );
      assert.ok(
        result.every((item) => item.status === "passed"),
        JSON.stringify(result),
      );
      assert.deepEqual(
        result.map((item) => item.gate),
        plan,
      );
      assert.deepEqual(maxima, [concurrency, 1, 1, Math.min(concurrency, 2)]);
    }
  }
});

test("each Web and database gate waits for the resource held by its peer", async () => {
  for (const group of [webGates, databaseGates]) {
    for (const gate of group) {
      const peer = [...group].find((other) => other !== gate);
      const active = new Set();
      const result = await scheduleVerification([gate, peer], async (name) => {
        assert.equal(active.size, 0, `${name} overlaps ${[...active]}`);
        active.add(name);
        await setImmediate();
        active.delete(name);
        return passed;
      });
      assert.deepEqual(
        result.map((item) => item.status),
        ["passed", "passed"],
      );
    }
  }
});

test("capacity runs alone even beside gates with no Web or database resource", async () => {
  for (const plan of [
    ["test:capacity", "test:backup"],
    ["test:backup", "test:capacity"],
  ]) {
    let active = 0;
    const result = await scheduleVerification(
      plan,
      async () => {
        assert.equal(active, 0);
        active++;
        await setImmediate();
        active--;
        return passed;
      },
      { concurrency: 4 },
    );
    assert.deepEqual(
      result.map((item) => item.status),
      ["passed", "passed"],
    );
  }
});

for (const browserGate of ["test:ui", "test:ui:production", "storybook:test", "storybook:smoke"]) {
  test(`${browserGate} runs without peer runtime gates changing the host network`, async () => {
    for (const peer of phases[3].filter((gate) => gate !== browserGate)) {
      for (const plan of [
        [browserGate, peer],
        [peer, browserGate],
      ]) {
        for (const concurrency of [1, 2, 4]) {
          const active = new Set();
          const overlaps = [];
          const result = await scheduleVerification(
            plan,
            async (gate) => {
              for (const running of active) overlaps.push(`${gate} overlaps ${running}`);
              active.add(gate);
              await setImmediate();
              active.delete(gate);
              return passed;
            },
            { concurrency },
          );
          assert.deepEqual(
            result.map((item) => item.status),
            ["passed", "passed"],
          );
          assert.deepEqual(overlaps, [], `${plan.join(", ")} at concurrency ${concurrency}`);
        }
      }
    }
  });
}

test("runtime priority starts recovery and integration before other available work", async () => {
  const calls = [];
  const plan = ["build", "test:backup", "test:integration", "test:async-recovery"];
  await scheduleVerification(plan, async (gate) => {
    calls.push(gate);
    await setImmediate();
    return passed;
  });
  assert.deepEqual(calls, ["test:async-recovery", "test:integration", "build", "test:backup"]);
});

test("every profile has immutable scheduling metadata and includes its dependencies", async () => {
  for (const plan of [CORE_GATES, [...CORE_GATES, ...FULL_GATES], RELEASE_GATES, TEMPLATE_GATES]) {
    for (const gate of plan) {
      const scheduling = gateScheduling(gate);
      assert.ok(Object.isFrozen(scheduling));
      assert.ok(Object.isFrozen(scheduling.resources));
      assert.ok(Object.isFrozen(scheduling.dependencies));
      for (const dependency of scheduling.dependencies) assert.ok(plan.includes(dependency));
    }
    const result = await scheduleVerification(plan, async () => passed);
    assert.ok(result.every((item) => item.status === "passed"));
  }
});

test("invalid plans fail before dispatching any command", async () => {
  for (const [plan, error] of [
    [null, /array/],
    ["lint", /array/],
    [["lint", "unknown:gate"], /Unknown verification gate/],
    [["lint", "toString"], /Unknown verification gate/],
    [["lint", null], /Unknown verification gate/],
    [["lint", "lint"], /Duplicate verification gate/],
    [["lint", "sdk:check"], /sdk:check requires contract:check/],
  ]) {
    const calls = [];
    await assert.rejects(
      scheduleVerification(plan, async (gate) => {
        calls.push(gate);
        return passed;
      }),
      error,
    );
    assert.deepEqual(calls, []);
  }
  assert.throws(() => gateScheduling("unknown:gate"), /Unknown verification gate/);
});

test("failure stops dispatch and awaits in-flight cleanup, including thrown commands", async () => {
  const cleanup = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const spawnError = new Error("spawn failed");
  const pending = scheduleVerification(
    ["build", "test:integration", "test:ui", "test:backup"],
    async (gate) => {
      calls.push(gate);
      if (gate === "build") {
        await started.promise;
        throw spawnError;
      }
      started.resolve();
      await cleanup.promise;
      return passed;
    },
  );
  await started.promise;
  await setImmediate();
  assert.deepEqual(new Set(calls), new Set(["build", "test:integration"]));
  cleanup.resolve();
  const result = await pending;
  assert.equal(result[0].error, spawnError);
  assert.deepEqual(
    result.map((item) => item.status),
    ["failed", "passed", "not-run", "not-run"],
  );
});

test("source check failure preserves command evidence and blocks SDK and later phases", async () => {
  const failure = { status: "failed", exitCode: 7, stderr: "contract source is stale" };
  const calls = [];
  const result = await scheduleVerification(
    ["sdk:check", "contract:check", "test:tools", "test:unit", "build"],
    async (gate) => {
      calls.push(gate);
      return failure;
    },
  );
  assert.deepEqual(calls, ["contract:check"]);
  assert.deepEqual(result[1], { ...failure, gate: "contract:check" });
  assert.deepEqual(
    result.map((item) => item.status),
    ["not-run", "failed", "not-run", "not-run", "not-run"],
  );
});

test("interruption cancels all active commands and waits for their cleanup before returning", async () => {
  const interruption = new AbortController();
  const started = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  let count = 0;
  let cleaned = 0;
  const pending = scheduleVerification(
    ["build", "test:integration", "test:ui"],
    async (_gate, signal) => {
      const aborted = new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      if (++count === 2) started.resolve();
      await aborted;
      await cleanup.promise;
      cleaned++;
      return passed;
    },
    { signal: interruption.signal },
  );
  await started.promise;
  interruption.abort();
  await setImmediate();
  assert.equal(cleaned, 0);
  cleanup.resolve();
  const result = await pending;
  assert.equal(cleaned, 2);
  assert.deepEqual(
    result.map((item) => item.status),
    ["failed", "failed", "not-run"],
  );
});

test("checkout lock rejects a competing owner and releases only its own lock on failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    withVerificationLock(root, async () => {
      await assert.rejects(
        withVerificationLock(root, async () => passed),
        /already exists/,
      );
      await access(path.join(root, ".verification/verify.lock/owner.json"));
      throw new Error("failed gate");
    }),
    /failed gate/,
  );
  await withVerificationLock(root, async () => passed);
});

test("cancellation drains backup finally blocks without sending them a signal or dispatching more work", async () => {
  for (const gate of ["test:backup", "test:app-backup"]) {
    const interruption = new AbortController();
    const started = Promise.withResolvers();
    const cleanup = Promise.withResolvers();
    let cleaned = false;
    const calls = [];
    const pending = scheduleVerification(
      [gate, "test:ui"],
      async (name, signal) => {
        calls.push(name);
        assert.equal(signal, undefined);
        try {
          started.resolve();
          await cleanup.promise;
          return passed;
        } finally {
          cleaned = true;
        }
      },
      { signal: interruption.signal, concurrency: 1 },
    );
    await started.promise;
    interruption.abort();
    await setImmediate();
    assert.equal(cleaned, false);
    cleanup.resolve();
    const result = await pending;
    assert.equal(cleaned, true);
    assert.deepEqual(calls, [gate]);
    assert.deepEqual(
      result.map((item) => item.status),
      ["failed", "not-run"],
    );
  }
});

test("lock release failure invalidates the actual evidence index and matching summary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-release-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = "artifacts/verification/index.json";
  const summary = "artifacts/pr-verify/summary.json";
  await mkdir(path.dirname(path.join(root, evidence)), { recursive: true });
  await mkdir(path.dirname(path.join(root, summary)), { recursive: true });
  await assert.rejects(
    withVerificationLock(
      root,
      async () => {
        await writeFile(path.join(root, evidence), JSON.stringify({ status: "passed" }));
        await writeFile(
          path.join(root, summary),
          JSON.stringify({ runId: "current", passed: true }),
        );
        return { runId: "current", evidence, status: "passed" };
      },
      {
        release: async (lock) => {
          await access(path.join(lock, "owner.json"));
          throw new Error("release failed");
        },
        onCleanupError: (result) => failVerificationEvidence(root, result),
      },
    ),
    /release failed/,
  );
  assert.equal(JSON.parse(await readFile(path.join(root, evidence), "utf8")).status, "failed");
  assert.equal(JSON.parse(await readFile(path.join(root, summary), "utf8")).passed, false);
});

test("lock cleanup preserves execution and evidence errors in order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-dual-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executionError = new Error("gate failed");
  const releaseError = new Error("lock release failed");
  const evidenceError = new Error("evidence write failed");
  for (const executionFails of [true, false]) {
    await assert.rejects(
      withVerificationLock(
        root,
        async () => {
          if (executionFails) throw executionError;
          return passed;
        },
        {
          release: async (lock) => {
            await rm(lock, { recursive: true });
            throw releaseError;
          },
          onCleanupError: async () => {
            throw evidenceError;
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors,
          executionFails ? [executionError, releaseError] : [releaseError, evidenceError],
        );
        return true;
      },
    );
  }
});
