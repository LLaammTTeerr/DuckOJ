#!/bin/sh
# Takes a full, restorable snapshot of the DuckOJ stack's persistent state:
# the Postgres database and the `package_store` named volume (the
# content-addressed problem-package bytes the API serves to judge-agent).
#
# Those two are the whole of it. `pgdata` is covered by the dump rather than
# by a volume copy — a `pg_dump -Fc` is version-portable and consistent,
# where tarring a live data directory is neither. `caddydata` is a TLS cert
# cache that Caddy re-obtains on its own, and every other volume in the stack
# is a rebuildable image layer.
#
# Usage:
#   scripts/backup.sh [dest-dir]      # default: ~/duckoj-backups
#
# Env overrides:
#   KEEP=14           how many backups to keep (0 disables pruning). Must be a
#                     non-negative integer; validated below (m10).
#   COMPOSE_PROJECT_NAME  compose project name (default: the repo directory
#                     name, exactly as scripts/compose-up.sh derives it).
#                     `COMPOSE_PROJECT` is honoured as a deprecated alias, so
#                     that an older runbook or an un-migrated systemd unit
#                     keeps working; restore.sh names the same variable, and
#                     there it is load-bearing (see M4 in that file's header).
#   PG_CONTAINER      postgres container name, bypassing service lookup
#   STORE_VOLUME      package_store volume name (default: <project>_package_store)
#   PG_USER, PG_DB    database role/name (default: duckoj/duckoj)
#   SKIP_STORE=1      dump the database only, no volume tar
#
# FILE MODES ARE PART OF THE CONTRACT (review finding M8). The dump contains
# every `users` row: argon2id password hashes, the email addresses and display
# names of students who are minors, session and token hashes, and encrypted
# TOTP secrets. Under the default 022 umask this script used to write
# `drwxr-xr-x` / `-rw-r--r--`, i.e. any other account on the host could copy
# the whole identity table with nothing in the stack logging the read. So:
# `umask 077` before anything is created, `chmod 700` on the destination
# directory, `chmod 600` on every artefact — and every pre-existing
# `duckoj-*` file in the destination is tightened on each run, so a directory
# created by an older version of this script gets fixed the next night rather
# than staying loose forever.
#
# NOTE ON WORKTREES: the compose project name is the *directory name*, exactly
# as scripts/compose-up.sh computes it. Run from a git worktree that lookup
# finds nothing, because the worktree directory is not the project name — pass
# COMPOSE_PROJECT_NAME=duckoj (or PG_CONTAINER) when running from anywhere but
# the real checkout.
#
# Restoring is scripts/restore.sh. Retention is D17 in docs/DECISIONS.md:
# 14 days on this host, and copying backups OFF this host is the province
# IT team's responsibility — this script does not do it and must not be
# mistaken for doing it.

set -eu

# M8. Before the first mkdir, before the first redirection: everything this
# script creates is owner-only.
umask 077

cd "$(dirname "$0")/.."

PROJECT=${COMPOSE_PROJECT_NAME:-${COMPOSE_PROJECT:-$(basename "$PWD")}}
export COMPOSE_PROJECT_NAME="$PROJECT"
PG_USER=${PG_USER:-duckoj}
PG_DB=${PG_DB:-duckoj}
KEEP=${KEEP:-14}
DEST=${1:-${BACKUP_DIR:-$HOME/duckoj-backups}}

# m10. `[ "$KEEP" -gt 0 ]` below is an arithmetic comparison, and in /bin/sh a
# non-integer makes it *error* rather than answer false — under `set -e` that
# exits non-zero AFTER a perfectly good backup is already on disk, and systemd
# records the run as failed. Reject a bad KEEP up front, before any work.
case "$KEEP" in
  '' | *[!0-9]*)
    echo "FATAL: KEEP must be a non-negative integer, got '${KEEP}'" >&2
    exit 1
    ;;
esac

# Same label filter, for the same reason, as scripts/compose-up.sh's copy of
# this function: the container name depends on the project name and on how
# many replicas podman-compose made, but the compose labels do not. Kept as
# a local copy rather than a shared sourced file so that the boot-critical
# compose-up.sh keeps having no dependencies of its own.
container_for_service() {
  podman ps -a \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.Names}}' | head -n1
}

PG_CONTAINER=${PG_CONTAINER:-$(container_for_service postgres)}
STORE_VOLUME=${STORE_VOLUME:-${PROJECT}_package_store}

if [ -z "$PG_CONTAINER" ]; then
  echo "FATAL: no postgres container found for compose project '${PROJECT}'." >&2
  echo "       Set COMPOSE_PROJECT_NAME or PG_CONTAINER (see the header of this script)." >&2
  exit 1
fi

mkdir -p "$DEST"
# M8. `mkdir -p` on an existing directory changes nothing, so this also
# tightens a destination an older version of this script left world-readable.
chmod 700 "$DEST"
# ...and so do the artefacts already sitting in it.
find "$DEST" -maxdepth 1 -type f -name 'duckoj-*' -exec chmod 600 {} +

# m11. A run killed by `TimeoutStartSec` (deploy/duckoj-backup.service) dies
# between the redirection and the `mv`, so its `.partial` never gets cleaned
# up and nothing else ever matches it — the prune glob below is `*.dump` only.
# Sweep them at the start of each run: a `.partial` from a previous run is by
# definition abandoned, because a live run holds one only for the seconds
# between opening it and renaming it.
stale=$(find "$DEST" -maxdepth 1 -type f -name 'duckoj-*.partial' | wc -l)
if [ "$stale" -gt 0 ]; then
  echo "==> Removing $stale abandoned .partial file(s) from an interrupted run"
  find "$DEST" -maxdepth 1 -type f -name 'duckoj-*.partial' -delete
fi

STAMP=$(date +%Y%m%d-%H%M%S)
PREFIX="$DEST/duckoj-$STAMP"

# Every artefact is written to `.partial` and renamed only after the producing
# command exited 0. A backup directory must never contain a truncated file
# under a name that looks like a good backup — a half-written dump that
# restore.sh is willing to read is worse than no backup at all, because it is
# discovered only on the day it is needed.
echo "==> Dumping database '${PG_DB}' from container ${PG_CONTAINER}"
if ! podman exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$PREFIX.dump.partial"; then
  rm -f "$PREFIX.dump.partial"
  echo "FATAL: pg_dump failed" >&2
  exit 1
fi
mv "$PREFIX.dump.partial" "$PREFIX.dump"
chmod 600 "$PREFIX.dump"

if [ "${SKIP_STORE:-0}" = "1" ]; then
  echo "==> Skipping package_store volume (SKIP_STORE=1)"
elif [ -z "$(podman volume ls --filter "name=^${STORE_VOLUME}\$" --format '{{.Name}}')" ]; then
  # Loud, and non-zero. A stack whose package volume has gone missing is a
  # broken stack; silently producing a database-only backup would hide that
  # until a restore came up with no problem packages.
  echo "FATAL: volume '${STORE_VOLUME}' does not exist (set STORE_VOLUME, or SKIP_STORE=1 if that is deliberate)" >&2
  exit 1
else
  echo "==> Exporting volume ${STORE_VOLUME}"
  if ! podman volume export "$STORE_VOLUME" > "$PREFIX.package_store.tar.partial"; then
    rm -f "$PREFIX.package_store.tar.partial"
    echo "FATAL: podman volume export failed" >&2
    exit 1
  fi
  mv "$PREFIX.package_store.tar.partial" "$PREFIX.package_store.tar"
  chmod 600 "$PREFIX.package_store.tar"
fi

echo "==> Wrote:"
for f in "$PREFIX".dump "$PREFIX".package_store.tar; do
  [ -f "$f" ] && ls -l "$f" && du -h "$f"
done

# Prune by dump file, oldest first — the timestamp is in the name, so a plain
# lexical sort is chronological. The matching .package_store.tar goes with it;
# a tar with no dump beside it cannot be restored by restore.sh anyway.
if [ "$KEEP" -gt 0 ]; then
  total=$(ls -1 "$DEST"/duckoj-*.dump 2>/dev/null | wc -l)
  if [ "$total" -gt "$KEEP" ]; then
    doomed=$((total - KEEP))
    echo "==> Pruning $doomed backup(s), keeping the newest $KEEP"
    ls -1 "$DEST"/duckoj-*.dump 2>/dev/null | sort | head -n "$doomed" | while read -r old; do
      base=${old%.dump}
      echo "    removing $(basename "$base").*"
      rm -f "$base.dump" "$base.package_store.tar"
    done
  fi
fi

echo "==> Backup complete: $PREFIX.* (dir 700, files 600)"
