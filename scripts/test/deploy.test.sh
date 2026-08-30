#!/bin/sh
# Exercises scripts/deploy.sh against STUB podman / podman-compose / curl
# binaries and a THROWAWAY compose project name. Nothing real is built,
# started, stopped or recreated: the only real command it runs is `git
# archive`, which is read-only, and the live `duckoj` project is never named.
#
# There is no `bats` on this host, so this is a plain POSIX sh harness —
# `scripts/test/restore.test.sh`'s shape, for its reasons: each case prints
# "ok - <name>" or "not ok - <name>" and the script exits non-zero if any
# case failed.
#
# Run it:  scripts/test/deploy.test.sh
#
# What it pins:
#   D1  the build context is the `git archive HEAD` export, never the working
#       tree — an uncommitted file in the repo is NOT in what gets built
#   D2  the compose build runs from the export directory, with
#       COMPOSE_PROJECT_NAME exported, so the image it tags is the one the
#       recreate then uses
#   D3  the previous image is tagged `:previous` BEFORE the build
#   D4  migrate runs when packages/db/migrations moved since the marker, and
#       does not when it did not; no marker means run
#   D5  a container that never turns healthy rolls back and exits non-zero
#   D6  a route that does not answer 200 through Caddy rolls back
#   D7  worker re-fork lines in the api log roll back
#   D8  a clean deploy writes the marker; a failed one does not
#   D9  the recreate runs from the REPO directory (caddy's bind mounts)

set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PROJECT="duckoj-b15test-$$"
WORK=$(mktemp -d)
STUBS="$WORK/bin"
STATE="$WORK/state"
COMPOSE_LOG="$WORK/compose.log"
PODMAN_LOG="$WORK/podman.log"
DIRTY_FILE="$REPO/UNCOMMITTED-$$.txt"

failures=0
ok() { echo "ok - $1"; }
notok() {
  echo "not ok - $1"
  failures=$((failures + 1))
}
check() {
  name=$1
  shift
  if "$@"; then ok "$name"; else notok "$name"; fi
}

cleanup() {
  rm -rf "$WORK"
  rm -f "$DIRTY_FILE"
}
trap cleanup EXIT INT TERM

echo "# repo    $REPO"
echo "# project $PROJECT (throwaway; podman/compose/curl are stubs, nothing real runs)"
echo "# workdir $WORK"

mkdir -p "$STUBS" "$STATE"

# --- the stubs --------------------------------------------------------------
# podman: enough of `ps -a`, `inspect`, `image exists`, `tag` and `logs` for
# the script to run, all of it driven by files under $STATE so a case can put
# the fleet into any state it likes.
cat >"$STUBS/podman" <<'STUB_EOF'
#!/bin/sh
echo "podman $*" >>"$PODMAN_LOG"
cmd=${1:-}
shift 2>/dev/null || true
case "$cmd" in
  ps)
    svc=""
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.service=*) svc=${a#label=com.docker.compose.service=} ;;
      esac
    done
    [ -f "$STATE/absent_$svc" ] && exit 0
    echo "${COMPOSE_PROJECT_NAME}_${svc}_1"
    ;;
  inspect)
    name=${1:-}
    shift 2>/dev/null || true
    fmt=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--format" ]; then
        shift
        fmt=${1:-}
      fi
      shift 2>/dev/null || break
    done
    svc=${name#${COMPOSE_PROJECT_NAME}_}
    svc=${svc%_1}
    case "$fmt" in
      *State.Status*) cat "$STATE/status_$svc" 2>/dev/null || echo running ;;
      *Health.Status*) cat "$STATE/health_$svc" 2>/dev/null || echo healthy ;;
      *ExitCode*) cat "$STATE/exit_$svc" 2>/dev/null || echo 0 ;;
      *) echo '' ;;
    esac
    ;;
  image)
    # `exit`, not a bare command: the `exit 0` at the bottom of this stub
    # would otherwise swallow the answer and report every image as present.
    [ "${1:-}" = "exists" ] || exit 0
    shift
    if grep -qxF "${1:-}" "$STATE/images" 2>/dev/null; then exit 0; else exit 1; fi
    ;;
  tag)
    echo "${2:-}" >>"$STATE/images"
    ;;
  logs)
    svc=api
    cat "$STATE/logs_$svc" 2>/dev/null || true
    ;;
esac
exit 0
STUB_EOF

# compose: records the invocation AND the working directory it was called
# from, which is how D2 and D9 are checked at all.
cat >"$STUBS/compose" <<'STUB_EOF'
#!/bin/sh
echo "compose[$PWD][project=${COMPOSE_PROJECT_NAME:-<unset>}] $*" >>"$COMPOSE_LOG"
if [ -n "${FAKE_COMPOSE_FAIL:-}" ] && [ "${1:-}" = "$FAKE_COMPOSE_FAIL" ]; then
  exit 1
fi
exit 0
STUB_EOF

# curl: answers whatever the case put in $STATE/probe_code.
cat >"$STUBS/curl" <<'STUB_EOF'
#!/bin/sh
printf '%s' "$(cat "$STATE/probe_code" 2>/dev/null || echo 200)"
STUB_EOF

chmod +x "$STUBS/podman" "$STUBS/compose" "$STUBS/curl"
export COMPOSE_LOG PODMAN_LOG STATE

HEAD_SHA=$(cd "$REPO" && git rev-parse HEAD)

# `duckoj_api:latest` and `duckoj_judged:latest` exist; nothing else does.
reset_state() {
  rm -rf "$STATE"
  mkdir -p "$STATE"
  : >"$COMPOSE_LOG"
  : >"$PODMAN_LOG"
  printf 'localhost/%s_api:latest\nlocalhost/%s_judged:latest\n' "$PROJECT" "$PROJECT" >"$STATE/images"
  rm -rf "$WORK/export" "$WORK/deploystate"
}

# Runs deploy.sh with every seam pointed at the stubs. Poll settings are zeroed
# so a case takes milliseconds rather than 45 s; the LOGIC under test is
# unchanged by that, only the number of iterations.
run_deploy() {
  (
    cd "$REPO" || exit 1
    COMPOSE_PROJECT_NAME="$PROJECT" \
      COMPOSE="$STUBS/compose" \
      PODMAN="$STUBS/podman" \
      CURL="$STUBS/curl" \
      COMPOSE_LOG="$COMPOSE_LOG" \
      PODMAN_LOG="$PODMAN_LOG" \
      STATE="$STATE" \
      PROBE_URL="https://localhost:8443/api/v1/languages" \
      HEALTH_POLL_SECONDS=0 \
      POLL_INTERVAL_SECONDS=0 \
      EXPORT_DIR="$WORK/export" \
      DEPLOY_STATE_DIR="$WORK/deploystate" \
      "$REPO/scripts/deploy.sh" "$@"
  ) >"$WORK/out.log" 2>&1
}

compose_log_has() { grep -qF "$1" "$COMPOSE_LOG"; }
podman_log_has() { grep -qF "$1" "$PODMAN_LOG"; }

# ===========================================================================
echo "# --- D1/D2/D3/D8/D9: a clean deploy"
reset_state
echo "this file is uncommitted and must never reach an image" >"$DIRTY_FILE"
run_deploy api
status=$?

check "D8 a clean deploy exits 0" test "$status" -eq 0
check "D1 the export contains the committed tree" test -f "$WORK/export/docker-compose.yml"
check "D1 the export does NOT contain the uncommitted file" test ! -f "$WORK/export/$(basename "$DIRTY_FILE")"
check "D2 the build ran from the export directory" compose_log_has "compose[$WORK/export]"
# The image podman-compose builds is named `<project>_<service>` from its
# WORKING DIRECTORY unless COMPOSE_PROJECT_NAME says otherwise — and the
# working directory here is a scratch export. Without this the build would tag
# something like `export_api` and the recreate would keep serving the old
# `duckoj_api`, silently.
check "D2 the build carries the project name, so it tags the right image" \
  compose_log_has "compose[$WORK/export][project=$PROJECT] build"
check "D3 the previous image was tagged :previous" \
  podman_log_has "podman tag localhost/${PROJECT}_api:latest localhost/${PROJECT}_api:previous"
check "D9 the recreate ran from the repo directory" \
  compose_log_has "compose[$REPO][project=$PROJECT] up -d --no-deps --force-recreate api"
check "D8 the marker records HEAD" test "$(cat "$WORK/deploystate/last-deploy" 2>/dev/null)" = "$HEAD_SHA"
rm -f "$DIRTY_FILE"

# ===========================================================================
# `.env` is gitignored, so it is NOT in the archive — and compose interpolates
# every `${...}` in the file before it does anything at all, including for
# services it is not building. Without the copy, the build in the export
# directory dies on `POSTGRES_PASSWORD:?set POSTGRES_PASSWORD`.
echo "# --- the secrets file follows the export"
reset_state
made_env=0
if [ ! -f "$REPO/.env" ]; then
  printf 'POSTGRES_PASSWORD=b15test\n' >"$REPO/.env"
  made_env=1
fi
run_deploy api
check ".env is copied into the export" test -f "$WORK/export/.env"
if [ "$made_env" = "1" ]; then rm -f "$REPO/.env"; fi

# ===========================================================================
echo "# --- D4: the migrate gate"
reset_state
run_deploy api
check "D4 no marker at all means migrate runs" compose_log_has "up --no-deps --force-recreate migrate"
check "D4 the migrate IMAGE is rebuilt with it (stale-image silent reseed)" compose_log_has "build api migrate"

reset_state
mkdir -p "$WORK/deploystate"
printf '%s\n' "$HEAD_SHA" >"$WORK/deploystate/last-deploy"
run_deploy api
if compose_log_has "up --no-deps --force-recreate migrate"; then
  notok "D4 an unchanged packages/db/migrations skips migrate"
else
  ok "D4 an unchanged packages/db/migrations skips migrate"
fi

reset_state
mkdir -p "$WORK/deploystate"
# A marker naming a commit that certainly changed packages/db/migrations
# since: the repo's own root commit.
ROOT_SHA=$(cd "$REPO" && git rev-list --max-parents=0 HEAD | head -n1)
printf '%s\n' "$ROOT_SHA" >"$WORK/deploystate/last-deploy"
run_deploy api
check "D4 a moved packages/db/migrations runs migrate" compose_log_has "up --no-deps --force-recreate migrate"

reset_state
mkdir -p "$WORK/deploystate"
printf '%s\n' "0000000000000000000000000000000000000000" >"$WORK/deploystate/last-deploy"
run_deploy api
check "D4 a marker this repo does not have means migrate" compose_log_has "up --no-deps --force-recreate migrate"

# ===========================================================================
echo "# --- D5: never healthy -> rollback"
reset_state
echo starting >"$STATE/health_api"
run_deploy api
status=$?
check "D5 exits non-zero" test "$status" -ne 0
check "D5 restores :previous over :latest" \
  podman_log_has "podman tag localhost/${PROJECT}_api:previous localhost/${PROJECT}_api:latest"
check "D5 recreates again after the rollback" \
  test "$(grep -c 'up -d --no-deps --force-recreate api' "$COMPOSE_LOG")" -eq 2
check "D5 prints the failing service's logs" grep -q '\-\-\-\-\- api \-\-\-\-\-' "$WORK/out.log"
check "D5 does NOT advance the marker" test ! -f "$WORK/deploystate/last-deploy"

# ===========================================================================
echo "# --- D6: the route does not answer 200 -> rollback"
reset_state
echo 502 >"$STATE/probe_code"
run_deploy api
status=$?
check "D6 exits non-zero on a 502 through Caddy" test "$status" -ne 0
check "D6 rolls back" podman_log_has "podman tag localhost/${PROJECT}_api:previous localhost/${PROJECT}_api:latest"
check "D6 says which check failed" grep -q 'did not answer 200' "$WORK/out.log"

# ===========================================================================
echo "# --- D7: worker re-fork lines -> rollback"
reset_state
cat >"$STATE/logs_api" <<'LOG_EOF'
{"level":"info","msg":"api primary 1 starting 4 workers"}
{"level":"info","msg":"api worker 12 exited (code=1 signal=null) after 0s — re-forking in 1000ms"}
LOG_EOF
run_deploy api
status=$?
check "D7 exits non-zero when workers are being re-forked" test "$status" -ne 0
check "D7 rolls back" podman_log_has "podman tag localhost/${PROJECT}_api:previous localhost/${PROJECT}_api:latest"
check "D7 names the reason" grep -q 'workers are dying' "$WORK/out.log"

reset_state
cat >"$STATE/logs_api" <<'LOG_EOF'
{"level":"info","msg":"api primary: all 4 workers are dead within 0s of start (last exit code=1 signal=null) — this build cannot boot; exiting 1"}
LOG_EOF
run_deploy api
check "D7 the D85 breaker line also fails the deploy" test $? -ne 0

# ===========================================================================
echo "# --- rollback is refused when there is nothing to roll back to"
reset_state
: >"$STATE/images"
echo starting >"$STATE/health_api"
run_deploy api
status=$?
check "a first deploy with no :previous still exits non-zero" test "$status" -ne 0
check "and says so rather than pretending" grep -q 'NO ROLLBACK' "$WORK/out.log"

# ===========================================================================
echo "# --- a service that is not in docker-compose.yml"
reset_state
run_deploy not-a-service
status=$?
check "an unknown service is refused" test "$status" -ne 0
if compose_log_has build; then
  notok "an unknown service builds nothing"
else
  ok "an unknown service builds nothing"
fi

# ===========================================================================
echo "# --- a registry-image service is recreated but never tagged"
reset_state
run_deploy caddy
status=$?
check "caddy deploys" test "$status" -eq 0
if podman_log_has "podman tag localhost/${PROJECT}_caddy"; then
  notok "caddy's registry image is never tagged :previous"
else
  ok "caddy's registry image is never tagged :previous"
fi

# ===========================================================================
echo "# --- a failed build never recreates anything"
reset_state
export FAKE_COMPOSE_FAIL=build
run_deploy api
status=$?
unset FAKE_COMPOSE_FAIL
check "a failed build exits non-zero" test "$status" -ne 0
if compose_log_has "up -d --no-deps --force-recreate api"; then
  notok "a failed build recreates nothing"
else
  ok "a failed build recreates nothing"
fi
# And this is what pins the ORDER of steps 1 and 2: the build never ran, yet
# `:previous` is already taken. It has to be — the build is what overwrites
# the image it is taken from.
check "D3 :previous is taken before the build, not after it" \
  podman_log_has "podman tag localhost/${PROJECT}_api:latest localhost/${PROJECT}_api:previous"

echo
if [ "$failures" -eq 0 ]; then
  echo "# all cases passed"
  exit 0
fi
echo "# $failures case(s) failed"
exit 1
