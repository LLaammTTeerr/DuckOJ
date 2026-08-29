#!/bin/sh
# Exercises scripts/backup.sh and scripts/restore.sh end to end against a
# THROWAWAY postgres container and a THROWAWAY compose project name. It never
# touches the live `duckoj` project: every container, volume and directory it
# creates is named after $PROJECT below and removed by the cleanup trap, and
# no `podman-compose` binary is ever invoked — the compose calls go to a stub
# that only records what it was asked to do.
#
# There is no `bats` on this host, so this is a plain POSIX sh harness: each
# case prints "ok - <name>" or "not ok - <name>" and the script exits non-zero
# if any case failed.
#
# Run it:  scripts/test/restore.test.sh
#
# What it pins (review findings F3 fixes):
#   M4  the resolved project is exported as COMPOSE_PROJECT_NAME, so the label
#       lookup and the compose calls cannot disagree; a stopped postgres is
#       refused before anything is touched.
#   M5  a failed volume import restarts the writers, loudly.
#   M6  a failed pg_restore aborts non-zero, prints the log, and leaves the
#       writers stopped.
#   M7  migrate runs after the reload and before the writers restart.
#   M8  the backup directory is 700 and its files 600, including files that
#       were already there with looser modes.

set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PROJECT="duckoj-f3test-$$"
PG_NAME="${PROJECT}_postgres_1"
MIGRATE_NAME="${PROJECT}_migrate_1"
STORE_VOLUME="${PROJECT}_package_store"
PG_IMAGE=postgres:16-alpine
WORK=$(mktemp -d)
DEST="$WORK/backups"
COMPOSE_LOG="$WORK/compose.log"
STUB="$WORK/fake-compose"

failures=0
ok() { echo "ok - $1"; }
notok() {
  echo "not ok - $1"
  failures=$((failures + 1))
}
check() {
  # check <name> <condition-as-shell-words...>
  name=$1
  shift
  if "$@"; then ok "$name"; else notok "$name"; fi
}

cleanup() {
  podman rm -f "$PG_NAME" "$MIGRATE_NAME" >/dev/null 2>&1
  podman volume rm -f "$STORE_VOLUME" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "# repo    $REPO"
echo "# project $PROJECT (throwaway; the live 'duckoj' project is never touched)"
echo "# workdir $WORK"

# --- the compose stub -------------------------------------------------------
# It records every invocation and, for the migrate step, creates a REAL
# exited-0 container carrying the throwaway project's compose labels, so
# restore.sh's `podman inspect ... {{.State.ExitCode}}` check runs for real
# rather than being mocked away. FAKE_MIGRATE_EXIT lets a case make migrate
# fail. Writing the stub means podman-compose is never executed by this test.
cat >"$STUB" <<'STUB_EOF'
#!/bin/sh
echo "compose $* [COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-<unset>}]" >>"$COMPOSE_LOG"
for a in "$@"; do
  if [ "$a" = "migrate" ] && [ "$1" = "up" ]; then
    podman rm -f "$MIGRATE_NAME" >/dev/null 2>&1
    podman run --name "$MIGRATE_NAME" \
      --label "com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
      --label "com.docker.compose.service=migrate" \
      docker.io/library/alpine:3 sh -c "exit ${FAKE_MIGRATE_EXIT:-0}" >/dev/null 2>&1
    exit 0
  fi
done
exit 0
STUB_EOF
chmod +x "$STUB"
export COMPOSE_LOG MIGRATE_NAME

# --- throwaway postgres -----------------------------------------------------
echo "# starting throwaway postgres"
podman run -d --name "$PG_NAME" \
  --label "com.docker.compose.project=${PROJECT}" \
  --label "com.docker.compose.service=postgres" \
  -e POSTGRES_USER=duckoj -e POSTGRES_DB=duckoj \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$PG_IMAGE" >/dev/null || {
  echo "Bail out! could not start $PG_IMAGE"
  exit 1
}

i=0
until podman exec "$PG_NAME" pg_isready -U duckoj -d duckoj >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && {
    echo "Bail out! postgres never became ready"
    exit 1
  }
  sleep 1
done

psql() { podman exec -i "$PG_NAME" psql -qtAX -U duckoj -d duckoj "$@"; }

psql -c "create table province (id int primary key, name text not null);" >/dev/null
psql -c "insert into province values (1, 'Ha Giang');" >/dev/null
podman volume create "$STORE_VOLUME" >/dev/null

# ===========================================================================
echo "# --- M8: backup file modes"
mkdir -p "$DEST"
chmod 755 "$DEST"
: >"$DEST/duckoj-19990101-000000.dump"
chmod 644 "$DEST/duckoj-19990101-000000.dump"
: >"$DEST/duckoj-19990101-000000.dump.partial" # m11: abandoned, must be swept

COMPOSE_PROJECT_NAME="$PROJECT" SKIP_STORE=1 KEEP=0 \
  "$REPO/scripts/backup.sh" "$DEST" >"$WORK/backup.out" 2>&1
check "backup.sh exits 0" [ $? -eq 0 ]

PREFIX=$(ls -1 "$DEST"/duckoj-2*.dump 2>/dev/null | sort | tail -n1)
PREFIX=${PREFIX%.dump}
check "backup wrote a dump" [ -s "$PREFIX.dump" ]

dirmode=$(stat -c '%a' "$DEST")
dumpmode=$(stat -c '%a' "$PREFIX.dump")
oldmode=$(stat -c '%a' "$DEST/duckoj-19990101-000000.dump")
echo "#   dir=$dirmode dump=$dumpmode pre-existing=$oldmode"
check "backup dir is 700" [ "$dirmode" = "700" ]
check "dump is 600" [ "$dumpmode" = "600" ]
check "pre-existing loose file tightened to 600" [ "$oldmode" = "600" ]
check "m11 abandoned .partial swept" [ ! -e "$DEST/duckoj-19990101-000000.dump.partial" ]
rm -f "$DEST/duckoj-19990101-000000.dump"

echo "# --- m10: a non-numeric KEEP is rejected up front"
COMPOSE_PROJECT_NAME="$PROJECT" SKIP_STORE=1 KEEP=nope \
  "$REPO/scripts/backup.sh" "$DEST" >"$WORK/keep.out" 2>&1
rc=$?
check "non-numeric KEEP exits non-zero" [ "$rc" -ne 0 ]
check "non-numeric KEEP explains itself" grep -q "KEEP must be a non-negative integer" "$WORK/keep.out"

# ===========================================================================
echo "# --- restore refusals"
COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/noconfirm.out" 2>&1
rc=$?
check "no CONFIRM exits non-zero" [ "$rc" -ne 0 ]
check "no CONFIRM says REFUSING" grep -q "REFUSING" "$WORK/noconfirm.out"

echo "# --- M4: a stopped postgres for the resolved project is refused"
podman stop "$PG_NAME" >/dev/null
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/stopped.out" 2>&1
rc=$?
check "stopped postgres exits non-zero" [ "$rc" -ne 0 ]
check "stopped postgres names the project" grep -q "is not running" "$WORK/stopped.out"
podman start "$PG_NAME" >/dev/null
i=0
until podman exec "$PG_NAME" pg_isready -U duckoj -d duckoj >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && {
    echo "Bail out! postgres never came back"
    exit 1
  }
  sleep 1
done

# ===========================================================================
echo "# --- data path: break the row, restore it (SERVICES=\"\", no compose at all)"
psql -c "delete from province where id = 1;" >/dev/null
check "row is gone before restore" [ "$(psql -c 'select count(*) from province;')" = "0" ]

: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/restore.out" 2>&1
rc=$?
check "restore exits 0" [ "$rc" -eq 0 ]
check "restore says complete" grep -q "Restore complete" "$WORK/restore.out"
check "row is back" [ "$(psql -c "select name from province where id = 1;")" = "Ha Giang" ]
check "SERVICES=\"\" ran no compose command" [ ! -s "$COMPOSE_LOG" ]

echo "# --- idempotence: a second identical restore changes nothing"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/restore2.out" 2>&1
check "second restore exits 0" [ $? -eq 0 ]
check "still exactly one row" [ "$(psql -c 'select count(*) from province;')" = "1" ]

# ===========================================================================
echo "# --- M7: migrate runs after the reload, before the writers restart"
: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="api judged" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/withsvc.out" 2>&1
rc=$?
sed 's/^/#   /' "$COMPOSE_LOG"
check "restore with SERVICES exits 0" [ "$rc" -eq 0 ]
check "stopped the writers" grep -q "^compose stop api judged" "$COMPOSE_LOG"
check "ran migrate --no-deps --force-recreate" \
  grep -q "^compose up --no-deps --force-recreate migrate" "$COMPOSE_LOG"
check "reported migrate exited 0" grep -q "migrate exited 0" "$WORK/withsvc.out"
check "started the writers" grep -q "^compose start api judged" "$COMPOSE_LOG"
check "M4: exported COMPOSE_PROJECT_NAME reached the compose calls" \
  grep -q "COMPOSE_PROJECT_NAME=${PROJECT}" "$COMPOSE_LOG"
order=$(sed -n 's/^compose \([a-z]*\).*/\1/p' "$COMPOSE_LOG" | tr '\n' ' ')
echo "#   compose call order: $order"
check "order is stop, up(migrate), start" [ "$order" = "stop up start " ]

echo "# --- M4: the deprecated COMPOSE_PROJECT alias still resolves correctly"
: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT="$PROJECT" SERVICES="api judged" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/alias.out" 2>&1
check "alias run exits 0" [ $? -eq 0 ]
check "alias is exported as COMPOSE_PROJECT_NAME" \
  grep -q "COMPOSE_PROJECT_NAME=${PROJECT}" "$COMPOSE_LOG"

echo "# --- M7: a failing migrate leaves the writers stopped"
: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="api judged" COMPOSE="$STUB" \
  FAKE_MIGRATE_EXIT=3 \
  "$REPO/scripts/restore.sh" "$PREFIX" >"$WORK/migratefail.out" 2>&1
rc=$?
check "failing migrate exits non-zero" [ "$rc" -ne 0 ]
check "failing migrate reports the exit code" grep -q "migrate exited with code 3" "$WORK/migratefail.out"
check "failing migrate leaves writers stopped" grep -q "DELIBERATELY LEFT STOPPED" "$WORK/migratefail.out"
check "failing migrate never started the writers" \
  sh -c '! grep -q "^compose start" "$COMPOSE_LOG"'

# ===========================================================================
echo "# --- M6: an injected pg_restore failure aborts, prints the log, leaves writers stopped"
BAD="$WORK/duckoj-badrestore"
head -c 512 "$PREFIX.dump" >"$BAD.dump"
: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="api judged" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$BAD" >"$WORK/badrestore.out" 2>&1
rc=$?
sed 's/^/#   /' "$WORK/badrestore.out" | head -n 12
check "bad dump exits non-zero" [ "$rc" -ne 0 ]
check "bad dump prints FATAL: pg_restore failed" grep -q "FATAL: pg_restore failed" "$WORK/badrestore.out"
check "bad dump prints the trap message" grep -q "DELIBERATELY LEFT STOPPED" "$WORK/badrestore.out"
check "bad dump stopped the writers" grep -q "^compose stop api judged" "$COMPOSE_LOG"
check "bad dump never started the writers" sh -c '! grep -q "^compose start" "$COMPOSE_LOG"'
check "bad dump never reached migrate" sh -c '! grep -q "migrate" "$COMPOSE_LOG"'
check "the good row survived the aborted restore" \
  [ "$(psql -c "select name from province where id = 1;")" = "Ha Giang" ]

# ===========================================================================
echo "# --- M5: a failed volume import restarts the writers"
BADTAR="$WORK/duckoj-badtar"
cp "$PREFIX.dump" "$BADTAR.dump"
echo "this is not a tar" >"$BADTAR.package_store.tar"
: >"$COMPOSE_LOG"
CONFIRM=yes COMPOSE_PROJECT_NAME="$PROJECT" SERVICES="api judged" COMPOSE="$STUB" \
  "$REPO/scripts/restore.sh" "$BADTAR" >"$WORK/badtar.out" 2>&1
rc=$?
sed 's/^/#   /' "$WORK/badtar.out" | tail -n 8
check "bad tar exits non-zero" [ "$rc" -ne 0 ]
check "bad tar prints the restart message" grep -q "Restarting them now" "$WORK/badtar.out"
check "bad tar DID restart the writers" grep -q "^compose start api judged" "$COMPOSE_LOG"
check "bad tar had already migrated" grep -q "migrate exited 0" "$WORK/badtar.out"

# ===========================================================================
echo ""
if [ "$failures" -eq 0 ]; then
  echo "PASS - all cases green"
  exit 0
fi
echo "FAIL - $failures case(s) failed"
exit 1
