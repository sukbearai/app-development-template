import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { stopVerificationServer } from "../verification-server-shutdown.mjs";

for (const scenario of [
  { name: "requested development SIGTERM exit 143", production: false, code: 143, passes: true },
  {
    name: "premature development exit 143",
    production: false,
    code: 143,
    premature: true,
    passes: false,
  },
  { name: "production exit 143", production: true, code: 143, passes: false },
  { name: "production graceful exit zero", production: true, code: 0, passes: true },
  { name: "forced development termination", production: false, ignore: true, passes: false },
])
  test(scenario.name, async (t) => {
    const source = scenario.premature
      ? `process.exit(${scenario.code});`
      : `process.on("SIGTERM", () => { ${scenario.ignore ? "" : `process.exit(${scenario.code});`} }); process.stdout.write("ready"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", source], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
      await closed;
    });
    if (scenario.premature) await closed;
    else await new Promise((resolve) => child.stdout.once("data", resolve));
    const records = [];
    const stopped = stopVerificationServer({
      child,
      closed,
      production: scenario.production,
      record: (record) => records.push(record),
      timeoutMs: scenario.ignore ? 30 : 1000,
    });
    if (scenario.passes) await stopped;
    else
      await assert.rejects(
        stopped,
        scenario.ignore ? /forced termination/ : /shutdown failed \(143\)/,
      );
    assert.equal(records.length, 1);
    assert.equal(records[0].requestedSignal, scenario.premature ? null : "SIGTERM");
    assert.equal(records[0].forced, scenario.ignore ?? false);
    assert.equal(records[0].code, scenario.ignore ? null : scenario.code);
    assert.equal(records[0].signal, scenario.ignore ? "SIGKILL" : null);
  });
