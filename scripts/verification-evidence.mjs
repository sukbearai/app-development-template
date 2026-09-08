import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const sourceSchema = z.strictObject({ gitSha: shaSchema, dirty: z.boolean(), sourceSha256: hashSchema });
const referenceSchema = z.strictObject({ path: z.string().min(1), sha256: hashSchema, bytes: z.number().int().nonnegative() });
const checkSchema = z.strictObject({ name: z.string().min(1), status: z.enum(['passed', 'failed', 'not-run', 'inconclusive']), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), durationMs: z.number().nonnegative(), evidence: z.array(referenceSchema).min(1) });
export const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string().uuid(), source: sourceSchema,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  environment: z.strictObject({ node: z.string(), platform: z.string(), arch: z.string(), ciRun: z.string().nullable() }),
  status: z.enum(['passed', 'failed', 'inconclusive']), checks: z.array(checkSchema).min(1),
}).superRefine((index, context) => {
  const names = index.checks.map(check => check.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Duplicate evidence checks' });
  if (Date.parse(index.finishedAt) < Date.parse(index.startedAt)) context.addIssue({ code: 'custom', message: 'Invalid evidence interval' });
  for (const check of index.checks) {
    if (Date.parse(check.finishedAt) < Date.parse(check.startedAt)) context.addIssue({ code: 'custom', message: 'Invalid check interval' });
  }
  if (index.status === 'passed' && index.checks.some(check => check.status !== 'passed')) context.addIssue({ code: 'custom', message: 'Incomplete evidence cannot pass' });
});
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function sourceIdentity(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  const hashes = [];
  for (const name of files) {
    const file = path.join(root, name);
    const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat === null) { hashes.push([name, null]); continue; }
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Source must be a regular file: ${name}`);
    hashes.push([name, sha256(await readFile(file))]);
  }
  return sourceSchema.parse({ gitSha: git('rev-parse', 'HEAD').trim(), dirty: git('status', '--porcelain=v1', '--untracked-files=normal').length > 0, sourceSha256: sha256(JSON.stringify(Object.fromEntries(hashes))) });
}
export async function evidenceReference(root, file) {
  const base = await realpath(root);
  const target = await realpath(file);
  const relative = path.relative(base, target).split(path.sep).join('/');
  assert.ok(relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative), 'Evidence must stay within its root');
  assert.ok((await lstat(file)).isFile(), 'Evidence must be a regular file');
  return { path: relative, sha256: await fileHash(target), bytes: (await lstat(target)).size };
}
export async function createEvidenceRun(root) {
  const directory = path.join(root, 'artifacts', 'verification');
  await mkdir(directory, { recursive: true });
  const output = await mkdtemp(path.join(directory, 'run-'));
  return { output, runId: randomUUID(), source: await sourceIdentity(root), startedAt: new Date().toISOString() };
}
export async function writeEvidenceIndex(root, run, checks, status) {
  const index = evidenceSchema.parse({ schemaVersion: 1, runId: run.runId, source: run.source, startedAt: run.startedAt,
    finishedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, ciRun: process.env.GITHUB_RUN_ID || null }, status, checks });
  const file = path.join(run.output, 'index.json');
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
  return file;
}
export async function verifyEvidence(file, root, expectedSource = null, requirePassed = true) {
  const index = evidenceSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (requirePassed) assert.equal(index.status, 'passed', 'Verification did not pass');
  if (expectedSource) assert.deepEqual(index.source, expectedSource, 'Evidence source mismatch');
  for (const check of index.checks) for (const reference of check.evidence) {
    assert.ok(!path.isAbsolute(reference.path) && !reference.path.split('/').includes('..'), 'Unsafe evidence path');
    assert.deepEqual(await evidenceReference(root, path.join(root, reference.path)), reference, 'Evidence content mismatch');
  }
  return index;
}
