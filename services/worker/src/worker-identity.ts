import { randomUUID } from "node:crypto";

const instanceId = `worker-${randomUUID()}`;

export function workerIdentity(explicit = process.env.WORKER_ID): string {
  return explicit || instanceId;
}
