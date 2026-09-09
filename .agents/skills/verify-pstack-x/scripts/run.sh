#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export PSTACK_VERIFY_PORT="${PSTACK_VERIFY_PORT:-4173}"
if [[ ! "$PSTACK_VERIFY_PORT" =~ ^[0-9]+$ ]] || (( PSTACK_VERIFY_PORT < 1024 || PSTACK_VERIFY_PORT > 65535 )); then
  echo 'PSTACK_VERIFY_PORT must be an integer from 1024 to 65535.' >&2
  exit 2
fi
PSTACK_VERIFY_EVIDENCE_DIR="$(node scripts/verification-output.mjs pstack-x)"
mkdir -p "$PSTACK_VERIFY_EVIDENCE_DIR"
export PSTACK_VERIFY_OUTPUT
PSTACK_VERIFY_OUTPUT="$(mktemp -d "$PSTACK_VERIFY_EVIDENCE_DIR/run-XXXXXXXX")"
export PSTACK_VERIFY_STARTED_MS
PSTACK_VERIFY_STARTED_MS="${PSTACK_VERIFY_STARTED_MS:-$(node -p 'Date.now()')}"
printf 'Evidence: %s\n' "$PSTACK_VERIFY_OUTPUT"
git status --short > "$PSTACK_VERIFY_OUTPUT/git-status.txt"
git diff --binary > "$PSTACK_VERIFY_OUTPUT/tracked.diff"
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { sourceHashes } from "./.agents/skills/verify-pstack-x/scripts/identity.mjs";
writeFileSync(process.env.PSTACK_VERIFY_OUTPUT + "/source-sha256.json", JSON.stringify(sourceHashes(process.cwd()), null, 2));
'
set +e
pnpm exec playwright test --config .agents/skills/verify-pstack-x/scripts/playwright.config.mjs "$@" 2>&1 | tee "$PSTACK_VERIFY_OUTPUT/run.log"
result=${PIPESTATUS[0]}
set -e
printf '%s\n' "$result" > "$PSTACK_VERIFY_OUTPUT/exit-code.txt"
printf 'Evidence retained: %s\n' "$PSTACK_VERIFY_OUTPUT"
exit "$result"
