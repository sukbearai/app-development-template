import { loadEnvironment } from "@pstack/database/environment";
import { envSchema } from "./env-schema";
export { envSchema } from "./env-schema";
// Entrypoints load .env.local then .env without overriding the process environment.
export const env = envSchema.parse(loadEnvironment());
if (env.WEB_REPLICAS > 1 && env.RATE_LIMIT_DRIVER !== "redis")
  throw new Error("RATE_LIMIT_DRIVER=redis is required when WEB_REPLICAS > 1");
