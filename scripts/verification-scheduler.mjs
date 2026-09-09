import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { gateScheduling } from "./verification-plan.mjs";

export function validateConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4)
    throw new Error("--concurrency must be an integer between 1 and 4");
  return value;
}

export async function scheduleVerification(plan, execute, { concurrency = 2, signal } = {}) {
  validateConcurrency(concurrency);
  const results = new Map(plan.map((gate) => [gate, { gate, status: "not-run" }]));
  let failed = false;
  for (const phase of [0, 1, 2, 3]) {
    const pending = plan.filter((gate) => gateScheduling(gate).phase === phase);
    if (phase === 3) {
      const priority = (gate) =>
        gate === "test:async-recovery" ? 0 : gate === "test:integration" ? 1 : 2;
      pending.sort((a, b) => priority(a) - priority(b));
    }
    const active = new Map();
    const resources = new Set();
    const limit =
      phase === 1 || phase === 2 ? 1 : phase === 3 ? Math.min(2, concurrency) : concurrency;
    while (pending.length || active.size) {
      while (!failed && !signal?.aborted && active.size < limit) {
        const next = pending.findIndex((gate) => {
          const scheduling = gateScheduling(gate);
          if (active.has("test:capacity") || (scheduling.exclusive && active.size)) return false;
          return (
            scheduling.resources.every((resource) => !resources.has(resource)) &&
            scheduling.dependencies.every(
              (dependency) => results.get(dependency)?.status === "passed",
            )
          );
        });
        if (next === -1) break;
        const [gate] = pending.splice(next, 1);
        const claimed = gateScheduling(gate).resources;
        for (const resource of claimed) resources.add(resource);
        const task = Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return execute(gate, gateScheduling(gate).drainOnCancel ? undefined : signal);
          })
          .then((result) => ({
            ...result,
            gate,
            status: signal?.aborted ? "failed" : result.status,
          }))
          .catch((error) => ({ gate, status: "failed", error }))
          .then((result) => {
            results.set(gate, result);
            if (result.status !== "passed") failed = true;
            for (const resource of claimed) resources.delete(resource);
            active.delete(gate);
          });
        active.set(gate, task);
      }
      if (active.size) await Promise.race(active.values());
      else break;
    }
    if (failed || signal?.aborted || pending.length) break;
  }
  return plan.map((gate) => results.get(gate));
}

export async function withVerificationLock(
  root,
  execute,
  {
    release = (lock) => rm(lock, { recursive: true, force: true }),
    onCleanupError = async () => {},
  } = {},
) {
  const directory = path.join(root, ".verification");
  const lock = path.join(directory, "verify.lock");
  await mkdir(directory, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Verification lock already exists: ${lock}`);
    throw error;
  }
  let result;
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      { flag: "wx" },
    );
    result = await execute();
    return result;
  } finally {
    try {
      await release(lock);
    } catch (error) {
      if (result) await onCleanupError(result);
      throw error;
    }
  }
}
