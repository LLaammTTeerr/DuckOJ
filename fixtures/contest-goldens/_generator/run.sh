#!/usr/bin/env bash
# Regenerate the contest goldens by running the *original* DMOJ/VNOJ format code.
#
#   fixtures/contest-goldens/_generator/run.sh [--only <format>/<scenario>] [--stdout --input FILE]
#
# Environment:
#   OJ_DIR   path to the read-only online-judge checkout (default ~/Projects/online-judge)
#
# Requires podman.  Nothing is installed on the host and the checkout is mounted
# read-only.  MariaDB is used rather than SQLite: four judge migrations
# (0085, 0089, 0189, 0198) contain MySQL-only `UPDATE ... INNER JOIN` and the ICPC
# format's raw SQL is MySQL-flavoured, so a SQLite harness cannot even migrate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GOLDENS="$(dirname "$HERE")"
OJ_DIR="${OJ_DIR:-$HOME/Projects/online-judge}"
IMAGE=duckoj-contest-goldens
NET=duckoj-goldens-net
DB=duckoj-goldens-db
DB_IMAGE=docker.io/library/mariadb:10.11
DB_PASSWORD=goldens

[ -d "$OJ_DIR/judge/contest_format" ] || { echo "OJ_DIR=$OJ_DIR is not an online-judge checkout" >&2; exit 1; }

if ! podman image exists "$IMAGE"; then
  echo "building $IMAGE ..." >&2
  podman build -t "$IMAGE" -f "$HERE/Containerfile" "$OJ_DIR"
fi

# GOLDEN_KEEP_DB=1 leaves the database container up between runs (useful while
# iterating); by default it is torn down on exit.
cleanup() {
  [ "${GOLDEN_KEEP_DB:-0}" = "1" ] && return 0
  podman rm -f "$DB" >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! podman container inspect "$DB" >/dev/null 2>&1; then
  podman network exists "$NET" || podman network create "$NET" >/dev/null
  podman run -d --name "$DB" --network "$NET" \
    -e MARIADB_ROOT_PASSWORD="$DB_PASSWORD" -e MARIADB_DATABASE=dmoj \
    "$DB_IMAGE" --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci >/dev/null
fi

# NOTE: `mariadb-admin ping` over the unix socket succeeds while the entrypoint's
# temporary server is still running with --skip-networking, so it must be forced
# over TCP or the harness races the database and fails with errno 115.
echo "waiting for mariadb ..." >&2
ready=0
for _ in $(seq 1 90); do
  if podman exec "$DB" mariadb-admin --protocol=tcp -h 127.0.0.1 -uroot -p"$DB_PASSWORD" \
       ping --silent >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = "1" ] || { echo "mariadb never accepted TCP connections" >&2; exit 1; }

OJ_COMMIT="$(git -C "$OJ_DIR" rev-parse HEAD)"
OJ_SUBJECT="$(git -C "$OJ_DIR" log -1 --format=%s)"
IMAGE_ID="$(podman image inspect -f '{{.Id}}' "$IMAGE")"

run_py() {
  podman run --rm --network "$NET" \
    -v "$OJ_DIR:/oj:ro" \
    -v "$HERE:/gen:z" \
    -v "$GOLDENS:/goldens:z" \
    -e PYTHONPATH=/oj:/gen \
    -e GOLDEN_OJ_COMMIT="$OJ_COMMIT" \
    -e GOLDEN_OJ_SUBJECT="$OJ_SUBJECT" \
    -e GOLDEN_IMAGE_ID="$IMAGE_ID" \
    -e GOLDEN_DATE="$(date -u +%Y-%m-%d)" \
    -e DJANGO_SETTINGS_MODULE=settings_goldens \
    -e GOLDEN_DB_ENGINE=django.db.backends.mysql \
    -e GOLDEN_DB_NAME=dmoj \
    -e GOLDEN_DB_USER=root \
    -e GOLDEN_DB_PASSWORD="$DB_PASSWORD" \
    -e GOLDEN_DB_HOST="$DB" \
    -e GOLDEN_DB_PORT=3306 \
    -w /goldens "$IMAGE" python "$@"
}

echo "migrating ..." >&2
run_py -c "
import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'settings_goldens')
import dmoj.compressor_patch  # noqa
django.setup()
from django.core.management import call_command
call_command('migrate', verbosity=0)
print('migrated', file=__import__('sys').stderr)
"

if [ ! -f "$HERE/requirements.lock.txt" ]; then
  echo "pinning resolved dependencies ..." >&2
  run_py -m pip freeze > "$HERE/requirements.lock.txt"
fi

if [ "${1:-}" = "--verify" ]; then
  shift
  run_py /gen/verify.py /goldens "$@"
else
  run_py /gen/generate.py /goldens "$@"
fi
