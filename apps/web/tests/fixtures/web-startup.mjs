import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const lifecycle = process.pstackWebLifecycle;
const scenario = process.env.PSTACK_STARTUP_SCENARIO;
const record = (event) => appendFileSync("events.txt", `${event}\n`);
const released = new Promise((resolve) =>
  process.on("message", (message) => {
    if (message === "release") resolve();
  }),
);
lifecycle.registerCleanup(async () => {
  record("cleanup-first");
  process.send("cleanup");
  if (scenario === "cleanup-hang") await new Promise(() => {});
  if (scenario === "secret-failure")
    throw new Error("postgres://user:secret-sentinel@host/database");
  if (scenario === "cleanup-failure" || scenario === "startup-and-cleanup-failure") throw null;
});
process.send("startup");
await released;
if (scenario === "secret-failure") throw new Error("startup-secret-sentinel");
if (scenario === "startup-failure" || scenario === "startup-and-cleanup-failure") throw false;
lifecycle.registerCleanup(async () => {
  await delay(30);
  record("cleanup-late");
});
if (lifecycle.draining) {
  try {
    await lifecycle.trackWork(() => record("unexpected-work"));
  } catch {
    record("work-rejected");
  }
}
export default () => {
  record("request-handled");
  return new Response("fixture");
};
