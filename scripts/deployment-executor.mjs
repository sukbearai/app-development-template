import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { composeTarget } from "./deployment-compose.mjs";
import {
  deploymentLock,
  readState,
  retainBundle,
  saveState,
  targetIdentity,
  targetSchema,
} from "./deployment-state.mjs";
import { verifyPublishedRelease, verifyTransition } from "./release-plan.mjs";
import { releaseSchema, verifyRelease } from "./release-manifest.mjs";
import { verifyReleaseRollback } from "./rollback-proof.mjs";
import { evidenceReference, sha256 } from "./verification-evidence.mjs";

class DeploymentPersistenceError extends Error {}

export async function verifiedDeploymentBundle(root, manifestFile, repository) {
  const release = await verifyRelease(manifestFile, root);
  const manifest = await evidenceReference(root, manifestFile);
  await verifyPublishedRelease(repository, release, manifest);
  const { verifyReleaseSecurity } = await import("./release-security.mjs");
  await verifyReleaseSecurity(root, release, repository);
  return { release, manifest };
}
export async function readDeploymentTarget(file) {
  return targetSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
function failureCode(error) {
  const codes = [
    "MIGRATION_OUTCOME_UNKNOWN",
    "MIGRATION_FAILED",
    "MIGRATION_ID_MISMATCH",
    "MIGRATION_IMAGE_MISMATCH",
    "MIGRATION_OWNER_MISMATCH",
    "READINESS_FAILED",
    "LIVE_IMAGE_DRIFT",
    "LIVE_SERVICE_COUNT_DRIFT",
    "DOCKER_COMMAND_FAILED",
  ];
  return codes.find((code) => error.message.includes(code)) ?? "DEPLOYMENT_FAILED";
}
export async function executeDeployment({
  target,
  root,
  manifestFile,
  action = "apply",
  verify = verifiedDeploymentBundle,
  runtime = composeTarget(target),
  proof = verifyReleaseRollback,
}) {
  targetSchema.parse(target);
  assert.ok(
    ["apply", "resume", "rollback", "status"].includes(action),
    "INVALID_DEPLOYMENT_ACTION",
  );
  const unlock = await deploymentLock(target.stateDirectory);
  try {
    const identity = sha256(`${await targetIdentity(target)}:${await runtime.host()}`);
    const state = await readState(target, identity);
    const load = async (bundle) => {
      const verified = await verify(
        bundle.root,
        path.join(bundle.root, bundle.manifest.path),
        target.repository,
      );
      assert.deepEqual(verified.manifest, bundle.manifest, "RETAINED_BUNDLE_CHANGED");
      return verified.release;
    };
    const localRelease = async (bundle) =>
      releaseSchema.parse(
        JSON.parse(await readFile(path.join(bundle.root, bundle.manifest.path), "utf8")),
      );
    const current = state.current
      ? await (action === "status" ? localRelease(state.current) : load(state.current))
      : null;
    if (action === "status") {
      const allowed = current ? [current] : [];
      if (state.operation && state.operation.phase !== "committed")
        allowed.push(await localRelease(state.operation.desired));
      const live = await runtime.observe(
        allowed,
        Boolean(current) && state.operation?.phase === "committed",
      );
      return {
        state,
        trustVerified: false,
        live: live.map((container) => ({
          id: container.Id,
          image: container.Image,
          running: container.State.Running,
        })),
      };
    }
    assert.ok(root && manifestFile, "MANIFEST_REQUIRED");
    const requested = await verify(root, manifestFile, target.repository);
    const pending =
      state.operation &&
      state.operation.phase !== "committed" &&
      !(state.operation.phase === "failed" && state.operation.restored);
    if (pending) {
      assert.equal(action, "resume", "PENDING_OPERATION_REQUIRES_RESUME");
      assert.deepEqual(
        requested.manifest,
        state.operation.desired.manifest,
        "PENDING_MANIFEST_MISMATCH",
      );
      if (state.operation.phase === "failed") {
        assert.ok(
          state.operation.resumePhase && state.operation.errorCode !== "MIGRATION_OUTCOME_UNKNOWN",
          "FAILED_OPERATION_REQUIRES_INVESTIGATION",
        );
        state.operation.phase = state.operation.resumePhase;
        state.operation.errorCode = null;
        await saveState(target, state);
      }
    } else {
      assert.notEqual(action, "resume", "NO_PENDING_OPERATION");
      await runtime.observe(current ? [current] : [], Boolean(current));
      if (state.current?.manifest.sha256 === requested.manifest.sha256) {
        await runtime.ready(requested.release);
        return { state, unchanged: true };
      }
      if (current) {
        verifyTransition(current, requested.release, action === "rollback");
        if (action === "rollback") await proof(state.current.root, current, requested.release);
        else await proof(root, requested.release, current);
      } else assert.notEqual(action, "rollback", "INITIAL_DEPLOYMENT_CANNOT_ROLLBACK");
      await runtime.pull(requested.release);
      const desired = await retainBundle(target, root, requested.manifest);
      // Verify the retained bytes before the operation becomes durable.
      await load(desired);
      const id = randomUUID();
      state.operation = {
        id,
        phase: "prepared",
        resumePhase: null,
        desired,
        previous: state.current,
        rollback: action === "rollback",
        migrationName: `${target.project}-migration-${id}`,
        migrationId: null,
        errorCode: null,
        restored: false,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveState(target, state);
    }
    const operation = state.operation;
    const release = await load(operation.desired);
    const previous = operation.previous ? await load(operation.previous) : null;
    const save = async () => {
      try {
        await saveState(target, state);
      } catch (error) {
        throw new DeploymentPersistenceError("DEPLOYMENT_STATE_WRITE_FAILED", { cause: error });
      }
    };
    const advance = async (phase) => {
      operation.phase = phase;
      await save();
    };
    try {
      await runtime.model(release);
      await runtime.observe([release, ...(previous ? [previous] : [])], false);
      if (operation.phase === "prepared") {
        await runtime.pull(release);
        await runtime.preflight(release);
        if (previous) await runtime.stop(previous);
        await advance(operation.rollback ? "applying" : "migrating");
      }
      if (operation.phase === "migrating") {
        await runtime.migration(release, operation, save);
        await advance("applying");
      }
      if (operation.phase === "applying") {
        await runtime.apply(release);
        await advance("checking");
      }
      if (operation.phase === "checking") {
        await runtime.ready(release);
        state.current = operation.desired;
        await advance("committed");
      }
      if (operation.phase === "rolling_back") {
        assert.ok(previous && !operation.rollback, "ROLLBACK_NOT_AUTHORIZED");
        await proof(operation.desired.root, release, previous);
        await runtime.pull(previous);
        await runtime.apply(previous);
        await runtime.ready(previous);
        operation.restored = true;
        operation.resumePhase = null;
        await advance("failed");
        return { state, failed: true, restored: true };
      }
      return { state, failed: operation.phase === "failed" };
    } catch (error) {
      if (error instanceof DeploymentPersistenceError) throw error;
      const failedPhase = operation.phase;
      state.current = operation.previous;
      operation.errorCode = failureCode(error);
      if (previous && !operation.rollback && ["applying", "checking"].includes(failedPhase)) {
        await advance("rolling_back");
        try {
          // Reverify the predecessor security policy at restoration time.
          await load(operation.previous);
          await proof(operation.desired.root, release, previous);
          await runtime.observe([release, previous], false);
          await runtime.pull(previous);
          await runtime.apply(previous);
          await runtime.ready(previous);
          operation.restored = true;
          operation.resumePhase = null;
          await advance("failed");
          return { state, failed: true, restored: true };
        } catch (rollbackError) {
          if (rollbackError instanceof DeploymentPersistenceError) throw rollbackError;
          operation.resumePhase = "rolling_back";
          await advance("failed");
          return { state, failed: true, restored: false };
        }
      }
      operation.resumePhase = failedPhase;
      await advance("failed");
      return { state, failed: true, restored: false };
    }
  } finally {
    await unlock();
  }
}
