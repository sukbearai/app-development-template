import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { z } from "zod";
const template = process.argv[2];
assert.ok(template, "Pass the template repository path");
function evaluate(file, expression, globals = {}) {
  const source = stripTypeScriptTypes(
    readFileSync(`${template}/${file}`, "utf8").replace(/^import .*;\s*$/gm, ""),
    { mode: "strip" },
  ).replace(/^export /gm, "");
  return vm.runInNewContext(source + "\n" + expression, { z, ...globals });
}
const forcePathStyle = evaluate("apps/web/lib/env.ts", "env.OBJECT_STORAGE_FORCE_PATH_STYLE", {
  process: { env: { OBJECT_STORAGE_FORCE_PATH_STYLE: "false" } },
});
assert.equal(forcePathStyle, true);
const login = evaluate("packages/shared/src/index.ts", "loginRequestSchema");
assert.deepEqual(login.parse({ account: "  admin ", password: "x" }), {
  account: "admin",
  password: "x",
});
const schema = z.toJSONSchema(login, { io: "input" });
assert.equal(schema.properties.account.minLength, 1);
writeFileSync(new URL("zod-input-schema.json", import.meta.url), JSON.stringify(schema, null, 2));
const result = {
  zodVersion: JSON.parse(readFileSync(new URL("node_modules/zod/package.json", import.meta.url)))
    .version,
  envFalseBecomesTrue: forcePathStyle,
  generatedInputSchema: true,
  boundary:
    "Original template schemas evaluated in isolation with published pinned Zod; no database, app server, or S3.",
};
writeFileSync(new URL("zod-result.json", import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
