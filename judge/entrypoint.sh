#!/bin/sh
# The judge and judge-agent must see the same filesystem (the agent
# materialises packages under PROBLEMS_DIR, which the judge watches) — so
# per task-13-brief.md's Controller addendum C2, judge-agent runs as a
# second process supervised inside THIS container, not as a separate
# container sharing a volume.
#
# Sequence: render judge.yml's template from this container's own
# JUDGE_NAME/JUDGE_TOKEN, start judge-agent in the background, wait for its
# /healthz, then exec the judge itself (the dmoj invocation Compose's
# `command:` supplies as "$@"). tini (this image's ENTRYPOINT, wrapping this
# script) reaps both the backgrounded agent and whatever `exec` replaces
# this shell with — no separate init system needed.
set -eu

node /app/render-config.mjs

node /app/apps/judge-agent/dist/main.js &

node /app/wait-healthy.mjs

exec "$@"
