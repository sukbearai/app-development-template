import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { finished } from "node:stream/promises";

const exits = { passed: 0, failed: 1, invalid: 2, inconclusive: 3, interrupted: 130 };
export function commandExitCode(status) {
  if (!Object.hasOwn(exits, status)) throw new Error("Invalid command status");
  return exits[status];
}
export function commandResult({
  command,
  runId = randomUUID(),
  status,
  errorCode = null,
  evidence = null,
  data = null,
}) {
  commandExitCode(status);
  return { schemaVersion: 1, command, runId, status, errorCode, evidence, data };
}
export function printCommandResult(result, json) {
  process.stdout.write(
    json
      ? `${JSON.stringify(result)}\n`
      : `${result.command}: ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}${result.evidence ? `\nEvidence: ${result.evidence}` : ""}\n`,
  );
  process.exitCode = commandExitCode(result.status);
}
export async function runLogged({
  command,
  args,
  cwd,
  logFile,
  signal,
  env = process.env,
  stopGraceMs = 45000,
}) {
  if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 1)
    throw new Error("Invalid process stop grace");
  signal?.throwIfAborted();
  const handle = await open(logFile, "wx", 0o600);
  const log = handle.createWriteStream();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure;
  let forceStop;
  const closed = new Promise((resolve) =>
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal })),
  );
  const forward = (bytes) => {
    log.write(bytes);
    process.stderr.write(bytes);
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") failure = error;
    }
    forceStop ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    }, stopGraceMs);
  };
  child.once("error", (error) => {
    failure = error;
  });
  log.once("error", (error) => {
    failure = error;
    stop();
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const result = await closed;
    if (failure) throw failure;
    return { ...result, interrupted: Boolean(signal?.aborted) };
  } finally {
    clearTimeout(forceStop);
    signal?.removeEventListener("abort", stop);
    log.end();
    await finished(log);
  }
}
