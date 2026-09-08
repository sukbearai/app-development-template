import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createHeartbeatWriter(
  destination = process.env.WORKER_HEARTBEAT_PATH ??
    join(
      tmpdir(),
      `pstack-worker-heartbeat-${process.pid}-${randomUUID()}.json`,
    ),
) {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let pending = Promise.resolve();
  let phase: "active" | "stopping" | "terminal" = "active";
  function write(state: "starting" | "running" | "stopping" | "stopped" | "failed", lastProgressAt: number) {
    if (phase === "terminal") return pending;
    if (phase === "stopping" && (state === "starting" || state === "running")) return pending;
    if (state === "stopping") phase = "stopping";
    if (state === "stopped" || state === "failed") phase = "terminal";
    const next = pending
      .catch(() => undefined)
      .then(async () => {
        try {
          await writeFile(
            temporary,
            JSON.stringify({
              pid: process.pid,
              state,
              lastProgressAt,
              checkedAt: Date.now(),
            }),
            { mode: 0o600 },
          );
          await rename(temporary, destination);
        } catch (error) {
          try { await rm(temporary, { force: true }); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Heartbeat write and cleanup failed"); }
          throw error;
        }
      });
    pending = next;
    return next;
  }
  return { write, flush: () => pending, destination };
}

export async function inspectWorkerHeartbeat(
  destination = process.env.WORKER_HEARTBEAT_PATH,
) {
  if (!destination)
    throw new Error(
      "WORKER_HEARTBEAT_PATH is required to inspect a worker instance",
    );
  const record = JSON.parse(await readFile(destination, "utf8"));
  if (record.state === "running") process.kill(record.pid, 0);
  const ageMs = Date.now() - record.checkedAt;
  const progressAgeMs = Date.now() - record.lastProgressAt;
  const status =
    record.state === "running" && ageMs < 15000 && progressAgeMs < 120000
      ? "ok"
      : "degraded";
  return {
    status,
    service: "worker",
    pid: record.pid,
    ageMs,
    progressAgeMs,
    state: record.state,
  };
}
