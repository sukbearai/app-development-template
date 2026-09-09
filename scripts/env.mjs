import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// Explicit process values, including empty values, take precedence over files.
export function loadEnvironment(root, target = process.env) {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    if (existsSync(file)) Object.assign(values, parseEnv(readFileSync(file, "utf8")));
  }
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined) target[key] = value;
  }
  return target;
}

export function postgresUrl(value) {
  if (!value)
    throw new Error("DATABASE_URL is required; example files are never loaded automatically");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2 ||
    url.hash
  ) {
    throw new Error("DATABASE_URL must name a PostgreSQL host and database");
  }
  return url;
}
