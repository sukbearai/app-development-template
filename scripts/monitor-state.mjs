import { randomUUID } from "node:crypto";
import { z } from "zod";

const timestamp = z.number().int().nonnegative().safe();
const reasons = z.enum([
  "database_pool_waiting",
  "outbox_pending_age",
  "outbox_stale_locks",
  "task_unfinished_age",
  "dead_letters",
  "quarantine",
  "uploads_blocked",
  "database_unavailable",
  "metrics_stale",
  "metrics_clock_ahead",
  "database_metrics_stale",
  "database_metrics_clock_ahead",
  "collection_error",
  "collection_gap",
]);
const incident = z.strictObject({
  reason: reasons,
  incidentId: z.uuid(),
  phase: z.enum(["pending", "firing", "recovering"]),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  recoverySince: timestamp.nullable(),
});
const event = z.strictObject({
  id: z.string().min(1).max(256),
  incidentId: z.uuid(),
  reason: reasons,
  transition: z.enum(["firing", "resolved"]),
  occurredAt: timestamp,
  attempts: z.number().int().min(0).max(1000),
  nextAttemptAt: timestamp,
});
export const stateSchema = z
  .strictObject({
    version: z.literal(1),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    targetId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    lastObservationAt: timestamp.nullable(),
    lastTickAt: timestamp.nullable(),
    incidents: z.array(incident).max(reasons.options.length),
    queue: z.array(event).max(1000),
  })
  .superRefine((state, context) => {
    const invalid =
      new Set(state.incidents.map((item) => item.reason)).size !== state.incidents.length ||
      new Set(state.queue.map((item) => item.id)).size !== state.queue.length ||
      state.incidents.some(
        (item) =>
          item.firstSeenAt > item.lastSeenAt ||
          (item.phase === "recovering") !== (item.recoverySince !== null),
      ) ||
      state.queue.some(
        (item, index) =>
          item.id !== eventId(state.targetId, item) ||
          (index > 0 && item.occurredAt < state.queue[index - 1].occurredAt) ||
          (item.transition === "resolved" &&
            state.queue
              .slice(index + 1)
              .some(
                (later) => later.incidentId === item.incidentId && later.transition === "firing",
              )),
      );
    if (invalid) context.addIssue({ code: "custom", message: "inconsistent_state" });
  });

function eventId(targetId, item) {
  return `${targetId}:${item.reason}:${item.incidentId}:${item.transition}`;
}

function enqueue(state, item, transition, now, limit) {
  if (state.queue.length >= limit) throw new Error("queue_full");
  const notification = {
    incidentId: item.incidentId,
    reason: item.reason,
    transition,
    occurredAt: now,
    attempts: 0,
    nextAttemptAt: now,
  };
  state.queue.push({ id: eventId(state.targetId, notification), ...notification });
}

function missingObservation(observation) {
  return (
    observation.severity === "error" ||
    observation.reasons.some(
      (reason) =>
        reason.endsWith("_stale") ||
        reason.endsWith("_clock_ahead") ||
        reason === "database_unavailable",
    )
  );
}

export function advanceState(previous, observation, config, now) {
  const state = structuredClone(previous);
  if (state.lastObservationAt !== null && now < state.lastObservationAt) {
    throw new Error("clock_regressed");
  }
  const gap =
    state.lastObservationAt !== null && now - state.lastObservationAt > config.maxObservationGapMs;
  const observed = new Set(
    observation.severity === "error" ? ["collection_error"] : observation.reasons,
  );
  if (gap) observed.add("collection_gap");
  const unknownMetrics = missingObservation(observation);
  if (unknownMetrics) {
    for (const reason of observed) {
      if (
        !reason.startsWith("collection_") &&
        !reason.endsWith("_stale") &&
        !reason.endsWith("_clock_ahead") &&
        reason !== "database_unavailable"
      ) {
        observed.delete(reason);
      }
    }
  }
  for (const reason of observed) {
    if (!state.incidents.some((item) => item.reason === reason)) {
      state.incidents.push({
        reason,
        incidentId: randomUUID(),
        phase: "pending",
        firstSeenAt: now,
        lastSeenAt: now,
        recoverySince: null,
      });
    }
  }
  const retained = [];
  for (const item of state.incidents) {
    const missing = unknownMetrics && !item.reason.startsWith("collection_");
    if (missing && !observed.has(item.reason) && item.phase === "pending") continue;
    if (gap || (missing && !observed.has(item.reason))) {
      if (item.phase === "pending") item.firstSeenAt = now;
      if (item.phase === "recovering") item.phase = "firing";
      item.recoverySince = null;
    }
    if (observed.has(item.reason)) {
      item.lastSeenAt = now;
      item.recoverySince = null;
      if (item.phase === "recovering") item.phase = "firing";
      if (
        item.phase === "pending" &&
        (item.reason === "collection_gap" || now - item.firstSeenAt >= config.sustainMs)
      ) {
        item.phase = "firing";
        enqueue(state, item, "firing", now, config.maxQueue);
      }
    } else if (!missing) {
      if (item.phase === "pending") continue;
      item.phase = "recovering";
      item.recoverySince ??= now;
      if (now - item.recoverySince >= config.recoveryMs) {
        enqueue(state, item, "resolved", now, config.maxQueue);
        continue;
      }
    }
    retained.push(item);
  }
  state.incidents = retained;
  state.lastObservationAt = now;
  return stateSchema.parse(state);
}

export function monitorStatus(state, config, now = Date.now()) {
  const stale =
    state.lastTickAt === null ||
    now < state.lastTickAt ||
    now - state.lastTickAt > config.maxObservationGapMs;
  const exhausted = state.queue.some((item) => item.attempts >= config.maxAttempts);
  return {
    version: 1,
    targetId: state.targetId,
    severity: stale || state.queue.length || state.incidents.length ? "error" : "healthy",
    lastTickAt: state.lastTickAt,
    heartbeatStale: stale,
    activeReasons: state.incidents.map((item) => item.reason),
    pendingDeliveries: state.queue.length,
    oldestPendingAt: state.queue[0]?.occurredAt ?? null,
    deliveryExhausted: exhausted,
  };
}
