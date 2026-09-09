import assert from "node:assert/strict";

export async function stopVerificationServer({
  child,
  closed,
  production,
  record,
  timeoutMs = 10_000,
}) {
  let forced = false;
  let killError;
  let requestedSignal = null;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
      requestedSignal = "SIGTERM";
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const timer = setTimeout(() => {
    forced = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") killError = error;
    }
  }, timeoutMs);
  try {
    const { code, signal } = await closed;
    record({ pid: child.pid, code, signal, forced, requestedSignal });
    if (killError) throw killError;
    assert.equal(forced, false, "Web server required forced termination");
    // Vite exits with 128 + SIGTERM after closing its development server.
    const stoppedDevelopment =
      !production &&
      requestedSignal === "SIGTERM" &&
      (signal === "SIGTERM" || (code === 143 && signal === null));
    assert.ok(code === 0 || stoppedDevelopment, `Web server shutdown failed (${code ?? signal})`);
  } finally {
    clearTimeout(timer);
  }
}
