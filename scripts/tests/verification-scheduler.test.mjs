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

test("scheduler barriers isolate tools and unit tests, enforce Web/database locks and cap runtime work", async () => {
  for (const concurrency of [1, 2, 4]) {
    const active = new Set();
    const completed = new Set();
    const maxima = [0, 0, 0, 0];
    const result = await scheduleVerification(
      RELEASE_GATES,
      async (gate) => {
        const scheduling = gateScheduling(gate);
        for (const earlier of RELEASE_GATES.filter(
          (item) => gateScheduling(item).phase < scheduling.phase,
        ))
          assert.ok(completed.has(earlier), `${gate} started before ${earlier} completed`);
        for (const dependency of scheduling.dependencies) assert.ok(completed.has(dependency));
        for (const running of active) {
          assert.ok(!scheduling.exclusive && !gateScheduling(running).exclusive);
          for (const resource of scheduling.resources)
            assert.ok(!gateScheduling(running).resources.includes(resource));
        }
        active.add(gate);
        maxima[scheduling.phase] = Math.max(maxima[scheduling.phase], active.size);
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
      RELEASE_GATES,
    );
    assert.deepEqual(maxima, [concurrency, 1, 1, Math.min(concurrency, 2)]);
  }
});

test("failure stops dispatch and awaits in-flight cleanup, including thrown commands", async () => {
  const cleanup = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const pending = scheduleVerification(
    ["build", "test:integration", "test:ui", "test:backup"],
    async (gate) => {
      calls.push(gate);
      if (gate === "build") {
        await started.promise;
        throw new Error("spawn failed");
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
  assert.deepEqual(
    result.map((item) => item.status),
    ["failed", "passed", "not-run", "not-run"],
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
