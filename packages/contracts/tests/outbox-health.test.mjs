import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAsyncQuarantine,
  evaluateOutboxBacklog,
  readOutboxHealthThresholds,
  statusFromOutboxAlerts,
} from "../src/outbox-health.ts";

const metrics = { pending: 0, failed: 0, oldestPendingAgeMs: 0 };
const defaults = readOutboxHealthThresholds({});

test("outbox health defaults and environment overrides use the existing settings", () => {
  assert.deepEqual(defaults, { pendingWarn: 50, pendingBlocked: 200, failedWarn: 10 });
  assert.deepEqual(readOutboxHealthThresholds({
    OUTBOX_PENDING_WARN: "5", OUTBOX_PENDING_BLOCKED: "20", OUTBOX_FAILED_WARN: "2",
  }), { pendingWarn: 5, pendingBlocked: 20, failedWarn: 2 });
  assert.deepEqual(readOutboxHealthThresholds({ OUTBOX_PENDING_WARN: "" }), defaults);
});

test("invalid threshold configuration falls back without disabling backlog alarms", () => {
  for (const invalid of ["nope", "NaN", "Infinity", "-1", "0", "0.5", "1.5", " ", "9007199254740992"]) {
    const thresholds = readOutboxHealthThresholds({
      OUTBOX_PENDING_WARN: invalid,
      OUTBOX_PENDING_BLOCKED: invalid,
      OUTBOX_FAILED_WARN: invalid,
    });
    assert.deepEqual(thresholds, defaults, invalid);
    const alerts = evaluateOutboxBacklog({ ...metrics, pending: 200, failed: 10 }, thresholds);
    assert.equal(statusFromOutboxAlerts(alerts), "blocked", invalid);
    assert.deepEqual(alerts.map((alert) => alert.reason), ["outbox_pending_blocked", "outbox_failed_backlog"]);
  }
});

for (const [input, status, reason, threshold] of [
  [{ pending: 49 }, "ok"],
  [{ pending: 50 }, "degraded", "outbox_pending_backlog", 50],
  [{ pending: 199 }, "degraded", "outbox_pending_backlog", 50],
  [{ pending: 200 }, "blocked", "outbox_pending_blocked", 200],
  [{ failed: 9 }, "ok"],
  [{ failed: 10 }, "degraded", "outbox_failed_backlog", 10],
  [{ oldestPendingAgeMs: 31999 }, "ok"],
  [{ oldestPendingAgeMs: 32000 }, "degraded", "outbox_oldest_pending_age", 32000],
]) {
  test(`outbox health boundary ${JSON.stringify(input)}`, () => {
    const alerts = evaluateOutboxBacklog({ ...metrics, ...input }, defaults);
    assert.equal(statusFromOutboxAlerts(alerts), status);
    assert.equal(alerts.length, reason ? 1 : 0);
    assert.equal(alerts[0]?.reason, reason);
    assert.equal(alerts[0]?.threshold, threshold);
  });
}

test("custom outbox thresholds preserve critical precedence and report actual limits", () => {
  const thresholds = { pendingWarn: 5, pendingBlocked: 20, failedWarn: 2 };
  assert.equal(statusFromOutboxAlerts(evaluateOutboxBacklog({ ...metrics, pending: 4, failed: 1 }, thresholds)), "ok");
  assert.equal(statusFromOutboxAlerts(evaluateOutboxBacklog({ ...metrics, pending: 5 }, thresholds)), "degraded");
  const alerts = evaluateOutboxBacklog({ pending: 20, failed: 2, oldestPendingAgeMs: 32000 }, thresholds);
  assert.equal(statusFromOutboxAlerts(alerts), "blocked");
  assert.deepEqual(alerts.map(({ reason, threshold }) => [reason, threshold]), [
    ["outbox_pending_blocked", 20], ["outbox_failed_backlog", 2], ["outbox_oldest_pending_age", 32000],
  ]);
});

for (const [counts, reasons] of [
  [{ messageQuarantine: 0, recoveryQuarantine: 0 }, []],
  [{ messageQuarantine: 2, recoveryQuarantine: 0 }, [["async_message_quarantine", "messageQuarantine", 2]]],
  [{ messageQuarantine: 0, recoveryQuarantine: 3 }, [["async_recovery_quarantine", "recoveryQuarantine", 3]]],
  [{ messageQuarantine: 2, recoveryQuarantine: 3 }, [["async_message_quarantine", "messageQuarantine", 2], ["async_recovery_quarantine", "recoveryQuarantine", 3]]],
]) {
  test(`quarantine health reports retained record counts ${JSON.stringify(counts)}`, () => {
    const alerts = evaluateAsyncQuarantine(counts);
    assert.deepEqual(alerts.map(({ reason, metric, value }) => [reason, metric, value]), reasons);
    assert.equal(statusFromOutboxAlerts(alerts), reasons.length ? "blocked" : "ok");
    for (const alert of alerts) {
      assert.equal(alert.severity, "critical");
      assert.equal(alert.threshold, 1);
      assert.match(alert.message, /retained.*investigation/i);
    }
  });
}
