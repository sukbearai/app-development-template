import { bootstrapAdministrator } from "../src/bootstrap-admin";
import { closeDatabase } from "@pstack/database/client";
try {
  const account = process.env.BOOTSTRAP_ADMIN_ACCOUNT;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!account || !password)
    throw new Error(
      "BOOTSTRAP_ADMIN_ACCOUNT and BOOTSTRAP_ADMIN_PASSWORD are required",
    );
  const result = await bootstrapAdministrator(
    {
      account,
      password,
      displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
    },
    { recoverLegacy: process.argv.includes("--recover-legacy") },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await closeDatabase();
}
