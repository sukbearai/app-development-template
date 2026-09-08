export function createWebLifecycle() {
  let draining = false;
  const active = new Set();
  const cleanup = new Set();
  return {
    get draining() { return draining; },
    beginDrain() { draining = true; },
    async trackWork(operation) {
      if (draining) throw new Error("Web is draining");
      const pending = Promise.resolve().then(operation);
      active.add(pending);
      try { return await pending; }
      finally { active.delete(pending); }
    },
    registerCleanup(dispose) { cleanup.add(dispose); },
    async drain() {
      while (active.size) await Promise.allSettled([...active]);
      const results = await Promise.allSettled([...cleanup].map(dispose => Promise.resolve().then(dispose)));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Web resource cleanup failed');
    },
  };
}
