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
  if (!Array.isArray(plan)) throw new Error("Verification plan must be an array of gate names");
  const gates = new Set();
  for (const gate of plan) {
    gateScheduling(gate);
    if (gates.has(gate)) throw new Error(`Duplicate verification gate: ${gate}`);
    gates.add(gate);
  }
  for (const gate of plan)
    for (const dependency of gateScheduling(gate).dependencies)
      if (!gates.has(dependency))
        throw new Error(`Verification gate ${gate} requires ${dependency}`);
  const results = new Map(plan.map((gate) => [gate, { gate, status: "not-run" }]));
  let failed = false;
  for (const phase of [0, 1, 2, 3]) {
    const pending = plan
      .filter((gate) => gateScheduling(gate).phase === phase)
      .sort((a, b) => gateScheduling(a).priority - gateScheduling(b).priority);
    const active = new Map();
    const resources = new Set();
    const limit =
      phase === 1 || phase === 2 ? 1 : phase === 3 ? Math.min(2, concurrency) : concurrency;
    while (pending.length || active.size) {
      while (!failed && !signal?.aborted && active.size < limit) {
        const exclusiveActive = [...active.keys()].some((gate) => gateScheduling(gate).exclusive);
        const next = pending.findIndex((gate) => {
          const scheduling = gateScheduling(gate);
          if (exclusiveActive || (scheduling.exclusive && active.size)) return false;
          return (
            scheduling.resources.every((resource) => !resources.has(resource)) &&
            scheduling.dependencies.every(
              (dependency) => results.get(dependency)?.status === "passed",
            )
          );
        });
        if (next === -1) break;
        const [gate] = pending.splice(next, 1);
        const scheduling = gateScheduling(gate);
        for (const resource of scheduling.resources) resources.add(resource);
        const task = Promise.resolve()
          .then(() => {
            signal?.throwIfAborted();
            return execute(gate, scheduling.drainOnCancel ? undefined : signal);
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
            for (const resource of scheduling.resources) resources.delete(resource);
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
  const failures = [];
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      { flag: "wx" },
    );
    result = await execute();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await release(lock);
    } catch (error) {
      failures.push(error);
      if (result) {
        try {
          await onCleanupError(result);
        } catch (evidenceError) {
          failures.push(evidenceError);
        }
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Verification and cleanup failed");
  return result;
}
