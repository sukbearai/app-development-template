#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export PSTACK_VERIFY_PORT="${PSTACK_VERIFY_PORT:-4173}"
if [[ ! "$PSTACK_VERIFY_PORT" =~ ^[0-9]+$ ]] || (( PSTACK_VERIFY_PORT < 1024 || PSTACK_VERIFY_PORT > 65535 )); then
  echo 'PSTACK_VERIFY_PORT must be an integer from 1024 to 65535.' >&2
  exit 2
fi
mkdir -p .verification/pstack-x
export PSTACK_VERIFY_OUTPUT
PSTACK_VERIFY_OUTPUT="$(mktemp -d "$PWD/.verification/pstack-x/run-XXXXXXXX")"
export PSTACK_VERIFY_STARTED_MS
PSTACK_VERIFY_STARTED_MS="$(node -p 'Date.now()')"
printf 'Evidence: %s\n' "$PSTACK_VERIFY_OUTPUT"
git status --short > "$PSTACK_VERIFY_OUTPUT/git-status.txt"
git diff --binary > "$PSTACK_VERIFY_OUTPUT/tracked.diff"
node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter(file => /\.(ts|tsx|mjs|json|yaml|yml)$/.test(file) && !file.startsWith("docs/analysis/"));
writeFileSync(process.env.PSTACK_VERIFY_OUTPUT + "/source-sha256.json", JSON.stringify(Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), null, 2));
'
set +e
pnpm exec playwright test --config .agents/skills/verify-pstack-x/scripts/playwright.config.mjs "$@" 2>&1 | tee "$PSTACK_VERIFY_OUTPUT/run.log"
result=${PIPESTATUS[0]}
set -e
printf '%s\n' "$result" > "$PSTACK_VERIFY_OUTPUT/exit-code.txt"
printf 'Evidence retained: %s\n' "$PSTACK_VERIFY_OUTPUT"
exit "$result"
