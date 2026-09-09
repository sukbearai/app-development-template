import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDocuments } from "../check-docs.mjs";

test("documentation check detects stale links, recipe order and source/verification mappings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "docs-check-test-"));
  const feature = ".agents/skills/verify-pstack-x/features/README.md";
  const write = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  try {
    await write("package.json", JSON.stringify({ scripts: { dev: "node app" } }));
    await write(
      "docs/startup-steps.json",
      JSON.stringify({ install: ["install", "--frozen-lockfile"], dev: ["dev"] }),
    );
    await write(
      "README.md",
      "pnpm install --frozen-lockfile\npnpm dev\n[Feature](.agents/skills/verify-pstack-x/features/README.md)",
    );
    await write("apps/web/page.mjs", "export {};");
    await write("scripts/verify.mjs", "export {};");
    await write(feature, "| Home | apps/web/page.mjs | Browser | scripts/verify.mjs |");
    const clean = await checkDocuments(root, ["README.md", feature]);
    assert.deepEqual(clean.errors, []);
    await write(
      "README.md",
      "pnpm dev\npnpm install --frozen-lockfile\n[Gone](docs/gone.md)\n`apps/web/gone.mjs`",
    );
    await write(feature, "| Home | apps/web/gone.mjs | Browser | scripts/gone.mjs |");
    const stale = await checkDocuments(root, ["README.md", feature]);
    assert.ok(stale.errors.some((error) => error.includes("broken local link")));
    assert.ok(stale.errors.some((error) => error.includes("out-of-order")));
    assert.ok(stale.errors.some((error) => error.includes("missing example/source")));
    assert.ok(stale.errors.some((error) => error.includes("missing scripts/gone.mjs")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
