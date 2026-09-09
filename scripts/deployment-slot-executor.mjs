import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  deploymentLock,
  readState,
  retainBundle,
  saveState,
  targetIdentity,
} from "./deployment-state.mjs";
import { sha256 } from "./verification-evidence.mjs";
import { slotRuntime } from "./deployment-slots.mjs";

class PersistenceFailure extends Error {}
async function compatibility(options) {
  const { verifyDeploymentTransition } = await import("./rollback-proof.mjs");
  const { verifyTransition } = await import("./release-plan.mjs");
  const proof = await verifyDeploymentTransition(options);
  assert.equal(proof.schemaVersion, 2, "MIXED_VERSION_PROOF_REQUIRED");
  verifyTransition(options.previous, options.release, options.rollback, proof);
}
export async function executeSlotDeployment({
  target,
  root,
  manifestFile,
  action,
  verify,
  runtime = slotRuntime(target),
  proof = compatibility,
}) {
  const unlock = await deploymentLock(target.stateDirectory);
  try {
    const state = await readState(
      target,
      sha256(`${await targetIdentity(target)}:${await runtime.host()}`),
    );
    async function load(bundle) {
      const result = await verify(
        bundle.root,
        path.join(bundle.root, bundle.manifest.path),
        target.repository,
      );
      assert.deepEqual(result.manifest, bundle.manifest, "RETAINED_BUNDLE_CHANGED");
      return result.release;
    }
    async function save() {
      try {
        await saveState(target, state);
      } catch (error) {
        throw new PersistenceFailure("DEPLOYMENT_STATE_WRITE_FAILED", { cause: error });
      }
    }
    async function advance(phase) {
      state.operation.phase = phase;
      await save();
    }
    async function observe() {
      const releases = {};
      if (state.current) releases[state.current.slot] = await load(state.current.bundle);
      if (state.operation && state.operation.phase !== "committed") {
        releases[state.operation.desired.slot] = await load(state.operation.desired.bundle);
        if (state.operation.previous)
          releases[state.operation.previous.slot] = await load(state.operation.previous.bundle);
      }
      return runtime.observe(releases);
    }
    if (action === "status") return { state, route: await observe(), trustVerified: true };
    assert.ok(root && manifestFile, "MANIFEST_REQUIRED");
    const requested = await verify(root, manifestFile, target.repository);
    const pending =
      state.operation && state.operation.phase !== "committed" && !state.operation.restored;
    if (pending) {
      assert.equal(action, "resume", "PENDING_OPERATION_REQUIRES_RESUME");
      assert.deepEqual(
        requested.manifest,
        state.operation.desired.bundle.manifest,
        "PENDING_MANIFEST_MISMATCH",
      );
      if (state.operation.phase === "failed") {
        assert.ok(
          state.operation.retryPhase && state.operation.errorCode !== "MIGRATION_OUTCOME_UNKNOWN",
          "FAILED_OPERATION_REQUIRES_INVESTIGATION",
        );
        await advance(state.operation.retryPhase);
      }
    } else {
      assert.notEqual(action, "resume", "NO_PENDING_OPERATION");
      await observe();
      const current = state.current ? await load(state.current.bundle) : null;
      const schemaRelease = state.schema ? await load(state.schema.bundle) : null;
      if (state.schema) await runtime.schema(schemaRelease, state.schema.ledgerSha256);
      if (state.current?.bundle.manifest.sha256 === requested.manifest.sha256) {
        await runtime.ready(requested.release, state.current.slot);
        await runtime.verifyRoute(state.current, requested.release);
        return { state, unchanged: true };
      }
      if (current) {
        await proof({
          root,
          release: requested.release,
          previous: current,
          previousRoot: state.current.bundle.root,
          schemaRelease,
          schemaRoot: state.schema.bundle.root,
          rollback: action === "rollback",
        });
        await runtime.ready(current, state.current.slot);
        await runtime.verifyRoute(state.current, current);
      } else assert.notEqual(action, "rollback", "INITIAL_DEPLOYMENT_CANNOT_ROLLBACK");
      const slot = state.current?.slot === "blue" ? "green" : "blue";
      await runtime.pull(requested.release, slot);
      const bundle = await retainBundle(target, root, requested.manifest);
      await load(bundle);
      const id = randomUUID();
      state.operation = {
        id,
        phase: "prepared",
        desired: { slot, bundle, generation: id },
        previous: state.current,
        rollback: action === "rollback",
        migrationName: `${target.project}-${slot}-migration-${id}`,
        migrationId: null,
        errorCode: null,
        retryPhase: null,
        restored: false,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await save();
    }
    const operation = state.operation;
    const desired = operation.desired;
    const release = await load(desired.bundle);
    const previous = operation.previous ? await load(operation.previous.bundle) : null;
    if (previous && operation.phase !== "restoring") {
      const schemaRelease = state.schema ? await load(state.schema.bundle) : previous;
      await proof({
        root: desired.bundle.root,
        release,
        previous,
        previousRoot: operation.previous.bundle.root,
        schemaRelease,
        schemaRoot: state.schema?.bundle.root ?? operation.previous.bundle.root,
        rollback: operation.rollback,
      });
      if (state.schema && operation.phase !== "migrating")
        await runtime.schema(schemaRelease, state.schema.ledgerSha256);
    }
    async function restore() {
      assert.ok(previous, "PREVIOUS_RELEASE_REQUIRED");
      const anchor = await load(state.schema.bundle);
      await proof({
        root: operation.previous.bundle.root,
        release: previous,
        previous: release,
        previousRoot: desired.bundle.root,
        schemaRelease: anchor,
        schemaRoot: state.schema.bundle.root,
        rollback: !operation.rollback,
      });
      await runtime.schema(anchor, state.schema.ledgerSha256);
      await runtime.start(previous, operation.previous.slot);
      await runtime.ready(previous, operation.previous.slot);
      await runtime.route(operation.previous.slot, previous, operation.previous.generation);
      await runtime.verifyRoute(operation.previous, previous);
      state.current = operation.previous;
      await save();
      await runtime.drain();
      await runtime.remove(desired.slot, release);
      operation.restored = true;
      operation.retryPhase = null;
      await advance("failed");
      return { state, failed: true, restored: true };
    }
    try {
      await observe();
      if (operation.phase === "prepared") {
        await runtime.pull(release, desired.slot);
        await runtime.preflight(release, desired.slot);
        const migrate =
          !operation.rollback &&
          state.schema?.ledgerSha256 !== release.compatibility.migrationLedgerSha256;
        await advance(migrate ? "migrating" : "starting");
      }
      if (operation.phase === "migrating") {
        await runtime.migrate(release, desired.slot, operation, save);
        await runtime.schema(release, release.compatibility.migrationLedgerSha256);
        state.schema = {
          bundle: desired.bundle,
          ledgerSha256: release.compatibility.migrationLedgerSha256,
        };
        await advance("starting");
      }
      if (operation.phase === "starting") {
        if (
          !operation.rollback &&
          state.schema.ledgerSha256 === release.compatibility.migrationLedgerSha256
        ) {
          state.schema.bundle = desired.bundle;
          await save();
        }
        await runtime.start(release, desired.slot);
        await advance("checking");
      }
      if (operation.phase === "checking") {
        await runtime.ready(release, desired.slot);
        await advance("switching");
      }
      if (operation.phase === "switching") {
        await runtime.ready(release, desired.slot);
        await runtime.route(desired.slot, release, desired.generation);
        await runtime.verifyRoute(desired, release);
        state.current = desired;
        await advance("draining");
      }
      if (operation.phase === "draining") {
        await runtime.verifyRoute(desired, release);
        await runtime.drain();
        if (previous) await runtime.remove(operation.previous.slot, previous);
        operation.retryPhase = null;
        operation.errorCode = null;
        await advance("committed");
      }
      if (operation.phase === "restoring") return await restore();
      return { state };
    } catch (error) {
      if (error instanceof PersistenceFailure) throw error;
      const phase = operation.phase;
      operation.errorCode = /^[A-Z][A-Z_]+$/.test(error.message)
        ? error.message
        : "DEPLOYMENT_FAILED";
      operation.retryPhase = phase;
      if (previous && ["starting", "checking", "switching", "restoring"].includes(phase)) {
        await advance("restoring");
        try {
          return await restore();
        } catch (restoreError) {
          if (restoreError instanceof PersistenceFailure) throw restoreError;
          operation.retryPhase = "restoring";
        }
      }
      await advance("failed");
      return { state, failed: true, restored: false };
    }
  } finally {
    await unlock();
  }
}
