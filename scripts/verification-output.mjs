import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function verificationDirectory(root, kind, env = process.env) {
  assert.match(kind, /^[a-z][a-z0-9-]*$/, "Invalid verification category");
  const checkout = realpathSync(root);
  const parent = path.join(checkout, ".verification");
  const output = env.PSTACK_VERIFICATION_ROOT
    ? path.resolve(checkout, env.PSTACK_VERIFICATION_ROOT)
    : parent;
  const relative = path.relative(parent, output);
  assert.ok(
    !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
    "Verification output must remain under this checkout's .verification directory",
  );
  const target = path.join(output, kind);
  let current = checkout;
  for (const segment of path.relative(checkout, target).split(path.sep)) {
    current = path.join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry)
      assert.ok(
        entry.isDirectory() && !entry.isSymbolicLink(),
        "Verification output cannot traverse symlinks or files",
      );
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Usage: node scripts/verification-output.mjs <category>");
  process.stdout.write(`${verificationDirectory(process.cwd(), process.argv[2])}\n`);
}
