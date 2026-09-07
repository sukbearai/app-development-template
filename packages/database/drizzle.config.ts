import { loadEnvironment } from "./src/environment";
import { defineConfig } from "drizzle-kit";
loadEnvironment();
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations/template",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL || "postgres://generate-only.invalid/unused" },
  migrations: { schema: "drizzle", table: "drizzle_migrations" },
  strict: true,
  verbose: true,
});
