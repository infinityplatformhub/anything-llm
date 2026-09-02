#!/bin/bash

# APP_ROOT exists so this script can be run outside a container, against a stub
# tree, by __tests__/scripts/entrypointDispatch.test.js. In the image it is
# /app, exactly as the hardcoded paths were. Nothing else about the boot changes.
APP_ROOT="${APP_ROOT:-/app}"

# O2a (#74): command dispatch, and it must be the FIRST thing that runs.
#
# `docker compose run --rm --no-deps anything-llm doctor` was documented before
# it existed: the ENTRYPOINT is exec-form and never read "$@", so the word
# `doctor` was dropped and the full server booted instead — an operator reads a
# booting app as a passing check, which is worse than an error.
#
# `exec` is required, not stylistic: the serve path below ends with
# `wait -n; exit $?`, so without exec the doctor's exit code is discarded and a
# blocking failure reports success.
#
# Before the STORAGE_DIR banner (ruling 5), so a doctor run answers the question
# asked instead of leading with 14 lines of warning about a container that is
# not going to serve anything.
# O5b (#94): the doctor's own flags are forwarded. `shift` drops the command
# word, `"$@"` passes the rest, so `doctor --bundle` reaches the script instead
# of running the plain checklist and silently ignoring the flag — the same
# failure the dispatch above exists to fix, one argument further along.
case "${1:-serve}" in
  doctor)
    shift
    exec node "$APP_ROOT/server/scripts/doctor.js" "$@"
    ;;
  serve|"")
    ;;
  *)
    echo "unknown command: $1 (expected 'doctor' or 'serve')" >&2
    exit 64
    ;;
esac

# Check if STORAGE_DIR is set
if [ -z "$STORAGE_DIR" ]; then
    echo "================================================================"
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo ""
    echo "Not setting this will result in data loss on container restart since"
    echo "the application will not have a persistent storage location."
    echo "It can also result in weird errors in various parts of the application."
    echo ""
    echo "Please configure persistent storage before running this container."
    echo ""
    echo "⚠️  ⚠️  ⚠️  WARNING: STORAGE_DIR environment variable is not set! ⚠️  ⚠️  ⚠️"
    echo "================================================================"
fi

{
  cd "$APP_ROOT/server/" &&
    until node -e 'const {Client}=require("pg"); const client=new Client({connectionString:process.env.DATABASE_URL}); client.connect().then(()=>client.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))'; do
      echo "Waiting for PostgreSQL..."
      sleep 2
    done &&
    # O2a: secrets first, then the preflight, then migrations.
    #
    # ensure-secrets before the doctor, or `secrets.present` fails on every
    # fresh install. The doctor before `migrate deploy`, because #61's migration
    # creates a pg_trgm index and a CREATE EXTENSION that fails leaves the
    # database in a failed-migration state that blocks every later migration
    # (§7.13) — after the migration the doctor is a post-mortem of the failure
    # it exists to prevent. Both are `&&`-chained, so a blocking finding stops
    # the boot instead of warning and continuing.
    node "$APP_ROOT/server/scripts/ensure-secrets.js" &&
    node "$APP_ROOT/server/scripts/doctor.js" &&
    # Disable Prisma CLI telemetry (https://www.prisma.io/docs/orm/tools/prisma-cli#how-to-opt-out-of-data-collection)
    export CHECKPOINT_DISABLE=1 &&
    npx prisma generate --schema="$APP_ROOT/server/prisma/schema.prisma" &&
    npx prisma migrate deploy --schema="$APP_ROOT/server/prisma/schema.prisma" &&
    node "$APP_ROOT/server/index.js"
} &
{ node "$APP_ROOT/collector/index.js"; } &
wait -n
exit $?
