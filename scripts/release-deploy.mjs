#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Version } from 'release-please/build/src/version.js';
import { commandResult, printCommandResult } from './engineering-command.mjs';
import { evidenceReference } from './verification-evidence.mjs';
import { inside, verifyRelease } from './release-manifest.mjs';

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const publishedReleaseSchema = z.object({ id: z.number().int().positive(), draft: z.literal(false), tag_name: z.string(), published_at: z.iso.datetime(), assets: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative(), digest: z.string() })) });
function githubApi(endpoint) { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
export async function verifyPublishedRelease(repository, release, manifestReference, api = githubApi) {
  repositorySchema.parse(repository);
  const remote = publishedReleaseSchema.parse(await api(`repos/${repository}/releases/tags/${encodeURIComponent(release.tag)}`));
  assert.equal(remote.tag_name, release.tag, 'Published release tag mismatch');
  const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(await api(`repos/${repository}/commits/${encodeURIComponent(release.tag)}`));
  assert.equal(commit.sha, release.source.gitSha, 'Published release source SHA mismatch');
  const asset = remote.assets.find(entry => entry.name === path.basename(manifestReference.path));
  assert.ok(asset, 'Published release manifest asset missing');
  assert.equal(asset.digest, `sha256:${manifestReference.sha256}`, 'Published release manifest digest mismatch');
  assert.equal(asset.size, manifestReference.bytes, 'Published release manifest size mismatch');
  return remote.id;
}
export function verifyTransition(current, target, rollback) {
  assert.equal(current.compatibility.recoveryProtocol, target.compatibility.recoveryProtocol, 'Unsupported recovered-worker protocol');
  assert.equal(current.compatibility.migrationLedgerSha256, target.compatibility.migrationLedgerSha256, 'Migration ledger differs; explicit migration compatibility validation is required');
  if (rollback) assert.ok(current.compatibility.rollbackVersions.includes(target.version), 'Rollback version has not been explicitly verified');
  else assert.ok(Version.parse(target.version).compare(Version.parse(current.version)) >= 0, 'Older release requires --rollback');
}
export async function deploymentPlan(root, manifestFile, repository, currentFile = null, rollback = false, api = githubApi) {
  assert.ok(!rollback || currentFile, '--rollback requires --current');
  const release = await verifyRelease(manifestFile, root);
  const manifestReference = await evidenceReference(root, manifestFile);
  const releaseId = await verifyPublishedRelease(repository, release, manifestReference, api);
  if (currentFile) {
    const current = await verifyRelease(currentFile, root);
    await verifyPublishedRelease(repository, current, await evidenceReference(root, currentFile), api);
    verifyTransition(current, release, rollback);
  }
  return { schemaVersion: 1, operation: 'plan', releaseId, version: release.version, tag: release.tag, source: release.source,
    environment: { PSTACK_WEB_IMAGE: release.images.web.reference, PSTACK_WORKER_IMAGE: release.images.worker.reference },
    platforms: { web: release.images.web.platform, worker: release.images.worker.platform }, compatibility: release.compatibility,
    rollout: rollback ? 'rollback' : 'deploy', manifest: manifestReference,
    requiredAcceptance: ['production configuration preflight', 'migration task before application rollout', 'database and Kafka recovery binding checks', 'target environment business smoke'],
  };
}
async function main() {
  const json = process.argv.includes('--json');
  let options;
  try {
    const args = process.argv.slice(2);
    assert.equal(args.shift(), 'plan', 'Only the plan command is supported');
    options = parseArgs({ args, options: { root: { type: 'string', default: process.cwd() }, manifest: { type: 'string' }, repo: { type: 'string' }, current: { type: 'string' }, rollback: { type: 'boolean', default: false }, json: { type: 'boolean' } }, strict: true }).values;
    assert.ok(options.manifest && options.repo, '--manifest and --repo are required');
    repositorySchema.parse(options.repo);
    inside(options.root, options.manifest);
    if (options.current) inside(options.root, options.current);
    assert.ok(!options.rollback || options.current, '--rollback requires --current');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(commandResult({ command: 'release:plan', status: 'invalid', errorCode: 'INVALID_ARGUMENT' }), json); return;
  }
  try {
    const plan = await deploymentPlan(options.root, inside(options.root, options.manifest), options.repo, options.current ? inside(options.root, options.current) : null, options.rollback);
    if (!json) for (const [key, value] of Object.entries(plan.environment)) process.stdout.write(`${key}=${value}\n`);
    printCommandResult(commandResult({ command: 'release:plan', status: 'passed', evidence: options.manifest, data: plan }), json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(commandResult({ command: 'release:plan', status: 'failed', errorCode: 'RELEASE_NOT_DEPLOYABLE' }), json);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
