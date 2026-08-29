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
#   COMPOSE_PROJECT   compose project name (default: the repo directory name)
#   PG_CONTAINER      postgres container name, bypassing service lookup
#   STORE_VOLUME      package_store volume name (default: <project>_package_store)
#   PG_USER, PG_DB    database role/name (default: duckoj/duckoj)
#   SERVICES          services to stop for the restore and start again after
#                     (default "api judged"; SERVICES="" leaves the stack
#                     untouched — that is how the restore path is exercised
#                     against a throwaway container without going near a live
#                     compose stack)
#   COMPOSE           compose binary (default podman-compose)
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
PROJECT=${COMPOSE_PROJECT:-$(basename "$PWD")}
PG_USER=${PG_USER:-duckoj}
PG_DB=${PG_DB:-duckoj}
COMPOSE=${COMPOSE:-podman-compose}
SERVICES=${SERVICES-api judged}

# See the identical helper in scripts/backup.sh and scripts/compose-up.sh.
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
  echo "       Set COMPOSE_PROJECT or PG_CONTAINER." >&2
  exit 1
fi

# Writers off first. api and judged both hold open connections and judged is
# actively UPDATEing grading_jobs; restoring underneath them means pg_restore
# fighting live locks, and a judged that keeps writing to tables it has a
# stale picture of. Postgres itself stays up — it is what we are restoring
# into.
if [ -n "$SERVICES" ]; then
  echo "==> Stopping $SERVICES"
  # shellcheck disable=SC2086 -- SERVICES is a deliberate word list
  "$COMPOSE" stop $SERVICES
else
  echo "==> SERVICES is empty: not stopping anything"
fi

echo "==> Restoring database '${PG_DB}' into ${PG_CONTAINER} from $PREFIX.dump"
# --clean --if-exists: drop each object before recreating it, tolerating
# objects the target does not have. `--exit-on-error` is deliberately NOT
# set: a --clean reload emits benign "does not exist" noise for objects the
# target never had, and failing the whole restore on those would make this
# script unusable for its main job (a restore into a FRESH database).
if ! podman exec -i "$PG_CONTAINER" \
  pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner < "$PREFIX.dump"; then
  echo "WARNING: pg_restore reported errors — review the output above before trusting this restore" >&2
fi
echo "==> Database restored"

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

echo "==> Restore complete from $PREFIX"
