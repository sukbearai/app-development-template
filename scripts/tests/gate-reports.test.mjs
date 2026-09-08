import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateGateReports } from '../gate-reports.mjs';

test('runtime gates require their new matching successful report rather than a command log', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gate-reports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.verification/app/run-one'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'result.json');
  const source = { gitSha: 'a'.repeat(40), dirty: false, sourceSha256: 'b'.repeat(64) };
  const report = { status: 'passed', mode: 'ui', production: true, browserRuns: 2, source, cleanupErrors: [] };
  await assert.rejects(validateGateReports('test:ui:production', [], root, source), /one new/);
  await writeFile(file, JSON.stringify(report));
  await validateGateReports('test:ui:production', [file], root, source);
  for (const change of [{ status: 'failed' }, { source: { ...source, dirty: true } }, { browserRuns: 0 }, { cleanupErrors: ['failed'] }]) {
    await writeFile(file, JSON.stringify({ ...report, ...change }));
    await assert.rejects(validateGateReports('test:ui:production', [file], root, source));
  }
  await validateGateReports('typecheck', [], root, source);
});
