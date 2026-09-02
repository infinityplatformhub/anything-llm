#!/usr/bin/env bash
# check-db-push.sh — a test database is built by `migrate deploy`, not `db push`.
#
# `db push` shapes the schema from schema.prisma without running migration files,
# so it skips every INSERT those files carry. Five migrations seed data (T-1 alone
# seeds 57 permission rows); a suite built with `db push` runs against an empty
# permissions table, where engine.evaluate() answers "unknown_action" for every
# action. Those suites pass. They would pass with the engine deleted.
#
# See code-standards.md §7.1a.
#
# ALLOWLIST: a test whose subject is the schema shape itself and which seeds its
# own rows. Every entry needs a reason — an entry without one is a bug, not a
# waiver.
ALLOWLIST=(
  # #138: the ONLY suite whose subject is the seed-only shape itself. Describe D
  # builds a database with `db push` and NO migrations on purpose, then runs
  # `node prisma/seed.js` — so the rows this gate protects are seeded, by the
  # seed, which is the thing under test. It caught a real defect that way:
  # seed.js wrote `category` and not `scope`, leaving `org.member` unscoped on
  # every seed-only database since #53.
  #
  # Safe because the same FILE also asserts the migrate-only and migrate+seed
  # shapes and diffs the three for equality. A `db push` suite that asserted
  # nothing about migrations would be the §7.1a bug; this one exists to compare
  # them.
  "server/__tests__/security/authorization/directorySyncPermission.test.js"
)

set -uo pipefail
cd "$(dirname "$0")/.."

allowed() {
  local f="$1"
  for a in ${ALLOWLIST+"${ALLOWLIST[@]}"}; do [ "$f" = "$a" ] && return 0; done
  return 1
}

fail=0
pending=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  if allowed "$file"; then
    pending=$((pending + 1))
    continue
  fi
  echo "DB PUSH: $line"
  fail=1
# --untracked: a newly written test is exactly the case this gate exists to catch,
# and plain git grep does not see it until someone stages the file.
# Match the CALL, not the words. `db push` as prose appears in comments explaining
# why a suite stopped using it — T-4a's conversion comments tripped the loose form,
# which is the gate crying wolf about the very fix it asked for.
done < <(git grep -n --untracked -E '"db",[[:space:]]*"push"|prisma[[:space:]]+db[[:space:]]+push|db:push' \
  -- 'server/__tests__' 2>/dev/null)

if [ "$fail" -ne 0 ]; then
  echo
  echo "Build the test database with: [\"migrate\", \"deploy\", \"--schema\", schema]"
  echo "db push skips migration INSERTs — the schema is right and the seed data is gone."
  exit 1
fi

if [ "$pending" -ne 0 ]; then
  echo "check-db-push: $pending allowlisted file(s) still on db push — see §7.1a"
  exit 0
fi

echo "check-db-push: clean"
