import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceSha256 } from "../../.agents/skills/verify-pstack-x/scripts/identity.mjs";

test("production browser source identity includes styles and static assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-source-identity-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "page.tsx"), "export default () => null;");
    await writeFile(path.join(root, "style.css"), "body { color: red }");
    await writeFile(path.join(root, "public/logo.svg"), "<svg/>");
    const original = sourceSha256(root);
    await writeFile(path.join(root, "style.css"), "body { color: blue }");
    const restyled = sourceSha256(root);
    assert.notEqual(restyled, original, "CSS changes must invalidate production source identity");
    await writeFile(path.join(root, "public/logo.svg"), "<svg><circle r='1'/></svg>");
    assert.notEqual(
      sourceSha256(root),
      restyled,
      "Static assets must invalidate production source identity",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
