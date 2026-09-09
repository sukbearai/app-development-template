import { parseArgs } from "node:util";
import { closeDatabase } from "@pstack/database/client";
import { recoverAdministrator } from "../src/recover-admin";

try {
  const newPassword = process.env.ADMIN_RECOVERY_PASSWORD;
  delete process.env.ADMIN_RECOVERY_PASSWORD;
  const { values } = parseArgs({
    options: { account: { type: "string" }, confirm: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.account || values.confirm !== true || !newPassword)
    throw new Error("Recovery requires --account, --confirm and ADMIN_RECOVERY_PASSWORD");
  const result = await recoverAdministrator({
    account: values.account,
    newPassword,
    confirm: true,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(
    "Administrator recovery failed. Check the account, privileges, password policy and explicit confirmation.\n",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
