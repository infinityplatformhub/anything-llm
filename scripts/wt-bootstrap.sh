#!/bin/bash
# Worktree bootstrap (§7.6b/§7.1c/§7.1b): fresh deps + fresh DB + migrate + seed + generate.
# usage: scripts/wt-bootstrap.sh <db-name>   (run from the worktree root)
set -euo pipefail
DB="${1:?db name}"
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node -v | grep -q '^v22' || { echo "need node 22 on PATH" >&2; exit 1; }
# #122: connection_limit caps the Prisma pool at 5 instead of its default
# num_cpus*2+1 (37 here). The pool is LAZY — it holds 2 connections until load
# arrives and only then grows — so this costs nothing on a quiet suite and
# bounds the ones doing heavy parallel work, which are the ones that crowd
# other worktrees off a 100-connection server. Measured: 38 connections without
# it, 6 with it, and 60 concurrent queries take 49 ms either way.
export DATABASE_URL="postgresql://approof:approof@localhost:5432/$DB?connection_limit=5"
export API_KEY_PEPPER="${API_KEY_PEPPER:-0123456789abcdef0123456789abcdef0123456789}"
export STORAGE_DIR="${STORAGE_DIR:-$PWD/server/storage}"
[ -L server/node_modules ] && { echo "server/node_modules is a symlink — remove it (§7.6b)" >&2; exit 1; }
psql -U approof -h localhost -d postgres -qc "DROP DATABASE IF EXISTS \"$DB\";" -c "CREATE DATABASE \"$DB\";"
( cd server && yarn install --frozen-lockfile --silent && ./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/prisma generate && node prisma/seed.js )
echo "OK node=$(node -v) DB=$DB; export DATABASE_URL API_KEY_PEPPER STORAGE_DIR as above"
