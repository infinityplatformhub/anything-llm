#!/usr/bin/env bash
# check-locals-contract.sh — every response.locals.X a route reads is written by
# some middleware.
#
# Express fails at the read, not at the wiring: a route reading a key nothing
# writes throws "Cannot read properties of undefined" and 500s. Nothing catches
# it at boot, and a full green suite proves only that no test exercised that route.
#
# Issue #34: PR-3 rewrote validBrowserExtensionApiKey to write
# `locals.apiKeyContext`, but browserExtension.js:30 and :50 still read
# `locals.apiKey.id`. Both routes 500'd from that commit onward, through an
# 895-test green run, until a user hit /browser-extension/check.
#
# See code-standards.md §7.5.

set -uo pipefail
cd "$(dirname "$0")/.."

# Keys Express itself or a framework provides, never assigned in our source.
declare -a BUILTIN=()

# PENDING — a known break with a hotfix in flight. Reported, not failed, so this
# gate can land before the fix. DELETE the entry when #34 merges; an entry here
# without an open issue is a bug, not a waiver.
declare -a PENDING=(
)

writes=$(git grep -ohE 'locals\.[a-zA-Z_][a-zA-Z0-9_]* *=' -- 'server' \
  | sed -E 's/ *=$//' | sort -u)

fail=0
pendingcount=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  key=$(printf '%s' "$line" | grep -ohE 'locals\.[a-zA-Z_][a-zA-Z0-9_]*' | head -1)
  printf '%s\n' "$writes" | grep -qx "$key" && continue
  for b in ${BUILTIN+"${BUILTIN[@]}"}; do [ "$key" = "$b" ] && continue 2; done
  for pk in ${PENDING+"${PENDING[@]}"}; do
    if [ "$key" = "$pk" ]; then
      echo "PENDING: $key read at $line (fix in flight)"
      pendingcount=$((pendingcount + 1))
      continue 2
    fi
  done
  echo "UNWRITTEN: $key read at $line"
  fail=1
done < <(git grep -n --untracked -oE 'locals\.[a-zA-Z_][a-zA-Z0-9_]*' -- 'server/endpoints' 2>/dev/null | sort -u -t: -k1,1 -k3,3)

if [ "$fail" -ne 0 ]; then
  echo
  echo "A route reads a response.locals key no middleware assigns. Express throws at"
  echo "the read, so this 500s in production and stays green in a suite that does not"
  echo "exercise the route. Fix the read, or write the key where it is authenticated."
  exit 1
fi

if [ "$pendingcount" -ne 0 ]; then
  echo "check-locals-contract: $pendingcount known break(s) awaiting a merged fix — see §7.5"
  exit 0
fi

echo "check-locals-contract: clean"
