#!/usr/bin/env bash
# check-local.sh — repo-owned checks, runnable before you push.
#
# These are OUR standards (docs/superpowers/design/code-standards.md), separate
# from `task.sh check`, which enforces the program-wide gates. Run both.
#
# Exit 0 clean, 1 if any check fails. Every check runs; failures accumulate so
# one run tells you everything, not just the first thing.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

run() {
  echo "=== $1"
  shift
  "$@" || fail=1
  echo
}

run "model imports (§5.1)" ./scripts/check-model-imports.sh
run "test db build (§7.1a)" ./scripts/check-db-push.sh
run "locals contract (§7.5)" ./scripts/check-locals-contract.sh

if [ "$fail" -ne 0 ]; then
  echo "check-local: FAILED"
  exit 1
fi

echo "check-local: all checks passed"
