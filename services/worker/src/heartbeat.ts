import { readFile, rename, writeFile } from "node:fs/promises";
const heartbeatPath = () =>
  process.env.WORKER_HEARTBEAT_PATH ?? "/tmp/pstack-worker-heartbeat.json";
export async function writeHeartbeat(
  state: "running" | "stopped",
  lastProgressAt: number,
) {
  const destination = heartbeatPath();
  const temporary = `${destination}.${process.pid}.tmp`;
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
}
export async function inspectWorkerHeartbeat() {
  const record = JSON.parse(await readFile(heartbeatPath(), "utf8"));
  process.kill(record.pid, 0);
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
