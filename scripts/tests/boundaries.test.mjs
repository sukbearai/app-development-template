import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('package boundary gate rejects builtins and relative cross-layer imports', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'pstack-boundaries-'));
  try {
    for (const directory of ['scripts', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/contracts/src', 'packages/database/src', 'packages/server/src', 'packages/kafka/src']) await mkdir(path.join(fixture, directory), { recursive: true });
    await copyFile(path.join(root, 'scripts/check-boundaries.mjs'), path.join(fixture, 'scripts/check-boundaries.mjs'));
    await symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    await writeFile(path.join(fixture, 'apps/web/app/page.tsx'), 'export default function Page() { return null; }');
    const run = () => execFileSync(process.execPath, [path.join(fixture, 'scripts/check-boundaries.mjs')], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(run(), /boundaries verified/);
    for (const source of ['import "fs";', 'import "node:crypto";']) {
      await writeFile(path.join(fixture, 'packages/contracts/src/index.ts'), source);
      assert.throws(run);
    }
    await writeFile(path.join(fixture, 'packages/contracts/src/index.ts'), 'export {};');
    await writeFile(path.join(fixture, 'packages/server/src/index.ts'), 'import "../../../apps/web/app/page";');
    assert.throws(run);
    await writeFile(path.join(fixture, 'packages/server/src/index.ts'), 'export {};');
    await writeFile(path.join(fixture, 'apps/web/components/client.tsx'), '"use client"; import "../../../packages/server/src/index";');
    assert.throws(run);
    await writeFile(path.join(fixture, 'packages/kafka/src/index.ts'), 'export {};');
    for (const dependency of ['@pstack/kafka', '../../../packages/kafka/src/index']) {
      await writeFile(path.join(fixture, 'apps/web/components/client.tsx'), `"use client"; import "${dependency}";`);
      assert.throws(run, /browser/);
    }
    await writeFile(path.join(fixture, 'apps/web/components/client.tsx'), '"use client"; import "../lib/kafka";');
    await writeFile(path.join(fixture, 'apps/web/lib/kafka.ts'), 'export * from "../../../packages/kafka/src/index";');
    assert.throws(run, /browser/);
    await writeFile(path.join(fixture, 'apps/web/components/client.tsx'), 'export {};');
    for (const dependency of ['@pstack/kafka', '../../kafka/src/index']) {
      await writeFile(path.join(fixture, 'packages/contracts/src/index.ts'), `import "${dependency}";`);
      assert.throws(run, /contracts imports/);
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
