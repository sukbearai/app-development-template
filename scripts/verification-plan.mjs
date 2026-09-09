export const CORE_GATES = Object.freeze([
  "format:check",
  "sdk:check",
  "lint",
  "duplication:check",
  "boundary:check",
  "dependency:check",
  "supply-chain:check",
  "security:audit",
  "typecheck",
  "contract:check",
  "migration:check",
  "version:check",
  "docs:check",
  "test:tools",
  "test:unit",
  "test:integration",
  "build",
]);
export const FULL_GATES = Object.freeze([
  "storybook:test",
  "storybook:smoke",
  "test:tracing-collector",
  "test:monitor-collector",
  "test:deployment",
  "test:deployment:slots",
  "db:integration",
  "test:e2e",
  "test:ui",
  "test:ui:production",
  "test:async-recovery",
  "test:kafka-security",
]);
export const RELEASE_GATES = Object.freeze([
  ...CORE_GATES,
  ...FULL_GATES,
  "test:capacity",
  "test:backup",
  "test:app-backup",
  "test:containers",
]);

// The template command retains its own historical coverage; PR profiles also build and run API E2E.
export const TEMPLATE_GATES = Object.freeze([
  ...CORE_GATES.filter((gate) => gate !== "build"),
  "test:ui:production",
  "test:ui",
  "test:app-backup",
  "test:async-recovery",
  "test:kafka-security",
  "storybook:test",
  "storybook:smoke",
  "test:tracing-collector",
  "test:monitor-collector",
  "test:deployment",
  "test:deployment:slots",
]);
const GATE_SCHEDULING = {
  "format:check": { phase: 0 },
  "sdk:check": { phase: 0, dependencies: ["contract:check"] },
  lint: { phase: 0 },
  "duplication:check": { phase: 0 },
  "boundary:check": { phase: 0 },
  "dependency:check": { phase: 0 },
  "supply-chain:check": { phase: 0 },
  "security:audit": { phase: 0 },
  typecheck: { phase: 0 },
  "contract:check": { phase: 0 },
  "migration:check": { phase: 0 },
  "version:check": { phase: 0 },
  "docs:check": { phase: 0 },
  "test:tools": { phase: 1 },
  "test:unit": { phase: 2 },
  "test:integration": { phase: 3, resources: ["database"], priority: 1 },
  build: { phase: 3, resources: ["web"] },
  "storybook:test": { phase: 3, resources: ["web"], exclusive: true },
  "storybook:smoke": { phase: 3, resources: ["web"], exclusive: true },
  "test:tracing-collector": { phase: 3 },
  "test:monitor-collector": { phase: 3 },
  "test:deployment": { phase: 3 },
  "test:deployment:slots": { phase: 3 },
  "db:integration": { phase: 3, resources: ["database"] },
  "test:e2e": { phase: 3, resources: ["web"] },
  "test:ui": { phase: 3, resources: ["web"], exclusive: true },
  "test:ui:production": { phase: 3, resources: ["web"], exclusive: true },
  "test:async-recovery": { phase: 3, priority: 0 },
  "test:kafka-security": { phase: 3 },
  "test:capacity": { phase: 3, resources: ["web"], exclusive: true },
  "test:backup": { phase: 3, drainOnCancel: true },
  "test:app-backup": { phase: 3, drainOnCancel: true },
  "test:containers": { phase: 3 },
};
for (const [gate, scheduling] of Object.entries(GATE_SCHEDULING)) {
  GATE_SCHEDULING[gate] = Object.freeze({
    exclusive: false,
    drainOnCancel: false,
    priority: 2,
    ...scheduling,
    resources: Object.freeze(scheduling.resources ?? []),
    dependencies: Object.freeze(scheduling.dependencies ?? []),
  });
}
Object.freeze(GATE_SCHEDULING);

export function gateScheduling(gate) {
  if (!Object.keys(GATE_SCHEDULING).includes(gate))
    throw new Error(`Unknown verification gate: ${String(gate)}`);
  return GATE_SCHEDULING[gate];
}
export function gateCommand(gate, releaseOutput) {
  if (gate === "sdk:check")
    return { command: process.execPath, args: ["scripts/generate-sdk.mjs", "--check"] };
  return {
    command: "pnpm",
    args: gate === "test:containers" && releaseOutput ? [gate, "--export", releaseOutput] : [gate],
  };
}
