import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { containerOptions, prepareCandidateDirectory, writeContainerCandidate } from '../container-candidate.mjs';
import { sha256 } from '../verification-evidence.mjs';

test('export rejects outside, unignored and reused paths before Docker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  for (const args of [['--unknown'], ['--export', '../outside'], ['--export', 'docs'], ['--export', 'artifacts/run']]) assert.throws(() => containerOptions(args, root));
  await writeFile(path.join(root, '.gitignore'), 'artifacts/\n');
  const options = containerOptions(['--export', 'artifacts/run'], root);
  await prepareCandidateDirectory(options.output);
  await assert.rejects(prepareCandidateDirectory(options.output), /EEXIST/);
});
test('candidate binds both saved image archives and raw verification bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'candidate-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'candidate'); await mkdir(output);
  const summaryFile = path.join(root, 'summary.json'); await writeFile(summaryFile, '{"status":"passed"}\n');
  const images = {};
  for (const role of ['web', 'worker']) { await writeFile(path.join(output, `${role}.tar`), role); images[role] = { id: `sha256:${sha256(role)}`, platform: 'linux/arm64' }; }
  const file = await writeContainerCandidate({ root, output, summaryFile, images, source: { gitSha: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), dirty: false } });
  const candidate = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(candidate.images.web.archive.sha256, sha256('web'));
  assert.equal(candidate.images.worker.archive.sha256, sha256('worker'));
  assert.equal(candidate.verification.path, 'summary.json');
  await assert.rejects(writeContainerCandidate({ root, output, summaryFile, images, source: candidate.source }), /EEXIST/);
});
