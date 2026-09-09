import {
  evaluateAsyncQuarantine,
  evaluateOutboxBacklog,
  readOutboxHealthThresholds,
  statusFromOutboxAlerts,
  type AsyncQuarantineCounts,
  type OutboxHealthThresholds,
} from "@pstack/contracts/outbox-health";
import { getAsyncRuntimeHealthRows } from "@pstack/database/repository";

type AsyncRuntimeOutboxEvent = {
  id?: string;
  count?: number;
  topic: string;
  status: string;
  createdAt: Date;
  lockedAt?: Date | null;
  staleCount?: number;
};

type AsyncRuntimeTask = {
  id?: string;
  count?: number;
  status: string;
};

export type AsyncRuntimeHealthAlert = {
  severity: "warning" | "critical";
  reason: string;
  message: string;
  metric?: string;
  value?: number;
  threshold?: number;
  topic?: string;
};

export type AsyncRuntimePlanSnapshot = {
  outboxIntervalMs: number;
  topics: string[];
  publisher: string;
  kafka: {
    brokersConfigured: number;
    clientId: string;
    consumerGroupId: string;
  };
  asyncTask: {
    defaultMaxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    idempotencyTtlHours: number;
  };
};

export type AsyncRuntimeOutboxTopicCounts = {
  topic: string;
  pending: number;
  processing: number;
  failed: number;
  deadLetter: number;
  published: number;
  total: number;
  oldestPendingAgeMs: number;
};

export type AsyncRuntimeTaskCounts = {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  deadLetter: number;
  canceled: number;
  total: number;
};

export type AsyncRuntimeHealthSnapshot = {
  service: "async-runtime";
  status: "ok" | "degraded" | "blocked";
  mode: "async_runtime_health";
  runtimePlan: AsyncRuntimePlanSnapshot;
  outboxByTopic: AsyncRuntimeOutboxTopicCounts[];
  tasks: AsyncRuntimeTaskCounts;
  alerts: AsyncRuntimeHealthAlert[];
  blockedReasons: string[];
  checkedAt: string;
};

function positiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function topicBucket(topic: string): AsyncRuntimeOutboxTopicCounts {
  return {
    topic,
    pending: 0,
    processing: 0,
    failed: 0,
    deadLetter: 0,
    published: 0,
    total: 0,
    oldestPendingAgeMs: 0,
  };
}

function emptyTaskCounts(): AsyncRuntimeTaskCounts {
  return {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    deadLetter: 0,
    canceled: 0,
    total: 0,
  };
}

export function buildRuntimePlanFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AsyncRuntimePlanSnapshot {
  const topics = (
    env.ASYNC_RUNTIME_TOPICS || "app.tasks,telemetry.events,files.events,audit.events"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const brokersConfigured = (env.KAFKA_BROKERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;

  return {
    outboxIntervalMs: positiveIntegerEnv("OUTBOX_POLL_INTERVAL_MS", 5000, env),
    topics,
    publisher: env.ASYNC_RUNTIME_PUBLISHER || env.OUTBOX_PUBLISHER || "unknown",
    kafka: {
      brokersConfigured,
      clientId: env.KAFKA_CLIENT_ID || "app-template-worker",
      consumerGroupId: env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer",
    },
    asyncTask: {
      defaultMaxAttempts: positiveIntegerEnv("ASYNC_TASK_DEFAULT_MAX_ATTEMPTS", 5, env),
      retryBaseMs: positiveIntegerEnv("ASYNC_TASK_RETRY_BASE_MS", 1000, env),
      retryMaxMs: positiveIntegerEnv("ASYNC_TASK_RETRY_MAX_MS", 300000, env),
      idempotencyTtlHours: positiveIntegerEnv("ASYNC_TASK_IDEMPOTENCY_TTL_HOURS", 168, env),
    },
  };
}

export function buildAsyncRuntimeHealthSnapshot(input: {
  outboxEvents: AsyncRuntimeOutboxEvent[];
  tasks: AsyncRuntimeTask[];
  quarantine: AsyncQuarantineCounts;
  runtimePlan: AsyncRuntimePlanSnapshot;
  now?: Date;
  staleLockMs?: number;
  thresholds?: OutboxHealthThresholds;
}): AsyncRuntimeHealthSnapshot {
  const now = input.now || new Date();
  const nowMs = now.getTime();
  const staleLockMs = input.staleLockMs ?? positiveIntegerEnv("OUTBOX_STALE_LOCK_MS", 300000);
  const alerts: AsyncRuntimeHealthAlert[] = evaluateAsyncQuarantine(input.quarantine);
  const topicMap = new Map<string, AsyncRuntimeOutboxTopicCounts>();

  function ensureTopic(topic: string) {
    let bucket = topicMap.get(topic);
    if (!bucket) {
      bucket = topicBucket(topic);
      topicMap.set(topic, bucket);
    }
    return bucket;
  }

  for (const topic of input.runtimePlan.topics) ensureTopic(topic);

  let staleLockCount = 0;
  for (const event of input.outboxEvents) {
    const bucket = ensureTopic(event.topic);
    const count = event.count ?? 1;
    bucket.total += count;
    staleLockCount += event.staleCount ?? 0;
    if (event.status === "pending") bucket.pending += count;
    else if (event.status === "processing") {
      bucket.processing += count;
      if (event.lockedAt && nowMs - event.lockedAt.getTime() > staleLockMs) {
        staleLockCount += 1;
      }
    } else if (event.status === "failed") bucket.failed += count;
    else if (event.status === "dead_letter") bucket.deadLetter += count;
    else if (event.status === "published") bucket.published += count;

    if (event.status === "pending" || event.status === "failed") {
      const age = Math.max(0, nowMs - event.createdAt.getTime());
      bucket.oldestPendingAgeMs = bucket.oldestPendingAgeMs
        ? Math.max(bucket.oldestPendingAgeMs, age)
        : age;
    }
  }

  const tasks = emptyTaskCounts();
  for (const task of input.tasks) {
    const count = task.count ?? 1;
    tasks.total += count;
    if (task.status === "pending") tasks.pending += count;
    else if (task.status === "running") tasks.running += count;
    else if (task.status === "succeeded") tasks.succeeded += count;
    else if (task.status === "failed") tasks.failed += count;
    else if (task.status === "dead_letter") tasks.deadLetter += count;
    else if (task.status === "canceled") tasks.canceled += count;
  }

  for (const bucket of topicMap.values()) {
    if (bucket.deadLetter > 0) {
      alerts.push({
        severity: "critical",
        reason: "async_topic_dead_letter",
        message: `Async topic ${bucket.topic} has dead letter outbox events.`,
        topic: bucket.topic,
        metric: "deadLetter",
        value: bucket.deadLetter,
        threshold: 0,
      });
    }
    if (bucket.failed > 0) {
      alerts.push({
        severity: "warning",
        reason: "async_topic_failed_backlog",
        message: `Async topic ${bucket.topic} has failed outbox events awaiting retry.`,
        topic: bucket.topic,
        metric: "failed",
        value: bucket.failed,
        threshold: 0,
      });
    }
  }

  const backlog = Array.from(topicMap.values()).reduce(
    (total, bucket) => ({
      pending: total.pending + bucket.pending,
      failed: total.failed + bucket.failed,
      oldestPendingAgeMs: Math.max(total.oldestPendingAgeMs, bucket.oldestPendingAgeMs),
    }),
    { pending: 0, failed: 0, oldestPendingAgeMs: 0 },
  );
  alerts.push(
    ...evaluateOutboxBacklog(backlog, input.thresholds ?? readOutboxHealthThresholds(process.env)),
  );

  if (staleLockCount > 0) {
    alerts.push({
      severity: "warning",
      reason: "outbox_stale_processing_lock",
      message: "Outbox processing locks exceeded the stale lock threshold.",
      metric: "staleLocks",
      value: staleLockCount,
      threshold: staleLockMs,
    });
  }

  if (tasks.deadLetter > 0) {
    alerts.push({
      severity: "critical",
      reason: "async_task_dead_letter",
      message: "Async tasks reached dead letter state and require investigation.",
      metric: "deadLetter",
      value: tasks.deadLetter,
      threshold: 0,
    });
  }

  if (tasks.failed > 0) {
    alerts.push({
      severity: "warning",
      reason: "async_task_failed",
      message: "Async tasks are in failed retry state.",
      metric: "failed",
      value: tasks.failed,
      threshold: 0,
    });
  }

  const status = statusFromOutboxAlerts(alerts);
  return {
    service: "async-runtime",
    status,
    mode: "async_runtime_health",
    runtimePlan: input.runtimePlan,
    outboxByTopic: Array.from(topicMap.values()).sort((left, right) =>
      left.topic.localeCompare(right.topic),
    ),
    tasks,
    alerts,
    blockedReasons: alerts
      .filter((alert) => alert.severity === "critical")
      .map((alert) => alert.reason),
    checkedAt: now.toISOString(),
  };
}

export async function readAdminAsyncRuntimeHealth() {
  const now = new Date();
  const staleLockMs = positiveIntegerEnv("OUTBOX_STALE_LOCK_MS", 300000);
  const rows = await getAsyncRuntimeHealthRows(undefined, new Date(now.getTime() - staleLockMs));
  return buildAsyncRuntimeHealthSnapshot({
    now,
    staleLockMs,
    outboxEvents: rows.outboxEvents,
    tasks: rows.tasks,
    quarantine: rows.quarantine,
    runtimePlan: buildRuntimePlanFromEnv(),
  });
}
