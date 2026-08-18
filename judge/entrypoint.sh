#!/bin/bash
# The judge and judge-agent must see the same filesystem (the agent
# materialises packages under PROBLEMS_DIR, which the judge watches) — so
# per task-13-brief.md's Controller addendum C2, judge-agent runs as a
# second process supervised inside THIS container, not as a separate
# container sharing a volume.
#
# Sequence: render judge.yml's template from this container's own
# JUDGE_NAME/JUDGE_TOKEN, start judge-agent in the background, wait for its
# /healthz, then start the judge itself (the dmoj invocation Compose's
# `command:` supplies as "$@") as a second background job. From then on both
# processes are supervised: `wait -n` returns as soon as either one exits, and
# this script exits with that same code — no `exec` here, on purpose, because
# `exec`ing the judge at the end would leave the backgrounded agent
# unsupervised: if it died later the judge container would keep running with
# a permanently dead agent (every package fetch failing) until a human
# noticed. Exiting non-zero instead lets Compose's `restart: unless-stopped`
# — which acts on exit code, not container health alone — restart the whole
# container.
#
# tini (this image's ENTRYPOINT, wrapping this script) remains pid 1 and
# reaps both children regardless: whether they're orphaned by this script
# exiting, or explicitly waited on below.
#
# Because this script no longer ends in `exec`, it stays alive as tini's
# direct child instead of being replaced by the judge process. tini only
# forwards a received signal to that one direct child, not to grandchildren
# — so a `SIGTERM` (e.g. from `podman stop`) has to be caught here and
# forwarded explicitly, or it would hit bash's default disposition (which is
# to terminate immediately) and leave the judge and agent running,
# orphaned, until the stop timeout forces a SIGKILL. The trap below forwards
# it to both children and waits for them before this script itself exits.
set -eu

node /app/render-config.mjs

node /app/apps/judge-agent/dist/main.js &
agent_pid=$!

node /app/wait-healthy.mjs

"$@" &
judge_pid=$!

term() {
  kill -TERM "$judge_pid" "$agent_pid" 2>/dev/null || true
}
trap term TERM INT

code=0
wait -n "$agent_pid" "$judge_pid" || code=$?

term
wait "$agent_pid" "$judge_pid" 2>/dev/null || true

exit "$code"
