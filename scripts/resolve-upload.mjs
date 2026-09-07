#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "./env.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseResolveArguments(argv) {
  const args = argv.filter((value) => value !== "--"), options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--id") { options.id = args[++i]; continue; }
    if (!["--apply", "--confirm-writer-stopped", "--confirm-remote-write-settled"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    options[arg] = true;
  }
  if (!options.id || options.id.startsWith("--") || !options["--apply"] || !options["--confirm-writer-stopped"] || !options["--confirm-remote-write-settled"])
    throw new Error("Required: --id INTENT_ID --apply --confirm-writer-stopped --confirm-remote-write-settled");
  return { id: options.id, evidence: { writerStopped: true, remoteWriteSettled: true } };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseResolveArguments(argv);
  loadEnvironment(root);
  const { resolveBlockedUpload } = await import("../packages/server/src/product-service.ts");
  const { closeDatabase } = await import("../packages/database/src/client.ts");
  const { closeRedis } = await import("../packages/server/src/redis-client.ts");
  const { closeS3 } = await import("../packages/server/src/s3-client.ts");
  try { console.log(JSON.stringify(await resolveBlockedUpload(options.id, options.evidence))); }
  finally { await closeDatabase(); await closeRedis(); closeS3(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`Upload resolution failed: ${String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL redacted]")}`); process.exitCode = 1;
});
