import { loadEnvironment } from "@pstack/database/environment";
import { envSchema } from "../src/env-schema";
import { assessDeploymentConfig, validateProductionConfig } from "../src/production-config";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--deployment")) {
  process.stderr.write("Usage: config:check [--deployment]\n");
  process.exitCode = 1;
} else {
  try {
    const raw = loadEnvironment();
    if (args[0] === "--deployment") {
      const issues = assessDeploymentConfig(raw);
      if (issues.length) {
        for (const issue of issues)
          process.stderr.write(`${issue.key} [${issue.code}]: ${issue.message}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write("Deployment configuration valid (static checks only)\n");
      }
    } else {
      const parsed = envSchema.safeParse(raw);
      const issues = validateProductionConfig();
      if (!parsed.success)
        issues.push(
          ...parsed.error.issues.map(
            (issue) => `${String(issue.path[0] ?? "environment")}: invalid configuration value`,
          ),
        );
      if (
        parsed.success &&
        parsed.data.WEB_REPLICAS > 1 &&
        parsed.data.RATE_LIMIT_DRIVER !== "redis"
      )
        issues.push("RATE_LIMIT_DRIVER=redis is required when WEB_REPLICAS > 1");
      if (issues.length) {
        process.stderr.write(`${issues.join("\n")}\n`);
        process.exitCode = 1;
      } else if (parsed.success) {
        const config = parsed.data;
        process.stdout.write(
          `Configuration valid (${config.NODE_ENV}, ${config.UPLOAD_STORAGE_DRIVER}, ${config.RATE_LIMIT_DRIVER})\n`,
        );
      }
    }
  } catch {
    process.stderr.write("environment [CONFIG_READ_FAILED]: Unable to read configuration.\n");
    process.exitCode = 1;
  }
}
