import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";

const root = process.argv[2] || "/Users/fayon/workspace/github/app-development-template";
const source = fs
  .readFileSync(`${root}/apps/web/lib/auth-service.ts`, "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace(/^export /gm, "");
const calls = [];
const context = vm.createContext({
  env: { SESSION_TTL_SECONDS: 86400 },
  repo: { revokeSession: async (id) => calls.push(id) },
  Buffer,
});
vm.runInContext(stripTypeScriptTypes(source), context);
const grants = vm.runInContext(
  'permissionsForUser({roleIds:["disabled"]}, [{id:"disabled",status:"inactive",permissionIds:["admin.write"]}]).has("admin.write")',
  context,
);
assert.equal(grants, true);
await vm.runInContext('logout("known-session-id.invalid-secret")', context);
assert.deepEqual(calls, ["known-session-id"]);
console.log(
  JSON.stringify({ inactiveRoleGrantsAdminWrite: grants, invalidSecretRevokeCalls: calls }),
);
