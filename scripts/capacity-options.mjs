import { parseArgs } from "node:util";
import { access, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";

const bounds = {
  concurrency: [4, 1, 64],
  requests: [24, 1, 1000],
  "upload-bytes": [262144, 1, 10485760],
};

export function verificationOptions(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        production: { type: "boolean" },
        ui: { type: "boolean" },
        capacity: { type: "boolean" },
        ...Object.fromEntries(Object.keys(bounds).map((key) => [key, { type: "string" }])),
      },
    }));
  } catch {
    throw new Error(
      "Invalid verification arguments. Use --production --capacity with optional --concurrency, --requests and --upload-bytes.",
    );
  }
  if (values.capacity && (!values.production || values.ui))
    throw new Error("--capacity requires --production and excludes --ui");
  const capacity = {};
  for (const [key, [fallback, min, max]] of Object.entries(bounds)) {
    if (values[key] !== undefined && !values.capacity)
      throw new Error(`--${key} requires --capacity`);
    const input = values[key] ?? String(fallback);
    const value = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`--${key} must be an integer from ${min} to ${max}`);
    capacity[key === "upload-bytes" ? "uploadBytes" : key] = value;
  }
  if (capacity.requests * capacity.uploadBytes > 1024 ** 3)
    throw new Error("Total requested upload bytes must not exceed 1 GiB");
  return {
    production: values.production === true,
    mode: values.capacity ? "capacity" : values.ui ? "ui" : "api",
    capacity,
  };
}

export async function refuseCapacityEnvFiles(root) {
  for (const directory of [root, path.join(root, "apps/web")]) {
    const names = await readdir(directory);
    if (
      names.some((name) =>
        /^\.env(?:\.(?:local|production|test|development)(?:\.local)?)?$/.test(name),
      )
    )
      throw new Error("Capacity verification requires a checkout without active dotenv files");
  }
}

export async function acquireProductionLock(root) {
  const directory = path.join(root, ".verification");
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, "production-verification.lock");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Production verification already owns this checkout, or its lock requires manual inspection",
      );
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    await handle.close();
    await rm(lock);
    throw error;
  }
  return async () => {
    await handle.close();
    await rm(lock);
  };
}

export function ownedCapacityTarget(origin, databaseURL) {
  const web = new URL(origin);
  const database = new URL(databaseURL);
  if (
    web.protocol !== "http:" ||
    web.hostname !== "127.0.0.1" ||
    !web.port ||
    web.pathname !== "/" ||
    web.username ||
    web.password ||
    web.search ||
    web.hash
  )
    throw new Error("Capacity requires the owned loopback HTTP target");
  if (
    database.protocol !== "postgresql:" ||
    database.hostname !== "127.0.0.1" ||
    !database.port ||
    database.pathname !== "/pstack_test" ||
    database.username !== "postgres" ||
    !database.password ||
    database.search ||
    database.hash
  )
    throw new Error("Capacity requires the owned ephemeral PostgreSQL database");
}

export async function capacityPreflight(root) {
  await refuseCapacityEnvFiles(root);
  await access(path.join(root, "apps/web/scripts/start.mjs"));
}
