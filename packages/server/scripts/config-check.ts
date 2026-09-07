import { validateProductionConfig } from "../src/production-config";
import { env } from "../src/env";

const issues = validateProductionConfig();
if (issues.length) {
  process.stderr.write(`${issues.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Configuration valid (${env.NODE_ENV}, ${env.UPLOAD_STORAGE_DRIVER}, ${env.RATE_LIMIT_DRIVER})\n`);
}
