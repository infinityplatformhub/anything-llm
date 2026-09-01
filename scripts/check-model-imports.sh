#!/usr/bin/env bash
# check-model-imports.sh — a file that CALLS Model.method() must require Model.
#
# Catches the class of bug behind issue #24: a sweep removes an import that a
# remaining call site still needs. Node does not fail at load, so the route
# 500s at request time and only a user finds it.
#
# Exempt: the model's own definition file (models/eventLogs.js defines EventLogs).
# Not matched: bare "Model." without a call, so string literals like "User.Read"
# and prose in comments do not trip the gate.
#
# Exit 0 clean, 1 on any missing import.

set -uo pipefail
cd "$(dirname "$0")/.."

MODELS="${MODEL_IMPORT_GATE_MODELS:-EventLogs ApiKey SystemSettings Telemetry User Workspace Document WorkspaceChats Invite}"

fail=0
for model in $MODELS; do
  for file in $(git grep -l "\b${model}\.[a-zA-Z_]\+(" -- 'server/**/*.js' 2>/dev/null); do
    # the file that defines the model is exempt, however it is named
    grep -qE "^[[:space:]]*(const|let|var|class|function)[[:space:]]+${model}\\b" "$file" && continue

    hits=$(grep -nE "\b${model}\.[a-zA-Z_]+\(" "$file" | grep -vE ':[[:space:]]*//' | grep -vE ':[[:space:]]*\*')
    [ -z "$hits" ] && continue

    if ! grep -E "require\(" "$file" | grep -q "\b${model}\b"; then
      echo "MISSING IMPORT: ${model} in ${file}"
      printf '%s\n' "$hits" | head -3 | sed 's/^/    /'
      fail=1
    fi
  done
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "Each file above calls a model it does not require. Add the require, or"
  echo "delete the call — do not leave the call and assume a global."
  exit 1
fi

echo "check-model-imports: clean"
