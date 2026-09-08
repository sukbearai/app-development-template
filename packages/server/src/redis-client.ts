import { z } from "zod";
import { createClient } from "redis";

const clients = new Map<string, Promise<ReturnType<typeof createClient>>>();
async function clientFor(url: string): Promise<ReturnType<typeof createClient>> {
  let pending = clients.get(url);
  if (pending) {
    const client = await pending;
    if (client.isOpen) return client;
    if (clients.get(url) === pending) clients.delete(url);
    return clientFor(url);
  }
  if (!pending) {
    const client = createClient({
      url,
      socket: { connectTimeout: 3000, reconnectStrategy: false },
      disableOfflineQueue: true,
    });
    client.on("error", () => {
      /* Callers receive command failures; credentials stay private. */
    });
    pending = client
      .connect()
      .then(() => client)
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections are arbitrary and are rethrown unchanged after cleanup.
      .catch((error: unknown) => {
        clients.delete(url);
        if (client.isOpen) client.destroy();
        throw error;
      });
    client.on("end", () => {
      if (clients.get(url) === pending) clients.delete(url);
    });
    clients.set(url, pending);
  }
  return pending;
}
export async function redisCommand(url: string, parts: string[]) {
  return (await clientFor(url)).sendCommand(parts, {
    abortSignal: AbortSignal.timeout(3000),
  });
}
export async function redisDel(url: string, key: string) {
  return redisCommand(url, ["DEL", key]);
}
export async function redisWindowCount(
  url: string,
  key: string,
  windowMs: number,
) {
  const value = await (await clientFor(url))
    .withAbortSignal(AbortSignal.timeout(3000))
    .eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
      { keys: [key], arguments: [String(windowMs)] },
    );
  const parsed = z.tuple([z.number(), z.number()]).rest(z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new Error("Invalid rate limit response");
  return { count: parsed.data[0], ttlMs: parsed.data[1] };
}
export async function closeRedis() {
  const pending = [...clients.values()];
  clients.clear();
  await Promise.all(
    pending.map(async (entry) => {
      const client = await entry.catch(() => undefined);
      if (client?.isOpen) client.destroy();
    }),
  );
}
