export type WebProcessLifecycle = {
  readonly draining: boolean;
  trackWork<T>(operation: () => Promise<T>): Promise<T>;
  registerCleanup(cleanup: () => void | Promise<void>): void;
};

const runtime: NodeJS.Process & { pstackWebLifecycle?: WebProcessLifecycle } = process;

export function trackWebWork<T>(operation: () => Promise<T>): Promise<T> {
  return runtime.pstackWebLifecycle?.trackWork(operation) ?? operation();
}

export function registerProcessCleanup(cleanup: () => void | Promise<void>) {
  runtime.pstackWebLifecycle?.registerCleanup(cleanup);
}

export function isWebDraining() {
  return runtime.pstackWebLifecycle?.draining ?? false;
}
