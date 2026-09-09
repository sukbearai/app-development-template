export const CORE_GATES = Object.freeze([
  "format:check",
  "sdk:check",
  "lint",
  "duplication:check",
  "boundary:check",
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
]);
const staticGates = new Set(CORE_GATES.slice(0, CORE_GATES.indexOf("test:tools")));
const webGates = new Set([
  "build",
  "test:e2e",
  "test:ui",
  "test:ui:production",
  "test:capacity",
  "storybook:test",
  "storybook:smoke",
]);
export function gateScheduling(gate) {
  const phase = staticGates.has(gate)
    ? 0
    : gate === "test:tools"
      ? 1
      : gate === "test:unit"
        ? 2
        : 3;
  const resources = [];
  if (webGates.has(gate)) resources.push("web");
  if (["test:integration", "db:integration"].includes(gate)) resources.push("database");
  return {
    phase,
    resources,
    exclusive: gate === "test:capacity",
    drainOnCancel: ["test:backup", "test:app-backup"].includes(gate),
    dependencies: gate === "sdk:check" ? ["contract:check"] : [],
  };
}
export function gateCommand(gate, releaseOutput) {
  if (gate === "sdk:check")
    return { command: process.execPath, args: ["scripts/generate-sdk.mjs", "--check"] };
  return {
    command: "pnpm",
    args: gate === "test:containers" && releaseOutput ? [gate, "--export", releaseOutput] : [gate],
  };
}
