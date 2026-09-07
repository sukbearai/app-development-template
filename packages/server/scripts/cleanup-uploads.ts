import { reconcileUploads } from "../src/product-service";
import { closeDatabase } from "@pstack/database/client";
import { closeRedis } from "../src/redis-client";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: storage:cleanup [--dry-run]");
try {
  const results = await reconcileUploads({ dryRun: args.includes("--dry-run") });
  process.stdout.write(`${JSON.stringify({ dryRun: args.includes("--dry-run"), results })}\n`);
} finally {
  await closeDatabase();
  await closeRedis();
}
