#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkMonitor, monitorConfig } from "./monitor-check.mjs";
import { advanceState, monitorStatus, stateSchema } from "./monitor-state.mjs";
import { acquireProcessLock } from "./process-lock.mjs";

const duration = z.number().int().min(0).max(86400000);
const configSchema = z
  .strictObject({
    version: z.literal(1),
    targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    metricsUrl: z.url(),
    webhookUrl: z.url(),
    stateDirectory: z.string().refine(path.isAbsolute),
    sustainMs: duration,
    recoveryMs: duration,
    maxObservationGapMs: duration.min(1000),
    webhookTimeoutMs: duration.min(100).max(10000),
    retryBaseMs: duration.min(100).max(3600000),
    retryMaxMs: duration.min(100).max(86400000),
    maxAttempts: z.number().int().min(1).max(1000),
    maxDeliveriesPerTick: z.number().int().min(1).max(20),
    maxQueue: z.number().int().min(1).max(1000),
  })
  .refine(
    (value) =>
      value.retryBaseMs <= value.retryMaxMs &&
      value.maxDeliveriesPerTick * value.webhookTimeoutMs <= 30000,
  );

async function boundedJson(filename, limit) {
  const handle = await open(filename, "r");
  try {
    if ((await handle.stat()).size > limit) throw new Error("file_too_large");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("file_too_large");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function tickConfig(filename, env) {
  const config = configSchema.parse(await boundedJson(filename, 16384));
  const webhook = new URL(config.webhookUrl);
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(webhook.hostname);
  if (
    !(webhook.protocol === "https:" || (webhook.protocol === "http:" && local)) ||
    webhook.username ||
    webhook.password ||
    webhook.search ||
    webhook.hash ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.MONITOR_WEBHOOK_TOKEN ?? "")
  ) {
    throw new Error("invalid_configuration");
  }
  return {
    ...config,
    metrics: monitorConfig({ ...env, METRICS_URL: config.metricsUrl }),
    webhookToken: env.MONITOR_WEBHOOK_TOKEN,
    identity: createHash("sha256")
      .update(JSON.stringify([config.targetId, new URL(config.metricsUrl).href, webhook.href]))
      .digest("hex"),
  };
}

async function loadState(config) {
  try {
    const state = stateSchema.parse(
      await boundedJson(path.join(config.stateDirectory, "state.json"), 1048576),
    );
    if (state.identity !== config.identity || state.targetId !== config.targetId) {
      throw new Error("state_identity_mismatch");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("invalid_state");
    return {
      version: 1,
      identity: config.identity,
      targetId: config.targetId,
      lastObservationAt: null,
      lastTickAt: null,
      incidents: [],
      queue: [],
    };
  }
}

async function persist(config, state) {
  stateSchema.parse(state);
  const temporary = path.join(config.stateDirectory, `.state-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path.join(config.stateDirectory, "state.json"));
    const directory = await open(config.stateDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function notify(config, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.webhookToken}`,
        "content-type": "application/json",
        "idempotency-key": event.id,
      },
      body: JSON.stringify({
        version: 1,
        targetId: config.targetId,
        id: event.id,
        incidentId: event.incidentId,
        reason: event.reason,
        transition: event.transition,
        occurredAt: event.occurredAt,
      }),
    });
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 16384) throw new Error("response_too_large");
      }
    }
    return response.ok;
  } catch {
    return false;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export async function runTick(config, retryDelivery = false) {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.stateDirectory, "tick.lock");
  let release;
  try {
    release = await acquireProcessLock(lockPath);
  } catch {
    throw new Error("state_locked");
  }
  try {
    let state = await loadState(config);
    if (retryDelivery) {
      for (const event of state.queue) {
        event.attempts = 0;
        event.nextAttemptAt = 0;
      }
    }
    if (!retryDelivery) {
      state = advanceState(state, await checkMonitor(config.metrics), config, Date.now());
    }
    await persist(config, state);
    for (let count = 0; count < config.maxDeliveriesPerTick; count++) {
      const event = state.queue[0];
      if (!event || event.nextAttemptAt > Date.now() || event.attempts >= config.maxAttempts) break;
      event.attempts++;
      event.nextAttemptAt =
        Date.now() +
        Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(event.attempts - 1, 30));
      await persist(config, state);
      if (!(await notify(config, event))) break;
      state.queue.shift();
      await persist(config, state);
    }
    if (!retryDelivery) state.lastTickAt = Date.now();
    await persist(config, state);
    return monitorStatus(state, config);
  } finally {
    await release();
  }
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  let config;
  const actions = argv.filter((arg) => ["--status", "--retry-delivery"].includes(arg));
  const [option, filename, extra] = argv.filter((arg) => !actions.includes(arg));
  const [action] = actions;
  try {
    if (
      option !== "--config" ||
      !filename ||
      extra !== undefined ||
      actions.length > 1 ||
      argv.length > 3 ||
      (action !== undefined && !["--status", "--retry-delivery"].includes(action))
    ) {
      throw new Error("invalid_configuration");
    }
    config = await tickConfig(filename, env);
  } catch {
    return {
      output: { version: 1, severity: "error", reason: "invalid_configuration" },
      exitCode: 2,
    };
  }
  try {
    const output =
      action === "--status"
        ? monitorStatus(await loadState(config), config)
        : await runTick(config, action === "--retry-delivery");
    return { output, exitCode: output.severity === "healthy" ? 0 : 1 };
  } catch (error) {
    const reason = ["state_locked", "invalid_state", "queue_full", "clock_regressed"].includes(
      error.message,
    )
      ? error.message
      : "monitor_failed";
    return { output: { version: 1, severity: "error", reason }, exitCode: 2 };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, exitCode } = await main();
  console.log(JSON.stringify(output));
  process.exitCode = exitCode;
}
