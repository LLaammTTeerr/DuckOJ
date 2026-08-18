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
# Task 14 added `redis`, `judged` and `judge` to the stack and extended this
# script to cover them with the same bounded-poll pattern, rather than
# reintroducing a bare `podman-compose up -d` for the new services (see
# task-14-brief.md addendum E7). `judged` depends on `migrate` and `redis`
# the same way `api` depends on `migrate`, so it is started alongside `api`
# (both via the same `--no-deps` step) and polled for healthy the same way.
# This script still starts `judge` only after `judged` is confirmed
# healthy, purely so the bring-up log evidence shows a clean first-attempt
# handshake rather than a retry backoff — `judge` itself does not require
# this ordering (see addendum E6).
#
# Task 13 gave `judge` its own healthcheck (judge-agent's `/healthz`,
# started and supervised inside the same container — see
# judge/entrypoint.sh) and, per that task's Controller addendum C3, this
# script now waits on it with `wait_healthy` — the shape that fails loudly
# on timeout whether or not the container was ever found — instead of the
# older `wait_running`, which returned success on a container that was
# never found at all (a bug Phase 1 fixed for exactly this reason, and one
# a bring-up script for `judge` must not reintroduce).
#
# Fails loudly (non-zero exit, and prints the failing service's logs) on the
# first step that does not succeed — it never proceeds past a failed build,
# a postgres/redis that never turns healthy, a migrate that exits non-zero,
# or an api/judged/judge that never turns healthy.
#
# Usage: scripts/compose-up.sh
# Env overrides: COMPOSE (compose binary, default podman-compose),
#   POSTGRES_TIMEOUT, REDIS_TIMEOUT, API_TIMEOUT, JUDGED_TIMEOUT, JUDGE_TIMEOUT
#   (seconds to wait for healthy, default 60), MIGRATE_TIMEOUT (seconds to
#   bound `up migrate` itself, default 120 — see the comment above that call
#   for why this exists)

set -eu

cd "$(dirname "$0")/.."

COMPOSE=${COMPOSE:-podman-compose}
PROJECT=$(basename "$PWD")
POSTGRES_TIMEOUT=${POSTGRES_TIMEOUT:-60}
REDIS_TIMEOUT=${REDIS_TIMEOUT:-60}
API_TIMEOUT=${API_TIMEOUT:-60}
JUDGED_TIMEOUT=${JUDGED_TIMEOUT:-60}
JUDGE_TIMEOUT=${JUDGE_TIMEOUT:-60}
MIGRATE_TIMEOUT=${MIGRATE_TIMEOUT:-120}

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

echo "==> Starting postgres and redis"
"$COMPOSE" up -d postgres redis

echo "==> Waiting for postgres to report healthy"
wait_healthy postgres "$POSTGRES_TIMEOUT"

echo "==> Waiting for redis to report healthy"
wait_healthy redis "$REDIS_TIMEOUT"

echo "==> Running migrations (blocking until migrate exits)"
# --no-deps: without it, podman-compose also tries to bring up `migrate`'s
# dependency (postgres, already started and gated healthy above) before
# running it. Observed hanging indefinitely on that dependency resolution —
# `podman-compose up migrate` sitting for 10+ minutes with no progress and no
# timeout, wedging this entire script — with a "container already in use" /
# "has dependent containers" error in its own output where it tried to
# recreate the already-running `postgres` container. `--no-deps` is already
# used below for exactly this reason (api/judged/caddy); migrate gets it too.
# `--no-deps` is the actual fix for the hang above; `timeout` is a second,
# independent line of defense so that if this (or some other) dependency
# resolution wedge recurs, the script fails loudly on its own instead of
# sitting silently until whatever is driving it gives up and kills it by hand.
if ! timeout "${MIGRATE_TIMEOUT}s" "$COMPOSE" up --no-deps migrate; then
  echo "FATAL: podman-compose up migrate failed (or exceeded ${MIGRATE_TIMEOUT}s)" >&2
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

echo "==> Starting api, judged and caddy (--no-deps: migrate/redis already up above, and this avoids re-running migrate and re-triggering the race)"
"$COMPOSE" up -d --no-deps api judged caddy

echo "==> Waiting for api to report healthy (restores the availability guarantee --no-deps drops from caddy's depends_on)"
wait_healthy api "$API_TIMEOUT"

echo "==> Waiting for judged to report healthy"
wait_healthy judged "$JUDGED_TIMEOUT"

echo "==> Starting judge (after judged is healthy, so the bring-up log shows a clean first-attempt handshake rather than a retry backoff — judge itself does not require this ordering, see addendum E6)"
"$COMPOSE" up -d --no-deps judge

echo "==> Waiting for judge to report healthy (its judge-agent's own /healthz — see judge/entrypoint.sh)"
wait_healthy judge "$JUDGE_TIMEOUT"

echo "==> Stack is up: postgres healthy, redis healthy, migrate exited 0, api healthy, judged healthy, judge healthy, caddy started"
"$COMPOSE" ps
