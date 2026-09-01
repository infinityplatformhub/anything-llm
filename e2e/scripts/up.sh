#!/usr/bin/env bash
# E2E stack lifecycle. Usage: up.sh [up|down|restart-app]
# - Separate compose project + 127.0.0.1 port binds (dev stack holds 3001)
# - fresh volume per run (`down -v`): onboarding runs exactly once per run
# - waits on /api/ping with timeout, no fixed sleeps
set -euo pipefail

COMMAND="${1:-up}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (worktree)
E2E="$ROOT/e2e"
export COMPOSE_PROJECT_NAME=aproof-e2e
export COMPOSE_FILE="$ROOT/docker/docker-compose.yml:$E2E/docker-compose.e2e.yml"
# Dev machine holds 5432; the e2e postgres publishes on 55434 instead.
export E2E_PG_PORT="${E2E_PG_PORT:-55434}"
APP_PORT="${E2E_APP_PORT:-3111}"

down() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$E2E/../e2e-storage"
}

case "$COMMAND" in
  down) down ;;
  restart-app)
    docker compose restart anything-llm >/dev/null
    ;;
  up)
    down
    mkdir -p "$ROOT/e2e-storage"
    # docker-compose.yml bind-mounts ./docker/.env into the container; create it.
    [ -f "$ROOT/docker/.env" ] || cp "$ROOT/docker/.env.example" "$ROOT/docker/.env"
    docker compose up -d --build >/dev/null
    echo "waiting for app on 127.0.0.1:$APP_PORT (first boot after migrate ~25-30s)"
    for i in $(seq 1 120); do
      if curl -sf -o /dev/null "http://127.0.0.1:$APP_PORT/api/ping"; then
        echo "app ready after ${i}s"
        exit 0
      fi
      sleep 1
    done
    echo "app failed to become ready in 120s" >&2
    docker compose logs --tail 50 anything-llm >&2 || true
    exit 1
    ;;
  *) echo "usage: $0 [up|down|restart-app]" >&2; exit 2 ;;
esac
