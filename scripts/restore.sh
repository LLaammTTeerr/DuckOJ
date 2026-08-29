#!/bin/sh
# Restores a snapshot taken by scripts/backup.sh into the running stack.
#
# Usage:
#   CONFIRM=yes scripts/restore.sh <backup-prefix>
#
# `<backup-prefix>` is the path WITHOUT the extension, exactly as backup.sh
# prints it — e.g. ~/duckoj-backups/duckoj-20260829-030000. Passing the
# `.dump` file itself works too; the extension is stripped.
#
# This is destructive: `pg_restore --clean --if-exists` drops and recreates
# every object the dump contains. It therefore refuses to run at all without
# CONFIRM=yes in the environment — there is no interactive prompt, because
# this has to be usable from a shell nobody is watching, and a script that
# blocks on a prompt in that setting hangs instead of failing.
#
# Env overrides:
#   CONFIRM=yes       required
#   COMPOSE_PROJECT_NAME  compose project (default: the repo directory name,
#                     exactly as scripts/compose-up.sh derives it). This is
#                     podman-compose's OWN variable and it is EXPORTED below,
#                     so the label lookup and every `$COMPOSE` call resolve to
#                     the same project. `COMPOSE_PROJECT` is honoured as a
#                     deprecated alias — see the note on M4 below.
#   PG_CONTAINER      postgres container name, bypassing service lookup
#   STORE_VOLUME      package_store volume name (default: <project>_package_store)
#   PG_USER, PG_DB    database role/name (default: duckoj/duckoj)
#   SERVICES          services to stop for the restore and start again after
#                     (default "api judged"). SERVICES="" means DATA PATH ONLY:
#                     no `$COMPOSE` command is run at all — no stop, no
#                     migrate, no start. That is how this script is exercised
#                     against a throwaway postgres container without going
#                     near a live compose stack (scripts/test/restore.test.sh).
#   COMPOSE           compose binary (default podman-compose)
#   MIGRATE_TIMEOUT   seconds to bound the migrate step (default 120), same
#                     meaning and default as in scripts/compose-up.sh
#
# WHY `COMPOSE_PROJECT_NAME` AND NOT `COMPOSE_PROJECT` (review finding M4).
# The old script read `COMPOSE_PROJECT` and used it ONLY for the container
# label lookup, while `$COMPOSE stop`/`start` went to podman-compose, which
# derives its project from the working directory or from COMPOSE_PROJECT_NAME.
# Run from a worktree as the runbook then documented — `COMPOSE_PROJECT=duckoj
# scripts/restore.sh …` — the lookup found the LIVE postgres while
# `podman-compose stop api judged` targeted the worktree's own (empty) project
# and printed nothing alarming. `pg_restore --clean` then dropped every table
# underneath a live api and a judged mid-UPDATE: precisely the hazard the
# stop/start exists to prevent. One variable now drives both, and it is
# exported so podman-compose actually sees it.
#
# WHAT HAPPENS WHEN A STEP FAILS (findings M5, M6, M7; ruling D26).
#   * Anything failing AFTER the writers were stopped brings them back, via a
#     trap on EXIT, with a loud message — a failed volume import used to leave
#     the site down with the database already fine (M5).
#   * EXCEPT a failed `pg_restore` or a failed `migrate`: those leave the
#     database in a state the running code cannot be trusted against, so the
#     writers are deliberately left STOPPED and the script says so, and says
#     how to start them by hand. A half-restored schema that api and judged
#     are serving is worse than a stack that is honestly down (M6).
#   * `migrate` runs after the reload and before the writers come back: the
#     dump carries the schema as of backup time, so restoring an old backup
#     onto newer images otherwise leaves the database behind the code — the
#     "schema drift that announces success" that compose-up.sh exists to
#     prevent, reintroduced through the restore path (M7).
#
# IDEMPOTENCE: running this twice with the same prefix leaves the same state.
# The database half is a full --clean reload. The volume half is additive —
# `podman volume import` untars over whatever is already there without
# clearing it — which is correct here and only here: package_store is
# content-addressed, so a file's name IS its hash and re-importing it
# overwrites it with identical bytes. It also means a restore does not DELETE
# packages uploaded since the backup. That is deliberate: losing bytes nobody
# asked to lose is worse than keeping a few orphans, which are unreferenced
# rows' worth of disk and nothing more.

set -eu

cd "$(dirname "$0")/.."

if [ "${CONFIRM:-}" != "yes" ]; then
  echo "REFUSING: this overwrites the database. Re-run with CONFIRM=yes" >&2
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "usage: CONFIRM=yes $0 <backup-prefix>" >&2
  exit 1
fi

PREFIX=${1%.dump}
# COMPOSE_PROJECT is the deprecated alias; it is still read so that an
# operator following an older runbook, or an un-migrated systemd unit, gets
# the CORRECT behaviour rather than the M4 catastrophe.
PROJECT=${COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT:-$(basename "$PWD")}}
export COMPOSE_PROJECT_NAME="$PROJECT"
PG_USER=${PG_USER:-duckoj}
PG_DB=${PG_DB:-duckoj}
COMPOSE=${COMPOSE:-podman-compose}
SERVICES=${SERVICES-api judged}
MIGRATE_TIMEOUT=${MIGRATE_TIMEOUT:-120}

# See the identical helper in scripts/backup.sh and scripts/compose-up.sh.
# `ps -a` (not running-only) on purpose: the migrate step below inspects its
# container's exit code AFTER it has exited.
container_for_service() {
  podman ps -a \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.Names}}' | head -n1
}

PG_CONTAINER=${PG_CONTAINER:-$(container_for_service postgres)}
STORE_VOLUME=${STORE_VOLUME:-${PROJECT}_package_store}

if [ ! -f "$PREFIX.dump" ]; then
  echo "FATAL: no dump at $PREFIX.dump" >&2
  exit 1
fi
if [ -z "$PG_CONTAINER" ]; then
  echo "FATAL: no postgres container found for compose project '${PROJECT}'." >&2
  echo "       Set COMPOSE_PROJECT_NAME or PG_CONTAINER." >&2
  exit 1
fi

# M4, second half. A container that EXISTS is not a container that is RUNNING,
# and `podman exec` into a stopped one fails halfway through a script that has
# already stopped the writers. Refuse up front, before anything is touched.
# Checked on the RESOLVED container, so the guarantee holds just as well when
# PG_CONTAINER was passed in by hand.
pg_running=$(podman inspect "$PG_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || echo false)
if [ "$pg_running" != "true" ]; then
  echo "FATAL: postgres container '${PG_CONTAINER}' (compose project '${PROJECT}') is not running." >&2
  echo "       Bring the stack up first (scripts/compose-up.sh); a restore needs a live postgres." >&2
  exit 1
fi

# --- failure handling -------------------------------------------------------
# STOPPED flips to 1 the moment the writers are stopped. RESTART_ON_EXIT is
# turned OFF for the two failures (pg_restore, migrate) after which starting
# the writers would put them on top of a database nobody has verified.
STOPPED=0
RESTART_ON_EXIT=1
DONE=0

on_exit() {
  rc=$?
  if [ "$DONE" = "1" ] || [ "$STOPPED" != "1" ]; then
    exit "$rc"
  fi
  if [ "$RESTART_ON_EXIT" = "1" ]; then
    echo "" >&2
    echo "!!! RESTORE FAILED (exit $rc) AFTER $SERVICES WERE STOPPED." >&2
    echo "!!! Restarting them now so the site does not stay down." >&2
    echo "!!! The database itself was reloaded and migrated before this failed;" >&2
    echo "!!! read the output above to see what did not complete." >&2
    # shellcheck disable=SC2086 -- SERVICES is a deliberate word list
    "$COMPOSE" start $SERVICES ||
      echo "!!! AND THE RESTART ITSELF FAILED. Run by hand: $COMPOSE start $SERVICES" >&2
  else
    echo "" >&2
    echo "!!! RESTORE FAILED (exit $rc). $SERVICES ARE DELIBERATELY LEFT STOPPED." >&2
    echo "!!! The database is in an unverified state and the running code must" >&2
    echo "!!! not serve or grade against it. Investigate, fix, re-run this" >&2
    echo "!!! script; only then: $COMPOSE start $SERVICES" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

# Writers off first. api and judged both hold open connections and judged is
# actively UPDATEing grading_jobs; restoring underneath them means pg_restore
# fighting live locks, and a judged that keeps writing to tables it has a
# stale picture of. Postgres itself stays up — it is what we are restoring
# into.
if [ -n "$SERVICES" ]; then
  echo "==> Stopping $SERVICES (compose project $PROJECT)"
  # shellcheck disable=SC2086 -- SERVICES is a deliberate word list
  "$COMPOSE" stop $SERVICES
  STOPPED=1
else
  echo "==> SERVICES is empty: data path only, no compose command will be run"
fi

echo "==> Restoring database '${PG_DB}' into ${PG_CONTAINER} from $PREFIX.dump"
# --clean --if-exists: drop each object before recreating it, tolerating
# objects the target does not have. `--exit-on-error` is still deliberately
# NOT set — a --clean reload emits benign noise for objects the target never
# had, and aborting on the first of those would make this script unusable for
# its main job (a restore into a FRESH database). The output is judged AFTER
# the fact instead (M6): a non-zero exit, or any error line that is not the
# known-benign "already exists" class, aborts.
RESTORE_LOG=$(mktemp)
# The log holds pg_restore diagnostics, not secrets, but it lands in a shared
# /tmp under the invoking umask; keep it to the owner anyway.
chmod 600 "$RESTORE_LOG"

restore_rc=0
podman exec -i "$PG_CONTAINER" \
  pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner \
  <"$PREFIX.dump" >"$RESTORE_LOG" 2>&1 || restore_rc=$?

# The benign class: `--clean --if-exists` against a database that already has
# some of the dump's objects, and extensions the image created at initdb time
# ("extension \"plpgsql\" already exists"). Everything else — a permission
# denial, a disk-full mid-COPY, a constraint violation, a corrupt archive — is
# a real failure and a half-restored schema.
bad_lines=$(grep -iE 'error' "$RESTORE_LOG" | grep -v 'already exists' || true)

if [ "$restore_rc" != "0" ] || [ -n "$bad_lines" ]; then
  echo "FATAL: pg_restore failed (exit $restore_rc). Full output:" >&2
  cat "$RESTORE_LOG" >&2
  if [ -n "$bad_lines" ]; then
    echo "FATAL: error lines that are NOT the benign 'already exists' class:" >&2
    echo "$bad_lines" >&2
  fi
  rm -f "$RESTORE_LOG"
  # Do NOT bring the writers back onto a half-restored database.
  RESTART_ON_EXIT=0
  exit 1
fi
cat "$RESTORE_LOG"
rm -f "$RESTORE_LOG"
echo "==> Database restored"

# M7. The dump's schema is the schema as of backup time, drizzle's migrations
# table included. The images that are about to start again are today's. Run
# the same migrate step compose-up.sh runs, with the same `--no-deps` (the
# dependency-resolution hang), the same `--force-recreate` (podman-compose
# otherwise re-runs the PREVIOUS build's migrations from a stale exited
# container and exits 0), the same `timeout`, and the same distrust of
# podman-compose's own exit code.
if [ -n "$SERVICES" ]; then
  echo "==> Running migrations against the restored database"
  if ! timeout "${MIGRATE_TIMEOUT}s" "$COMPOSE" up --no-deps --force-recreate migrate; then
    echo "FATAL: podman-compose up migrate failed (or exceeded ${MIGRATE_TIMEOUT}s)" >&2
    "$COMPOSE" logs migrate >&2 || true
    RESTART_ON_EXIT=0
    exit 1
  fi
  migrate_cid=$(container_for_service migrate)
  if [ -z "$migrate_cid" ]; then
    echo "FATAL: could not find the migrate container after running it" >&2
    RESTART_ON_EXIT=0
    exit 1
  fi
  migrate_exit=$(podman inspect "$migrate_cid" --format '{{.State.ExitCode}}')
  if [ "$migrate_exit" != "0" ]; then
    echo "FATAL: migrate exited with code $migrate_exit — the restored database is" >&2
    echo "       BEHIND the running images' schema. Do not start the writers." >&2
    "$COMPOSE" logs migrate >&2 || true
    RESTART_ON_EXIT=0
    exit 1
  fi
  echo "==> migrate exited 0"
else
  echo "==> SERVICES is empty: skipping the migrate step too"
fi

# From here on a failure is recoverable-with-writers-up: the database is
# reloaded and migrated, and the only thing left is package bytes. This is
# exactly M5's scenario, and the trap restarts the writers.
if [ ! -f "$PREFIX.package_store.tar" ]; then
  echo "==> No $PREFIX.package_store.tar — skipping the package volume"
elif [ -z "$(podman volume ls --filter "name=^${STORE_VOLUME}\$" --format '{{.Name}}')" ]; then
  echo "FATAL: volume '${STORE_VOLUME}' does not exist; create the stack first" >&2
  exit 1
else
  echo "==> Importing $PREFIX.package_store.tar into volume ${STORE_VOLUME}"
  podman volume import "$STORE_VOLUME" "$PREFIX.package_store.tar"
  echo "==> Package volume restored"
fi

if [ -n "$SERVICES" ]; then
  echo "==> Starting $SERVICES"
  # shellcheck disable=SC2086 -- SERVICES is a deliberate word list
  "$COMPOSE" start $SERVICES
fi

DONE=1
echo "==> Restore complete from $PREFIX"
