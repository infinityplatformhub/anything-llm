#!/bin/bash
# Worktree bootstrap (§7.6b/§7.1c/§7.1b): fresh deps + fresh DB + migrate + seed + generate.
# usage: scripts/wt-bootstrap.sh <db-name>   (run from the worktree root)
set -euo pipefail
DB="${1:?db name}"
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node -v | grep -q '^v22' || { echo "need node 22 on PATH" >&2; exit 1; }
export DATABASE_URL="postgresql://approof:approof@localhost:5432/$DB"
export API_KEY_PEPPER="${API_KEY_PEPPER:-0123456789abcdef0123456789abcdef0123456789}"
export STORAGE_DIR="${STORAGE_DIR:-$PWD/server/storage}"
[ -L server/node_modules ] && { echo "server/node_modules is a symlink — remove it (§7.6b)" >&2; exit 1; }
psql -U approof -h localhost -d postgres -qc "DROP DATABASE IF EXISTS \"$DB\";" -c "CREATE DATABASE \"$DB\";"
( cd server && yarn install --frozen-lockfile --silent && ./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/prisma generate && node prisma/seed.js )
echo "OK node=$(node -v) DB=$DB; export DATABASE_URL API_KEY_PEPPER STORAGE_DIR as above"
