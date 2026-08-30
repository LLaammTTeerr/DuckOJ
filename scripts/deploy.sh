#!/bin/sh
# Deploys one or more services from a CLEAN export of HEAD, and refuses to
# leave a broken one running.
#
# Usage:  scripts/deploy.sh api            # one service
#         scripts/deploy.sh api judged web-less-things...
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# On 2026-08-30 an api deploy shipped a build whose every worker died at boot.
# The recreate "succeeded", `podman ps` said `Up`, and the site was down for
# fifteen minutes before anyone looked at a route. Three separate habits let
# that through, and this script is the three fixes:
#
#   1. **The image came from a dirty tree.** The loop's own ledger records
#      "api rebuilt from a clean HEAD export" three times, done by hand each
#      time, because another agent had uncommitted work on main. Done by hand
#      it is done sometimes. Here it is the only way the script builds:
#      `git archive HEAD` into a scratch directory, and the build context is
#      that directory. What ships is what is committed.
#   2. **Nobody polled a real route.** The first `healthy` was trusted. This
#      polls for HEALTH_POLL_SECONDS and requires, at the end of it: every
#      deployed container healthy, `GET /api/v1/languages` answering 200
#      THROUGH CADDY (the whole path a browser takes), and no worker
#      re-fork/`cannot boot` lines in the last REFORK_WINDOW_SECONDS of the
#      api container's log. A crash-looping api satisfies none of the three.
#   3. **There was nothing to go back to.** The previous image is tagged
#      `:previous` before the build, and a failed poll retags it back to
#      `:latest`, recreates, prints the logs, and exits non-zero.
#
# Migrations run FIRST, and only when they need to: `packages/db/migrations`
# is compared against the sha in `.deploy/last-deploy` (gitignored, written
# only after a deploy that passed). No marker, or a marker naming a commit
# this repo no longer has, means "run them" — a migration applied twice is a
# no-op the journal skips, and a migration skipped once is the schema drift
# `scripts/compose-up.sh` exists to prevent.
#
# NOT a replacement for scripts/compose-up.sh. That brings the WHOLE stack up
# from nothing, in the order podman-compose cannot be trusted to work out.
# This changes some services on a stack that is already running.
#
# ---------------------------------------------------------------------------
# ENV OVERRIDES (defaults in parentheses)
#   COMPOSE_PROJECT_NAME  compose project (the repo directory name). EXPORTED,
#                     so the image tags this script computes, the label lookup
#                     and every compose call cannot disagree — restore.sh's
#                     finding M4 was exactly that disagreement, and building
#                     in an export directory would reintroduce it by another
#                     door: podman-compose names images `<project>_<service>`
#                     from its WORKING DIRECTORY unless told otherwise, so a
#                     build in /tmp/xyz would tag `xyz_api` and the recreate
#                     would quietly keep serving the old `duckoj_api`.
#   COMPOSE           compose binary (podman-compose)
#   PODMAN            podman binary (podman)
#   CURL              curl binary (curl)
#   PROBE_URL         the route to poll (https://localhost:8443/api/v1/languages)
#   HEALTH_POLL_SECONDS   how long to watch after the recreate (45)
#   POLL_INTERVAL_SECONDS how often, inside that (3)
#   REFORK_WINDOW_SECONDS how far back in the api log to look (30)
#   MIGRATE_TIMEOUT   seconds to bound the migrate step (120), as compose-up.sh
#   DEPLOY_STATE_DIR  where the marker lives ($REPO/.deploy)
#   EXPORT_DIR        where HEAD is exported (a fresh mktemp -d, removed after)
#   SKIP_MIGRATE=1    do not migrate whatever the marker says
#   FORCE_MIGRATE=1   migrate whatever the marker says
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"

if [ $# -lt 1 ]; then
  echo "usage: $0 <service> [service...]" >&2
  exit 64
fi
SERVICES="$*"

PROJECT=${COMPOSE_PROJECT_NAME:-$(basename "$REPO")}
export COMPOSE_PROJECT_NAME="$PROJECT"
COMPOSE=${COMPOSE:-podman-compose}
PODMAN=${PODMAN:-podman}
CURL=${CURL:-curl}
PROBE_URL=${PROBE_URL:-https://localhost:8443/api/v1/languages}
HEALTH_POLL_SECONDS=${HEALTH_POLL_SECONDS:-45}
POLL_INTERVAL_SECONDS=${POLL_INTERVAL_SECONDS:-3}
REFORK_WINDOW_SECONDS=${REFORK_WINDOW_SECONDS:-30}
MIGRATE_TIMEOUT=${MIGRATE_TIMEOUT:-120}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-$REPO/.deploy}
MARKER="$DEPLOY_STATE_DIR/last-deploy"

HEAD_SHA=$(git rev-parse HEAD)

# The scratch export. Removed on every exit path, including the rollback one —
# but only when this script made it. A directory the caller named is the
# caller's (scripts/test/deploy.test.sh inspects it afterwards to prove the
# build context really was the export and not the working tree).
if [ -n "${EXPORT_DIR:-}" ]; then
  OWN_EXPORT_DIR=0
  mkdir -p "$EXPORT_DIR"
else
  EXPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/duckoj-deploy-XXXXXX")
  OWN_EXPORT_DIR=1
fi
cleanup() {
  if [ "${OWN_EXPORT_DIR:-0}" = "1" ]; then rm -rf "$EXPORT_DIR"; fi
}
trap cleanup EXIT INT TERM

# The same helper compose-up.sh, backup.sh and restore.sh use. `ps -a`, not
# running-only: the migrate step inspects its container's exit code after it
# has exited, and a service that crashed must still be findable for its logs.
container_for_service() {
  "$PODMAN" ps -a \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.Names}}' | head -n1
}

# The image podman-compose builds for a service, exactly as it names it.
image_for_service() {
  echo "localhost/${PROJECT}_$1"
}

# True when `docker-compose.yml` gives this service a `build:` — i.e. when
# there is an image of ours to tag, build and roll back. `caddy`, `postgres`
# and `redis` are registry images: they are recreated like anything else, but
# there is no `:previous` of theirs to keep, and tagging one would be a lie.
service_builds() {
  awk -v want="$1" '
    /^services:/ { inside = 1; next }
    inside && /^[^ #]/ { inside = 0 }
    inside && /^  [A-Za-z0-9_.-]+:/ { cur = $1; sub(/:$/, "", cur); next }
    inside && cur == want && /^    build:/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$REPO/docker-compose.yml"
}

say() { echo "==> $*"; }
die() {
  echo "FATAL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
say "deploying [$SERVICES] from $HEAD_SHA (project $PROJECT)"

for service in $SERVICES; do
  grep -q "^  ${service}:" "$REPO/docker-compose.yml" ||
    die "no service '${service}' in docker-compose.yml"
done

# --- 1. tag the running images :previous -----------------------------------
# BEFORE the build, because the build is what overwrites `:latest`. A service
# with no image yet (a first deploy) simply has no `:previous`, and the
# rollback below says so rather than pretending.
ROLLBACKABLE=""
for service in $SERVICES; do
  service_builds "$service" || continue
  image=$(image_for_service "$service")
  if "$PODMAN" image exists "${image}:latest" 2>/dev/null; then
    "$PODMAN" tag "${image}:latest" "${image}:previous" ||
      die "could not tag ${image}:previous — refusing to build without a way back"
    ROLLBACKABLE="$ROLLBACKABLE $service"
    say "kept ${image}:latest as :previous"
  else
    say "no existing ${image}:latest — this deploy has nothing to roll back to"
  fi
done

# --- 2. export HEAD and build from it --------------------------------------
# `git archive`, not the working tree: an uncommitted edit — anyone's, in any
# file the Dockerfile copies — must not reach a container. This is the whole
# reason the script owns the build instead of documenting it.
say "exporting $HEAD_SHA to $EXPORT_DIR"
git archive "$HEAD_SHA" | tar -x -C "$EXPORT_DIR"
# `set -e` says nothing about the left-hand side of a pipe, so the extraction
# is checked rather than assumed: an empty archive would otherwise be built
# into an image made of nothing.
[ -f "$EXPORT_DIR/docker-compose.yml" ] || die "the export of $HEAD_SHA is empty"

# `.env` is deliberately NOT in the archive (it holds the secrets, and
# .gitignore says so), but compose interpolates every `${...}` in the file
# before it does anything at all — including for services it is not building.
# Without this, the build in the export directory fails on
# `POSTGRES_PASSWORD:?set POSTGRES_PASSWORD`.
if [ -f "$REPO/.env" ]; then
  cp "$REPO/.env" "$EXPORT_DIR/.env"
else
  say "no .env in $REPO — compose will use its own defaults"
fi

BUILDABLE=""
for service in $SERVICES; do
  if service_builds "$service"; then BUILDABLE="$BUILDABLE $service"; fi
done

# --- 3. migrate first, when the migrations actually moved ------------------
# Read before the build so a failure here costs nothing, applied after it so
# the migrate image is the one being deployed.
migrations_changed() {
  if [ "${FORCE_MIGRATE:-0}" = "1" ]; then
    say "FORCE_MIGRATE=1 — migrating"
    return 0
  fi
  if [ "${SKIP_MIGRATE:-0}" = "1" ]; then
    say "SKIP_MIGRATE=1 — not migrating"
    return 1
  fi
  if [ ! -f "$MARKER" ]; then
    say "no deploy marker at $MARKER — migrating"
    return 0
  fi
  last=$(cat "$MARKER")
  if ! git cat-file -e "${last}^{commit}" 2>/dev/null; then
    say "marker names $last, which this repo does not have — migrating"
    return 0
  fi
  if [ -n "$(git diff --name-only "$last" "$HEAD_SHA" -- packages/db/migrations)" ]; then
    say "packages/db/migrations changed since $last — migrating"
    return 0
  fi
  say "packages/db/migrations unchanged since $last — skipping migrate"
  return 1
}

MIGRATE=0
if migrations_changed; then MIGRATE=1; fi

if [ "$MIGRATE" = "1" ] && ! echo " $BUILDABLE " | grep -q " migrate "; then
  # The migrate image is built from apps/api/Dockerfile, so it carries the
  # migration files themselves. Deploying a schema change without rebuilding
  # it runs the PREVIOUS build's migrations and exits 0 — compose-up.sh's
  # "stale-image silent reseed", which is a success message over a database
  # missing every migration since that container was created.
  BUILDABLE="$BUILDABLE migrate"
  say "adding 'migrate' to the build — its image carries the migration files"
fi

if [ -n "$BUILDABLE" ]; then
  say "building$BUILDABLE from the export (never the working tree)"
  # shellcheck disable=SC2086
  (cd "$EXPORT_DIR" && "$COMPOSE" build $BUILDABLE) || die "build failed"
else
  say "nothing to build (registry images only)"
fi

if [ "$MIGRATE" = "1" ]; then
  say "running migrations"
  # --no-deps and --force-recreate for compose-up.sh's reasons, which are
  # written out there in full: podman-compose hangs resolving an
  # already-running dependency, and reuses an exited container rather than
  # recreating it from the newer image.
  if ! timeout "${MIGRATE_TIMEOUT}s" "$COMPOSE" up --no-deps --force-recreate migrate; then
    "$COMPOSE" logs migrate >&2 || true
    die "migrate failed (or exceeded ${MIGRATE_TIMEOUT}s) — nothing was recreated"
  fi
  migrate_cid=$(container_for_service migrate)
  [ -n "$migrate_cid" ] || die "could not find the migrate container after running it"
  migrate_exit=$("$PODMAN" inspect "$migrate_cid" --format '{{.State.ExitCode}}')
  if [ "$migrate_exit" != "0" ]; then
    "$COMPOSE" logs migrate >&2 || true
    die "migrate exited $migrate_exit — nothing was recreated"
  fi
  say "migrate exited 0"
fi

# --- 4. recreate ------------------------------------------------------------
# From the REPO directory, not the export: `caddy`'s bind mounts
# (./Caddyfile, ./apps/web/dist) resolve relative to the compose file, and
# mounting a scratch copy that is about to be deleted would serve the site
# out of /tmp until the next recreate.
recreate() {
  # shellcheck disable=SC2086
  "$COMPOSE" up -d --no-deps --force-recreate $SERVICES
}

say "recreating [$SERVICES]"
recreate || die "recreate failed"

# --- 5. watch it ------------------------------------------------------------
# `<no value>` is what podman prints for a service with no healthcheck block
# (caddy has none): for those the question is only whether the container is
# running, and claiming health it never reports would be inventing a fact.
service_ok() {
  cid=$(container_for_service "$1")
  [ -n "$cid" ] || return 1
  status=$("$PODMAN" inspect "$cid" --format '{{.State.Status}}' 2>/dev/null || echo unknown)
  [ "$status" = "running" ] || return 1
  health=$("$PODMAN" inspect "$cid" --format '{{.State.Health.Status}}' 2>/dev/null || echo '')
  case "$health" in
    healthy | '' | '<no value>') return 0 ;;
    *) return 1 ;;
  esac
}

# The route, through Caddy. Not `localhost:3000` and not the container's own
# healthcheck: those answer while TLS, the reverse proxy, the upstream pool or
# the api's global prefix is broken, and every one of those has broken here
# before.
probe_ok() {
  code=$("$CURL" -sk -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE_URL" 2>/dev/null || echo 000)
  [ "$code" = "200" ]
}

# A worker that died and is being re-forked, or a primary that gave up (D85).
# Grepped out of the container's OWN log, which starts at the recreate — so a
# crash loop from before this deploy cannot produce a false positive, and one
# caused by this deploy cannot hide.
refork_lines() {
  cid=$(container_for_service api)
  [ -n "$cid" ] || return 0
  "$PODMAN" logs --since "${REFORK_WINDOW_SECONDS}s" "$cid" 2>&1 |
    grep -E 're-forking in|cannot boot' || true
}

say "watching for ${HEALTH_POLL_SECONDS}s: healthy containers, $PROBE_URL, and a quiet api log"
elapsed=0
last_reason=""
while :; do
  last_reason=""
  for service in $SERVICES; do
    service_ok "$service" || last_reason="$service is not healthy"
  done
  if [ -z "$last_reason" ]; then
    if ! probe_ok; then last_reason="$PROBE_URL did not answer 200"; fi
  fi

  # A container that has EXITED is not going to become healthy; roll back now
  # rather than spending the rest of the window on it. This is the D85 shape:
  # the primary exits non-zero and the restart policy loops it.
  for service in $SERVICES; do
    cid=$(container_for_service "$service")
    if [ -n "$cid" ]; then
      st=$("$PODMAN" inspect "$cid" --format '{{.State.Status}}' 2>/dev/null || echo unknown)
      if [ "$st" = "exited" ]; then
        last_reason="$service exited"
        elapsed=$HEALTH_POLL_SECONDS
      fi
    fi
  done

  if [ "$elapsed" -ge "$HEALTH_POLL_SECONDS" ]; then break; fi
  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
done

if [ -z "$last_reason" ]; then
  reforks=$(refork_lines)
  if [ -n "$reforks" ]; then
    last_reason="api workers are dying: $(echo "$reforks" | head -n3 | tr '\n' ' ')"
  fi
fi

# --- 6. roll back, or record the deploy ------------------------------------
if [ -n "$last_reason" ]; then
  echo "FATAL: deploy failed — $last_reason" >&2
  for service in $SERVICES; do
    echo "----- $service -----" >&2
    "$COMPOSE" logs --tail 80 "$service" >&2 || true
  done

  if [ -z "$ROLLBACKABLE" ]; then
    echo "NO ROLLBACK: none of [$SERVICES] had a :previous image to go back to." >&2
    echo "             The stack is left as it is; fix forward." >&2
    exit 1
  fi

  echo "ROLLING BACK:$ROLLBACKABLE" >&2
  for service in $ROLLBACKABLE; do
    image=$(image_for_service "$service")
    "$PODMAN" tag "${image}:previous" "${image}:latest" >&2 ||
      echo "WARNING: could not restore ${image}:latest from :previous" >&2
  done
  if recreate >&2; then
    echo "ROLLED BACK to the previous images. The marker was NOT advanced." >&2
  else
    echo "ROLLBACK RECREATE FAILED — the stack needs a human." >&2
  fi
  exit 1
fi

mkdir -p "$DEPLOY_STATE_DIR"
printf '%s\n' "$HEAD_SHA" > "$MARKER"
say "deployed [$SERVICES] at $HEAD_SHA — healthy, $PROBE_URL answered 200, api log quiet"
say "marker written to $MARKER"
