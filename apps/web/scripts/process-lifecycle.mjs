import { writeSync } from "node:fs";

export function createWebLifecycle() {
  let draining = false;
  let drainPromise;
  const active = new Set();
  const cleanup = new Set();
  async function drainResources() {
    while (active.size) await Promise.allSettled([...active]);
    const results = await Promise.allSettled(
      [...cleanup].map((dispose) => Promise.resolve().then(dispose)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Web resource cleanup failed",
      );
  }
  return {
    get draining() {
      return draining;
    },
    beginDrain() {
      draining = true;
    },
    async trackWork(operation) {
      if (draining) throw new Error("Web is draining");
      const pending = Promise.resolve().then(operation);
      active.add(pending);
      try {
        return await pending;
      } finally {
        active.delete(pending);
      }
    },
    registerCleanup(dispose) {
      cleanup.add(dispose);
    },
    drain() {
      draining = true;
      drainPromise ??= drainResources();
      return drainPromise;
    },
  };
}

function log(level, message, failureCount) {
  writeSync(process.stderr.fd, JSON.stringify({ level, message, failureCount }) + "\n");
}

function gateRequests(server, lifecycle) {
  const listeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (lifecycle.draining) {
      response.writeHead(503, { Connection: "close", "Retry-After": "1" });
      response.end("Service unavailable");
      return;
    }
    for (const listener of listeners) listener.call(server, request, response);
  });
}

export async function runWebProcess({ lifecycle, timeoutMs, start }) {
  const stopped = Promise.withResolvers();
  const failures = [];
  let server;
  let closing;
  let deadline;
  function closeServer() {
    closing ??= new Promise((resolve) => {
      server.close((error) => {
        if (error) failures.push(error);
        resolve();
      });
    }).catch((error) => {
      failures.push(error);
    });
  }
  function requestStop() {
    if (deadline) return;
    lifecycle.beginDrain();
    deadline = setTimeout(() => {
      try {
        log("error", "Web shutdown deadline exceeded");
      } finally {
        process.exit(1);
      }
    }, timeoutMs);
    stopped.resolve();
    if (server) closeServer();
    try {
      log("info", "Web shutdown started");
    } catch (error) {
      failures.push(error);
    }
  }
  function fail(error) {
    failures.push(error);
    requestStop();
  }
  const signals = ["SIGTERM", "SIGINT"];
  for (const signal of signals) process.on(signal, requestStop);
  const startup = (async () => {
    try {
      server = await start();
      gateRequests(server, lifecycle);
      server.on("error", fail);
      if (lifecycle.draining) closeServer();
    } catch (error) {
      fail(error);
    }
  })();
  await stopped.promise;
  await startup;
  await closing;
  try {
    await lifecycle.drain();
  } catch (error) {
    failures.push(error);
  }
  clearTimeout(deadline);
  for (const signal of signals) process.off(signal, requestStop);
  try {
    log(
      failures.length ? "error" : "info",
      failures.length ? "Web shutdown cleanup failed" : "Web shutdown completed",
      failures.length,
    );
  } finally {
    process.exit(failures.length ? 1 : 0);
  }
}
