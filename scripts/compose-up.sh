#!/bin/sh
# Brings docker-compose.yml's stack up with the migration-before-API
# ordering guarantee, using the sequence verified in docs/runbook.md
# ("Bringing the stack up under podman-compose").
#
# Why this script exists: a bare `podman-compose up -d --build` does not
# reliably run `migrate` to completion before `api` starts under
# podman-compose 1.5 (see the comment on `api`'s `depends_on` in
# docker-compose.yml). The workaround requires `--no-deps` on the last step,
# which also drops `caddy`'s wait for `api`'s healthcheck — so this script
# additionally polls `api` until healthy before it exits, restoring that
# guarantee too. This is the one command to run; do not hand-type the
# sequence it encodes.
#
# Fails loudly (non-zero exit, and prints the failing service's logs) on the
# first step that does not succeed — it never proceeds past a failed build,
# a postgres that never turns healthy, a migrate that exits non-zero, or an
# api that never turns healthy.
#
# Usage: scripts/compose-up.sh
# Env overrides: COMPOSE (compose binary, default podman-compose),
#   POSTGRES_TIMEOUT, API_TIMEOUT (seconds to wait for healthy, default 60)

set -eu

cd "$(dirname "$0")/.."

COMPOSE=${COMPOSE:-podman-compose}
PROJECT=$(basename "$PWD")
POSTGRES_TIMEOUT=${POSTGRES_TIMEOUT:-60}
API_TIMEOUT=${API_TIMEOUT:-60}

# Finds the container podman-compose created for a given service, by the
# compose labels it sets on every container it creates. More reliable than
# guessing the container name, which depends on the project name.
container_for_service() {
  service="$1"
  podman ps -a \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=${service}" \
    --format '{{.Names}}' | head -n1
}

# Polls a service's container until its healthcheck reports "healthy", or
# fails loudly after $2 seconds.
wait_healthy() {
  service="$1"
  timeout="$2"
  elapsed=0
  while true; do
    cid=$(container_for_service "$service")
    if [ -n "$cid" ]; then
      status=$(podman inspect "$cid" --format '{{.State.Health.Status}}' 2>/dev/null || true)
      if [ "$status" = "healthy" ]; then
        echo "==> $service is healthy"
        return 0
      fi
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "FATAL: $service did not become healthy within ${timeout}s" >&2
      "$COMPOSE" logs "$service" >&2 || true
      exit 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

echo "==> Building images"
"$COMPOSE" build

echo "==> Starting postgres"
"$COMPOSE" up -d postgres

echo "==> Waiting for postgres to report healthy"
wait_healthy postgres "$POSTGRES_TIMEOUT"

echo "==> Running migrations (blocking until migrate exits)"
if ! "$COMPOSE" up migrate; then
  echo "FATAL: podman-compose up migrate failed" >&2
  "$COMPOSE" logs migrate >&2 || true
  exit 1
fi

# podman-compose's own exit code for a one-shot service is not trusted here
# on principle — the whole reason this script exists is that podman-compose
# 1.5's dependency/completion handling has proven unreliable. Check the
# container's real exit code directly.
migrate_cid=$(container_for_service migrate)
if [ -z "$migrate_cid" ]; then
  echo "FATAL: could not find the migrate container after running it" >&2
  exit 1
fi
migrate_exit=$(podman inspect "$migrate_cid" --format '{{.State.ExitCode}}')
if [ "$migrate_exit" != "0" ]; then
  echo "FATAL: migrate exited with code $migrate_exit" >&2
  "$COMPOSE" logs migrate >&2 || true
  exit 1
fi
echo "==> migrate exited 0"

echo "==> Starting api and caddy (--no-deps: migrate already ran above, and this avoids re-running it and re-triggering the race)"
"$COMPOSE" up -d --no-deps api caddy

echo "==> Waiting for api to report healthy (restores the availability guarantee --no-deps drops from caddy's depends_on)"
wait_healthy api "$API_TIMEOUT"

echo "==> Stack is up: postgres healthy, migrate exited 0, api healthy, caddy started"
"$COMPOSE" ps
