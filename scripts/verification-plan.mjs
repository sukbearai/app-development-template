export const CORE_GATES = Object.freeze(['lint', 'duplication:check', 'boundary:check', 'typecheck', 'contract:check', 'migration:check', 'version:check', 'docs:check', 'test:tools', 'test:unit', 'test:integration', 'build']);
export const FULL_GATES = Object.freeze(['db:integration', 'test:e2e', 'test:ui', 'test:ui:production', 'test:async-recovery', 'test:kafka-security']);
export const RELEASE_GATES = Object.freeze([...CORE_GATES, ...FULL_GATES, 'test:capacity', 'test:backup', 'test:app-backup', 'test:containers']);
