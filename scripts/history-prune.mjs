#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "./env.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseRetentionArguments(argv, now = new Date()) {
  const options = { dryRun: true, batchSize: 100 };
  const args = argv.filter((value) => value !== "--");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") { options.dryRun = false; continue; }
    if (!["--days", "--batch-size", "--session-days"].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    const key = args[i], value = args[++i];
    if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(Number(value))) throw new Error(`${key} requires an integer`);
    if (key === "--days") options.days = Number(value);
    else if (key === "--session-days") options.sessionDays = Number(value);
    else options.batchSize = Number(value);
  }
  if (!options.days || options.days < 1 || options.days > 36500) throw new Error("Explicit retention --days 1..36500 is required");
  if (options.batchSize < 1 || options.batchSize > 1000) throw new Error("--batch-size must be 1..1000");
  if (options.sessionDays !== undefined) {
    if (options.sessionDays < 1 || options.sessionDays > 36500) throw new Error("--session-days must be 1..36500");
    options.sessionBefore = new Date(now.getTime() - options.sessionDays * 86400000);
  }
  return { ...options, before: new Date(now.getTime() - options.days * 86400000) };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseRetentionArguments(argv);
  loadEnvironment(root);
  const { runRetention } = await import("../packages/database/src/repository.ts");
  const { closeDatabase } = await import("../packages/database/src/client.ts");
  try {
    const counts = await runRetention(options);
    const result = { dryRun: options.dryRun, before: options.before.toISOString(), batchSize: options.batchSize, counts };
    if (options.sessionBefore) result.sessionBefore = options.sessionBefore.toISOString();
    console.log(JSON.stringify(result));
  } finally { await closeDatabase(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`History retention failed: ${String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL redacted]")}`); process.exitCode = 1;
});
