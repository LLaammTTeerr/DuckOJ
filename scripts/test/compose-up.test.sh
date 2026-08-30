#!/bin/sh
# Exercises scripts/compose-up.sh's SERVICE SEQUENCING without starting a
# single container: `podman-compose` and `podman` are both stubs on PATH that
# record what they were asked to do and answer "healthy" to everything. The
# live stack is never touched — no image is built, nothing is recreated, and
# the only writes are inside $WORK.
#
# There is no `bats` on this host, so this is a plain POSIX sh harness in
# scripts/test/restore.test.sh's shape: each case prints "ok - <name>" or
# "not ok - <name>", and the script exits non-zero if any case failed.
#
# Run it:  scripts/test/compose-up.test.sh
#
# What it pins (F14):
#   the second judge is behind compose's `scale` profile, and podman-compose
#   1.5 honours that profile ONLY as a `--profile` flag on the command line —
#   `COMPOSE_PROFILES`, which is how docker compose spells it, is silently
#   ignored (measured: `podman-compose config` lists judge-2 under the flag
#   and not under the variable). So a bring-up script that starts and waits
#   on `judge-2` has to pass the flag itself, and has to translate the
#   variable an operator will reach for first.

set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
BIN="$WORK/bin"
LOG="$WORK/compose.log"
mkdir -p "$BIN"

failures=0
ok() { echo "ok - $1"; }
notok() { echo "not ok - $1"; failures=$((failures + 1)); }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# The compose stub: records the whole argv, one invocation per line.
cat > "$BIN/podman-compose" <<'STUB'
#!/bin/sh
echo "$*" >> "$COMPOSE_LOG"
exit 0
STUB

# The podman stub. `ps` names a container after the service in the label
# filter; `inspect` reports it healthy and exited 0 — except for any service
# named in $UNHEALTHY, which stays "starting" forever.
cat > "$BIN/podman" <<'STUB'
#!/bin/sh
case "$1" in
  ps)
    service=$(echo "$*" | sed -n 's/.*compose.service=\([a-z0-9-]*\).*/\1/p')
    [ -n "$service" ] && echo "stub_${service}_1"
    ;;
  inspect)
    cid=$2
    service=$(echo "$cid" | sed -e 's/^stub_//' -e 's/_1$//')
    case "$*" in
      *ExitCode*) echo 0 ;;
      *Health.Status*)
        case " ${UNHEALTHY:-} " in
          *" $service "*) echo starting ;;
          *) echo healthy ;;
        esac
        ;;
    esac
    ;;
esac
exit 0
STUB
chmod +x "$BIN/podman-compose" "$BIN/podman"

# Runs compose-up.sh with the stubs in front of the real binaries. Every case
# starts from an empty log. Extra env is passed as `VAR=value` arguments.
run_case() {
  : > "$LOG"
  env PATH="$BIN:$PATH" COMPOSE_LOG="$LOG" SKIP_BUILD=1 "$@" \
    "$REPO/scripts/compose-up.sh" > "$WORK/out" 2>&1
}

# --- a plain bring-up ------------------------------------------------------
if run_case; then
  ok "a plain bring-up succeeds against the stubs"
else
  notok "a plain bring-up succeeds against the stubs"; cat "$WORK/out"
fi
if grep -q -- '--profile' "$LOG"; then
  notok "a plain bring-up passes no profile"
else
  ok "a plain bring-up passes no profile"
fi
if grep -qw 'judge-2' "$LOG"; then
  notok "a plain bring-up never mentions judge-2"
else
  ok "a plain bring-up never mentions judge-2"
fi
if grep -q 'judge is healthy' "$WORK/out"; then
  ok "a plain bring-up still waits on the one judge"
else
  notok "a plain bring-up still waits on the one judge"
fi

# --- SCALE=1 ---------------------------------------------------------------
if run_case SCALE=1; then
  ok "SCALE=1 brings the stack up"
else
  notok "SCALE=1 brings the stack up"; cat "$WORK/out"
fi
if grep -q -- '--profile scale up -d --no-deps --force-recreate judge-2' "$LOG"; then
  ok "SCALE=1 starts judge-2 with the profile flag on the command line"
else
  notok "SCALE=1 starts judge-2 with the profile flag on the command line"; cat "$LOG"
fi
if grep -q 'judge-2 is healthy' "$WORK/out"; then
  ok "SCALE=1 waits for judge-2 to report healthy"
else
  notok "SCALE=1 waits for judge-2 to report healthy"; cat "$WORK/out"
fi
# The build and every other `up` must carry the flag too: podman-compose
# filters the service out of the file without it, so `build` would skip
# judge-2's image and `up judge judge-2` would silently start one judge.
if [ "$(grep -c -- '--profile scale' "$LOG")" -ge 3 ]; then
  ok "SCALE=1 carries the profile on every compose call, not just the last"
else
  notok "SCALE=1 carries the profile on every compose call, not just the last"; cat "$LOG"
fi

# --- COMPOSE_PROFILES=scale, the spelling an operator reaches for ----------
if run_case COMPOSE_PROFILES=scale && grep -q 'judge-2 is healthy' "$WORK/out"; then
  ok "COMPOSE_PROFILES=scale is translated into the flag podman-compose reads"
else
  notok "COMPOSE_PROFILES=scale is translated into the flag podman-compose reads"
  cat "$WORK/out"
fi
if run_case COMPOSE_PROFILES=debug,other; then
  if grep -qw 'judge-2' "$LOG"; then
    notok "an unrelated profile does not start judge-2"
  else
    ok "an unrelated profile does not start judge-2"
  fi
else
  notok "an unrelated profile does not start judge-2"
fi

# --- a judge-2 that never comes up must fail the script -------------------
if run_case SCALE=1 UNHEALTHY=judge-2 JUDGE2_TIMEOUT=0; then
  notok "a judge-2 that never turns healthy fails the bring-up"
else
  if grep -q 'FATAL: judge-2 did not become healthy' "$WORK/out"; then
    ok "a judge-2 that never turns healthy fails the bring-up"
  else
    notok "a judge-2 that never turns healthy fails the bring-up"; cat "$WORK/out"
  fi
fi

if [ "$failures" -eq 0 ]; then
  echo "# all cases passed"
else
  echo "# $failures case(s) failed"
fi
exit "$failures"
